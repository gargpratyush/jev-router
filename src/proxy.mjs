import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TIERS,
  tierOf,
  idOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
} from "./config.mjs";
import { askJev } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus, isRoutingEnabled, logRouteEvent } from "./status.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls, and those
 * continuations end in a `tool_result` rather than typed text. Routing them would re-ask
 * Jev on every tool call and let the model flip mid-task, so only the opening request of a
 * turn counts. Claude Code also injects `<system-reminder>` blocks into the user message,
 * which are noise to a router and measurably blunt Jev's confidence, so they are removed.
 */
export function newTurnPrompt(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  const messages = body?.messages || [];
  // Skip trailing system or developer messages (Claude Code 2.1+ appends environment blocks)
  let idx = messages.length - 1;
  while (idx >= 0 && (messages[idx].role === "system" || messages[idx].role === "developer")) {
    idx--;
  }
  if (idx < 0) return null;
  const last = messages[idx];
  if (last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * Points a request at a tier, applying model and reasoning effort.
 * Removes fields the target model cannot accept (e.g. Haiku cannot accept thinking or effort).
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier && !model) return body;
  body.model = model || tier?.id;

  if (tier?.thinking) {
    if (!body.thinking) {
      body.thinking = { type: "adaptive" };
    }
  } else if (tier && !tier.thinking) {
    delete body.thinking;
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }

  if (typeof tier?.effort === "string") {
    body.output_config = { ...(body.output_config || {}), effort: tier.effort };
  } else if (!tier?.effort) {
    if (body.output_config) {
      delete body.output_config.effort;
      if (Object.keys(body.output_config).length === 0) delete body.output_config;
    }
  }

  // Haiku 4.5 does not accept mid-conversation role: "system" messages
  if (tierName === "chat" || tierName === "haiku" || (tier && !tier.thinking)) {
    if (Array.isArray(body.messages)) {
      const merged = [];
      for (const msg of body.messages) {
        if (msg.role === "system") {
          const sysText =
            typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content.map((b) => b.text || "").join("\n")
                : "";
          const reminderBlock = { type: "text", text: `<system-reminder>\n${sysText}\n</system-reminder>` };
          if (merged.length > 0 && merged[merged.length - 1].role === "user") {
            const prev = merged[merged.length - 1];
            if (typeof prev.content === "string") {
              prev.content = [{ type: "text", text: prev.content }, reminderBlock];
            } else if (Array.isArray(prev.content)) {
              prev.content.push(reminderBlock);
            }
          } else {
            merged.push({ role: "user", content: [reminderBlock] });
          }
        } else {
          merged.push(msg);
        }
      }
      body.messages = merged;
    }
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : [
        { id: "claude-haiku-4-5-20251001", tier: "haiku", description: "Claude Haiku 4.5" },
        { id: "claude-sonnet-5", tier: "sonnet", description: "Claude Sonnet 5" },
        { id: "claude-opus-5", tier: "opus", description: "Claude Opus 5" },
        { id: "claude-fable-5-1", tier: "fable", description: "Claude Fable 5.1" },
      ];
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}

export async function startProxy({ upstreamURL = ANTHROPIC_BASE_URL, route = askJev } = {}) {
  const convos = new Map();
  const catalog = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const reqStartTime = Date.now();
      let routeEventData = null;
      let out = Buffer.concat(chunks);
      let parsedBody = null;
      let conversationState = null;
      let currentKey = null;
      let turnSessionId = "";

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          parsedBody = body;
          turnSessionId = sessionOf(body);
          if (process.env.JEV_DUMP) {
            writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          if (!isRoutingEnabled()) {
            debug(`passthrough, routing disabled by switch`);
            const p = newTurnPrompt(body);
            routeEventData = {
              path: req.url,
              mode: "passthrough",
              reason: "routing disabled via dashboard switch",
              model: body.model,
              requestedModel: body.model,
              prompt: p || "",
            };
          } else if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            const p = newTurnPrompt(body);
            routeEventData = {
              path: req.url,
              mode: "passthrough",
              reason: "user selected model",
              model: body.model,
              requestedModel: body.model,
              prompt: p || "",
            };
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
          } else {
            const key = conversationKey(body);
            currentKey = key;
            const state = stateFor(key);
            conversationState = state;
            const current = state.tier ?? "medium";
            const prompt = newTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>");
            let fresh = null;

            // Extract tools offered in this request
            const toolsOffered = Array.isArray(body.tools) ? body.tools.map((t) => t.name).filter(Boolean) : [];
            state.toolsOffered = toolsOffered;

            // Extract tools used across messages in the conversation
            const toolsUsedInHistory = [];
            for (const msg of body.messages || []) {
              if (msg.role === "assistant" && Array.isArray(msg.content)) {
                for (const b of msg.content) {
                  if (b.type === "tool_use" && b.name && !toolsUsedInHistory.includes(b.name)) {
                    toolsUsedInHistory.push(b.name);
                  }
                }
              }
            }

            if (prompt && !explaining) {
              const models = claudeModels([...catalog.values()]);
              const available = availableTiers();
              const currentModel = state.model ?? idOf(current);
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              const jev = await route({ prompt, current: currentModel, contextTokens, models });
              const chosen = models.find((model) => model.id === jev?.choice);
              const tierAnswer = jev && { ...jev, choice: chosen?.tier ?? jev.choice };
              const { tier, reason } = decide({
                prompt,
                jev: tierAnswer,
                current,
                available,
                contextTokens,
              });
              const spec = tierSpec(tier);
              const model =
                shouldUseExactModel(reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : (spec?.id ?? idOf(tier));
              state.tier = tier;
              state.model = model;
              state.effort = spec?.effort ?? null;
              fresh = {
                prompt,
                tier,
                model,
                effort: spec?.effort ?? null,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason,
                toolsOffered,
                toolsUsed: [...toolsUsedInHistory],
                jev: jev ? { request: jev.request, response: jev.response } : null,
              };
              state.currentTurn = fresh;
              debug(
                `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                  `${current} -> ${tier} [${spec?.effort ?? "none"}] (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
              );
            } else if (state.currentTurn) {
              for (const t of toolsUsedInHistory) {
                if (!state.currentTurn.toolsUsed.includes(t)) {
                  state.currentTurn.toolsUsed.push(t);
                }
              }
            }
            const tier = state.tier ?? current;
            const spec = tierSpec(tier);
            const model = state.model ?? spec?.id ?? idOf(tier);
            debug(`${key} rewrite ${body.model} -> ${model} [${spec?.effort ?? "none"}]`);
            applyTier(body, tier, model);

            routeEventData = {
              path: req.url,
              mode: "routed",
              tier,
              model,
              requestedModel: body.model,
              effort: spec?.effort ?? null,
              confidence: state.currentTurn?.confidence ?? null,
              metrics: state.currentTurn?.metrics ?? null,
              reason: state.currentTurn?.reason || "jev",
              prompt: prompt || state.currentTurn?.prompt || "",
              tools: toolsOffered.length,
              toolsUsed: [...(state.currentTurn?.toolsUsed || toolsUsedInHistory)],
              jev: state.currentTurn?.jev
                ? {
                    choice: model,
                    confidence: state.currentTurn.confidence ?? 0.85,
                    latencyMs: 15,
                  }
                : null,
            };

            if (fresh && !explaining) {
              writeDecision(turnSessionId || key, { tier, model, effort: spec?.effort ?? null, ...fresh, at: Date.now() });
            } else if (state.currentTurn && !explaining) {
              writeDecision(turnSessionId || key, { tier: state.tier ?? current, model: state.model ?? model, effort: spec?.effort ?? null, ...state.currentTurn, at: Date.now() });
            }
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      if (process.env.JEV_DEBUG || conversationState?.currentTurn) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          const usage = { input: 0, output: 0, cached: 0, cacheWrite: 0, reasoning: 0 };
          let seen = false;

          up.on("data", (c) => {
            const chunkStr = c.toString("utf8");

            // Extract usage tokens from SSE or JSON chunks
            const inMatch = /"input_tokens"\s*:\s*(\d+)/.exec(chunkStr);
            if (inMatch) usage.input = parseInt(inMatch[1], 10);
            const outMatch = /"output_tokens"\s*:\s*(\d+)/.exec(chunkStr);
            if (outMatch) usage.output = parseInt(outMatch[1], 10);
            const readMatch = /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(chunkStr);
            if (readMatch) usage.cached = parseInt(readMatch[1], 10);
            const writeMatch = /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(chunkStr);
            if (writeMatch) usage.cacheWrite = parseInt(writeMatch[1], 10);

            if (!seen) {
              const m = /"model"\s*:\s*"([^"]+)"/.exec(chunkStr);
              if (m) {
                seen = true;
                debug(`${up.statusCode} served by ${m[1]}`);
                if (conversationState?.currentTurn) {
                  conversationState.currentTurn.servedModel = m[1];
                }
                if (routeEventData) {
                  routeEventData.servedModel = m[1];
                }
              }
            }
            if (conversationState?.currentTurn && conversationState.toolsOffered?.length) {
              for (const toolName of conversationState.toolsOffered) {
                if (chunkStr.includes(`"name":"${toolName}"`) || chunkStr.includes(`"name": "${toolName}"`)) {
                  if (!conversationState.currentTurn.toolsUsed.includes(toolName)) {
                    conversationState.currentTurn.toolsUsed.push(toolName);
                    writeDecision(turnSessionId || currentKey, {
                      tier: conversationState.tier,
                      ...conversationState.currentTurn,
                      at: Date.now(),
                    });
                  }
                }
              }
            }
          });

          up.on("end", () => {
            const durationMs = Date.now() - reqStartTime;
            if (routeEventData) {
              logRouteEvent({
                ...routeEventData,
                status: up.statusCode,
                durationMs,
                usage,
                toolsUsed: conversationState?.currentTurn?.toolsUsed || routeEventData.toolsUsed || [],
              });
            }
          });

          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
