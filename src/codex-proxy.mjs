import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { readStatus, writeDecision, writeStatus, writeUsage } from "./status.mjs";
import { aggregateUsage, formatUsage, formatUsageReport, usageFromResponse } from "./usage.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
export const CODEX_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MODELS = {
  haiku: "gpt-6-luna",
  opus: "gpt-6-sol",
  fable: "gpt-6-astra",
};
const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  const configured = Object.keys(MODEL_ENV).find((tier) => {
    const id = process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];
    return typeof id === "string" && id === model;
  });
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/** Exact GPT models in Codex's account catalog; configured ids are the cold-start fallback. */
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false)
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
      capabilities: {
        reasoningEfforts: model.supported_reasoning_levels
          ?.map((level) => level.effort)
          .filter(Boolean),
        defaultReasoningEffort: model.default_reasoning_level,
        contextWindow: model.context_window,
      },
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
        model.supported_reasoning_levels?.length &&
          `reasoning: ${model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean).join(", ")}`,
      ].filter(Boolean).join("; "),
    }))
    .filter((model) => model.tier);
  return available.length
    ? available
    : Object.keys(DEFAULT_MODELS).map((tier) => ({
        id: codexModelOf(tier),
        tier,
        description: codexModelOf(tier),
      }));
}

const modelForTier = (models, tier) =>
  models.find((model) => model.tier === tier)?.id ?? codexModelOf(tier);

const textOf = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
};

const cleanPrompt = (text) =>
  text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/** User text that starts a new Codex turn, or null for tool continuations. */
export function codexNewTurnPrompt(body) {
  if (!Array.isArray(body?.input)) return null;
  if (!body.input.some((item) => item?.type === "additional_tools")) return null;
  for (const item of [...body.input].reverse()) {
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") return null;
    if (item?.role !== "user") continue;
    const prompt = cleanPrompt(textOf(item.content));
    if (prompt && !isCodexAuxiliaryPrompt(prompt)) return prompt;
  }
  return null;
}

export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("opus")) ??
    catalog.models.find((model) => model.visibility === "list") ??
    catalog.models[0];
  if (!template) return catalog;
  catalog.models.unshift({
    ...template,
    slug: CODEX_AUTO_MODEL,
    display_name: "Jev Router",
    description: "Jev picks the cheapest model that can complete each turn.",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    upgrade: null,
  });
  return catalog;
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason, warning }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const decision = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const text = warning
    ? `${decision}\n[Jev] warning: could not refresh the Codex model catalog: ${warning}`
    : decision;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  const events = [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export const isCodexModelCatalogFresh = (fetchedAt, now = Date.now()) =>
  Number.isFinite(fetchedAt) && now - fetchedAt < CODEX_MODEL_CATALOG_MAX_AGE_MS;

/** Fetches the account's current Codex catalog, preserving capability metadata for routing. */
export async function refreshCodexModels({
  models,
  headers = {},
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
} = {}) {
  const base = upstreamFor(headers, "/models", chatgptBaseURL, apiBaseURL);
  const url = `${base.replace(/\/$/, "")}/models?client_version=1`;
  const response = await fetch(url, {
    headers: Object.fromEntries(
      Object.entries(headers).filter(([name]) => !["host", "content-length"].includes(name.toLowerCase())),
    ),
  });
  if (!response.ok) throw new Error(`Codex model catalog returned HTTP ${response.status}`);
  const catalog = await response.json();
  if (!Array.isArray(catalog?.models)) throw new Error("Codex model catalog was malformed");
  const next = new Map();
  for (const model of catalog.models) {
    if (model?.slug) next.set(model.slug, model);
  }
  if (!next.size) throw new Error("Codex model catalog was empty");
  models.clear();
  for (const [id, model] of next) models.set(id, model);
  return next;
}

export function jevUsageEvents(text) {
  const id = `jev-usage-${randomUUID()}`;
  const item = {
    type: "message",
    role: "assistant",
    id,
    phase: "commentary",
    content: [{ type: "output_text", text }],
  };
  return [
    { type: "response.output_item.added", item: { ...item, content: [] } },
    { type: "response.output_text.delta", item_id: id, delta: text },
    { type: "response.output_item.done", item },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const sseEvent = (frame) => {
  const fields = frame.replace(/\r/g, "").split("\n");
  const event = fields.find((line) => line.startsWith("event:"))?.slice(6).trim();
  const data = fields.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!event || !data) return null;
  try { return { event, payload: JSON.parse(data) }; } catch { return null; }
};

const completedResponse = (frame) => {
  const parsed = sseEvent(frame);
  if (!parsed || !/^response\.(?:completed|failed)$/.test(parsed.event)) return null;
  return { completed: parsed.event === "response.completed", usage: usageFromResponse(parsed.payload) };
};

const usageText = (turn) => [
  formatUsage(turn.aggregate),
  `Model: ${turn.model ?? "unavailable"}`,
  ...(turn.requests.length > 1 ? [`Requests: ${turn.requests.length}`] : []),
].join("\n");

const usageCommandEvents = (text) => {
  const response = { id: `jev-usage-${randomUUID()}`, status: "completed" };
  return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response })}\n\n` +
    jevUsageEvents(text) +
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`;
};

const debug = (line) => process.env.JEV_DEBUG && log(line);
const upstreamPath = (base, path) => `${new URL(base).pathname.replace(/\/$/, "")}${path}`;

export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route = askJev,
  statusId = "",
} = {}) {
  const states = new Map();
  const usageTurns = new Map();
  const models = new Map();
  let modelCatalogFetchedAt = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing;
      let usageTurn;
      let isUsageCommand = false;
      if (req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          if (body.model === CODEX_AUTO_MODEL) {
            let catalogRefreshError;
            if (!isCodexModelCatalogFresh(modelCatalogFetchedAt)) {
              try {
                await refreshCodexModels({ models, headers: req.headers, chatgptBaseURL, apiBaseURL });
                modelCatalogFetchedAt = Date.now();
                debug(`refreshed Codex model catalog (${models.size} models)`);
              } catch (err) {
                catalogRefreshError = err.message;
                debug(`could not refresh Codex model catalog: ${err.message}`);
              }
            }
            const key = codexConversationKey(body);
            const candidates = codexModels(models).filter((model) =>
              availableTiers().includes(model.tier),
            );
            const available = [...new Set(candidates.map((model) => model.tier))];
            const currentModel = states.get(key)?.model ?? modelForTier(candidates, "opus");
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            isUsageCommand = /^\$jev-usage\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            if (prompt && !explaining && !isUsageCommand) {
              const contextTokens = Math.round(JSON.stringify(body.input).length / 4);
              const jev = await route({ prompt, current: currentModel, contextTokens, models: candidates });
              const chosen = candidates.find((candidate) => candidate.id === jev?.choice);
              const decision = decide({
                prompt,
                jev: jev && { ...jev, choice: chosen?.tier },
                current,
                available,
                contextTokens,
              });
              tier = decision.tier;
              model =
                shouldUseExactModel(decision.reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(candidates, tier);
              states.set(key, { tier, model });
              routing = {
                prompt,
                tier,
                model,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                warning: catalogRefreshError,
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            applyCodexTier(body, tier, models, model);
            const existingTurn = usageTurns.get(key);
            if (prompt && !explaining && !isUsageCommand) {
              // A fresh prompt normally begins a logical turn. A retransmission while its
              // prior response is still open is a retry and belongs to that same turn.
              usageTurn = existingTurn?.open && existingTurn.prompt === prompt
                ? existingTurn
                : { id: `turn-${randomUUID()}`, prompt, model: body.model, at: Date.now(), open: true, requests: [] };
              usageTurns.set(key, usageTurn);
            } else {
              usageTurn = existingTurn;
            }
          } else {
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            isUsageCommand = /^\$jev-usage\b/i.test(prompt ?? "");
            if (prompt && !explaining && !isUsageCommand) writeStatus(statusId, { manual: true, at: Date.now() });
            const key = codexConversationKey(body);
            const existingTurn = usageTurns.get(key);
            if (prompt && !explaining && !isUsageCommand) {
              usageTurn = existingTurn?.open && existingTurn.prompt === prompt
                ? existingTurn
                : { id: `turn-${randomUUID()}`, prompt, model: body.model, at: Date.now(), open: true, requests: [] };
              usageTurns.set(key, usageTurn);
            } else {
              usageTurn = existingTurn;
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`codex passthrough, could not process body: ${err.message}`);
        }
      }

      if (isUsageCommand) {
        const turns = readStatus(statusId)?.usage?.turns ?? [];
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(usageCommandEvents(formatUsageReport(turns)));
        return;
      }

      const base = upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL);
      const target = new URL(base);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: upstreamPath(base, req.url ?? "/"),
          method: req.method,
          headers,
        },
        (response) => {
          const responseHeaders = { ...response.headers };
          const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const body = [];
            response.on("data", (chunk) => body.push(chunk));
            response.on("end", () => {
              let data = Buffer.concat(body);
              try {
                const catalog = addJevModel(JSON.parse(data.toString()));
                for (const model of catalog.models) models.set(model.slug, model);
                modelCatalogFetchedAt = Date.now();
                data = Buffer.from(JSON.stringify(catalog));
                delete responseHeaders["content-length"];
              } catch (err) {
                debug(`could not extend Codex model catalog: ${err.message}`);
              }
              res.writeHead(response.statusCode, responseHeaders);
              res.end(data);
            });
            return;
          }

          const inspectResponse = Boolean(routing || usageTurn);
          if (inspectResponse) delete responseHeaders["content-length"];
          res.writeHead(response.statusCode, responseHeaders);
          if (!inspectResponse) {
            response.pipe(res);
            return;
          }
          let pending = "";
          let inspected = false;
          let usageRecorded = false;
          const requestUsage = { id: `request-${randomUUID()}`, at: Date.now(), model: usageTurn?.model, status: response.statusCode };
          const recordUsage = (found, completed = true) => {
            if (!usageTurn || usageRecorded) return;
            usageRecorded = true;
            requestUsage.raw = found?.raw ?? null;
            requestUsage.usage = found?.usage ?? null;
            requestUsage.model = found?.model ?? requestUsage.model;
            usageTurn.requests.push(requestUsage);
            usageTurn.model = requestUsage.model ?? usageTurn.model;
            usageTurn.aggregate = aggregateUsage(usageTurn.requests);
            usageTurn.updatedAt = Date.now();
            // A failed response can be retried by Codex. Keep that logical turn open so
            // the retry's reported usage is aggregated instead of becoming a new turn.
            usageTurn.open = !completed;
            writeUsage(statusId, usageTurn);
          };
          const forwardFrame = (frame, alreadyWritten = false) => {
            if (!alreadyWritten) res.write(frame);
            const event = completedResponse(frame);
            if (event || /event:\s*response\.(?:completed|failed)/.test(frame)) {
              recordUsage(event?.usage, event?.completed);
              if (usageTurn) res.write(jevUsageEvents(usageText(usageTurn)));
            }
          };
          response.on("data", (chunk) => {
            pending += chunk.toString();
            let end;
            while ((end = pending.search(/\r?\n\r?\n/)) >= 0) {
              const frame = pending.slice(0, end + (pending[end] === "\r" ? 4 : 2));
              pending = pending.slice(frame.length);
              if (!inspected) {
                const isSSE = /^(?:event|data):/m.test(frame);
                // Preserve Codex's initial response-created frame before injecting commentary.
                if (isSSE) res.write(frame);
                if (isSSE && routing) res.write(jevDecisionEvents(routing));
                debug(`codex decision display ${isSSE && routing ? "inject" : "skip"}`);
                inspected = true;
                forwardFrame(frame, isSSE);
                continue;
              }
              forwardFrame(frame);
            }
          });
          response.on("end", () => {
            if (pending) forwardFrame(pending);
            if (usageTurn && !usageRecorded) {
              let found;
              try { found = usageFromResponse(JSON.parse(pending)); } catch {}
              recordUsage(found, response.statusCode >= 200 && response.statusCode < 300);
            }
            res.end();
          });
        },
      );
      upstream.on("error", (err) => {
        debug(`codex upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "proxy_error" } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
