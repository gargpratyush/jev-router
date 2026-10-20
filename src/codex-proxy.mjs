import http from "node:http";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { availableTiers, shouldUseExactModel, THRESHOLDS } from "./config.mjs";
import { askJev } from "./router.mjs";
import { codexRoutingContext } from "./codex-context.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { readStatus, writeDecision, writeStatus, writeUsage } from "./status.mjs";
import { aggregateUsage, formatUsage, formatUsageReport, usageFromResponse } from "./usage.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";
export const CODEX_MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const OPENAI_MODEL_CATALOG_URL = "https://developers.openai.com/api/docs/models/all";
export const OPENAI_MODEL_CACHE_FILE = join(homedir(), ".jev-router", "openai-model-allowlist.json");
const MODEL_CACHE_VERSION = 1;
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
const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const FALLBACK_MODEL_METADATA = {
  "gpt-6-luna": {
    display_name: "GPT-6 Luna",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supported_reasoning_levels: ["none", "low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
    cost: { currency: "USD", unit: "million_tokens", input: 0.1, output: 0.5 },
  },
  "gpt-6-sol": {
    display_name: "GPT-6 Sol",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
    cost: { currency: "USD", unit: "million_tokens", input: 2, output: 10 },
  },
  "gpt-6-astra": {
    display_name: "GPT-6 Astra",
    context_window: 1_050_000,
    max_output_tokens: 128_000,
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
    cost: { currency: "USD", unit: "million_tokens", input: 10, output: 50 },
  },
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

export function codexTierOf(model) {
  if (/(?:audio|chat|cyber|image|live|realtime|search|transcri|tts|whisper)/i.test(model ?? "")) return null;
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

const decodeHtml = (value) => value
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const textFromHtml = (html) => decodeHtml(String(html ?? ""))
  .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const tokenCount = (value) => {
  const match = /^([\d,.]+)\s*([KMB])?$/i.exec(String(value ?? "").trim());
  if (!match) return undefined;
  return Number(match[1].replace(/,/g, "")) * ({ K: 1e3, M: 1e6, B: 1e9 }[match[2]?.toUpperCase()] ?? 1);
};

const dollars = (value) => value == null ? undefined : Number(String(value).replace(/,/g, ""));

/** Model links and lifecycle state published in OpenAI's complete model catalog. */
export function parseOpenAIModelIndex(html) {
  const found = new Map();
  const links = /<a\b[^>]*href=["']\/api\/docs\/models\/([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = links.exec(String(html ?? "")))) {
    const id = decodeURIComponent(match[1]);
    if (!/^gpt-/i.test(id) || !codexTierOf(id)) continue;
    const deprecated = /\bDeprecated\b/i.test(textFromHtml(match[2]));
    found.set(id, { id, deprecated: Boolean(found.get(id)?.deprecated || deprecated) });
  }
  return [...found.values()];
}

/** Cost and capability metadata from one official OpenAI model page. */
export function parseOpenAIModelPage(id, html, sourceURL) {
  const raw = String(html ?? "");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(raw)?.[1] ?? raw;
  const text = textFromHtml(main);
  const reasoningText = /reasoning\.effort supports ([^.]+)\./i.exec(text)?.[1] ?? "";
  const reasoningEfforts = REASONING_EFFORTS.filter((effort) =>
    new RegExp(`\\b${effort}\\b`, "i").test(reasoningText),
  );
  const defaultReasoning = REASONING_EFFORTS.find((effort) =>
    new RegExp(`\\b${effort}\\s*\\(default\\)`, "i").test(reasoningText),
  );
  const pricing = /Text tokens Per 1M tokens Input \$([\d,.]+)(?: Cached input \$([\d,.]+))?(?: Cache writes \$([\d,.]+))? Output \$([\d,.]+)/i.exec(text);
  const section = (start, end) => {
    const from = text.lastIndexOf(start);
    const to = from < 0 ? -1 : text.indexOf(end, from + start.length);
    return from < 0 || to < 0 ? "" : text.slice(from + start.length, to);
  };
  const modalities = section("Modalities ", " Endpoints ");
  const features = section("Features ", " Tools ");
  const tools = section("Tools supported by this model when using the Responses API. ", " Snapshots");
  const supported = (block, names) => names.filter((name) =>
    new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} Supported`, "i").test(block),
  );
  const metaDescription = /<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(raw)?.[1];
  return {
    slug: id,
    display_name: textFromHtml(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(main)?.[1]) || id,
    description: metaDescription ? decodeHtml(metaDescription) : undefined,
    context_window: tokenCount(/([\d,.]+\s*[KMB]?) context window/i.exec(text)?.[1]),
    max_output_tokens: tokenCount(/([\d,.]+\s*[KMB]?) max output tokens/i.exec(text)?.[1]),
    supported_reasoning_levels: reasoningEfforts.map((effort) => ({ effort })),
    default_reasoning_level: defaultReasoning,
    cost: pricing ? {
      currency: "USD",
      unit: "million_tokens",
      input: dollars(pricing[1]),
      cached_input: dollars(pricing[2]),
      cache_write: dollars(pricing[3]),
      output: dollars(pricing[4]),
    } : undefined,
    capabilities: {
      modalities: {
        input: ["Text", "Image", "Audio", "Video"].filter((name) =>
          new RegExp(`${name} (?:Input and output|Input only)`, "i").test(modalities),
        ),
        output: ["Text", "Image", "Audio", "Video"].filter((name) =>
          new RegExp(`${name} (?:Input and output|Output only)`, "i").test(modalities),
        ),
      },
      features: supported(features, ["Streaming", "Function calling", "Structured outputs", "Fine-tuning"]),
      tools: supported(tools, ["Web search", "File search", "Image generation", "Code interpreter", "Hosted shell", "Apply patch", "Skills", "Computer use", "MCP", "Tool search"]),
    },
    source_url: sourceURL,
  };
}

export async function fetchPublishedOpenAIModels({
  fetchImpl = fetch,
  catalogURL = OPENAI_MODEL_CATALOG_URL,
  previous = [],
} = {}) {
  const response = await fetchImpl(catalogURL);
  if (!response.ok) throw new Error(`OpenAI model catalog returned HTTP ${response.status}`);
  const index = parseOpenAIModelIndex(await response.text()).filter((model) => !model.deprecated);
  const previousById = new Map(previous.map((model) => [model.slug, model]));
  const results = await Promise.allSettled(index.map(async ({ id }) => {
    const url = new URL(`/api/docs/models/${encodeURIComponent(id)}`, catalogURL).href;
    const page = await fetchImpl(url);
    if (!page.ok) throw new Error(`OpenAI model page for ${id} returned HTTP ${page.status}`);
    return parseOpenAIModelPage(id, await page.text(), url);
  }));
  const models = results.flatMap((result, indexPosition) => {
    if (result.status === "fulfilled") return [result.value];
    const prior = previousById.get(index[indexPosition].id);
    return prior ? [prior] : [];
  });
  const routable = models.filter((model) =>
    model.capabilities.modalities.input.includes("Text") &&
    model.capabilities.modalities.output.includes("Text") &&
    model.capabilities.features.includes("Function calling") &&
    model.capabilities.tools.length &&
    model.cost?.input != null &&
    model.cost?.output != null,
  );
  if (!routable.length) throw new Error("OpenAI model catalog contained no routable models");
  return routable;
}

const normalizeAvailableModels = (catalog) => {
  const entries = Array.isArray(catalog?.models) ? catalog.models : catalog?.data;
  if (!Array.isArray(entries)) throw new Error("OpenAI account model catalog was malformed");
  return new Map(entries.flatMap((model) => {
    const id = model?.slug ?? model?.id;
    const retired = model?.supported_in_api === false ||
      (model?.shutdown_date && Date.parse(model.shutdown_date) <= Date.now());
    return id && !retired ? [[id, { ...model, slug: id }]] : [];
  }));
};

export function readOpenAIModelCache(file = OPENAI_MODEL_CACHE_FILE) {
  if (!file) return null;
  try {
    const cache = JSON.parse(readFileSync(file, "utf8"));
    if (cache?.version !== MODEL_CACHE_VERSION || !Array.isArray(cache.models)) return null;
    return cache;
  } catch {
    return null;
  }
}

export function writeOpenAIModelCache(cache, file = OPENAI_MODEL_CACHE_FILE) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(cache, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
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
        ...(model.max_output_tokens != null ? { maxOutputTokens: model.max_output_tokens } : {}),
        ...model.capabilities,
      },
      cost: model.cost,
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
        model.supported_reasoning_levels?.length &&
          `reasoning: ${model.supported_reasoning_levels.map((level) => level.effort).filter(Boolean).join(", ")}`,
        model.cost?.input != null && model.cost?.output != null &&
          `cost per 1M tokens: $${model.cost.input} input, $${model.cost.output} output`,
      ].filter(Boolean).join("; "),
    }))
    .filter((model) => model.tier);
  return available.length
    ? available
    : Object.keys(DEFAULT_MODELS).map((tier) => {
        const id = codexModelOf(tier);
        const metadata = FALLBACK_MODEL_METADATA[id] ?? {};
        return {
          id,
          tier,
          capabilities: {
            reasoningEfforts: metadata.supported_reasoning_levels?.map((level) => level.effort),
            defaultReasoningEffort: metadata.default_reasoning_level,
            contextWindow: metadata.context_window,
            ...(metadata.max_output_tokens != null ? { maxOutputTokens: metadata.max_output_tokens } : {}),
          },
          cost: metadata.cost,
          description: [
            metadata.display_name ?? id,
            metadata.context_window && `${metadata.context_window} context tokens`,
            metadata.supported_reasoning_levels?.length &&
              `reasoning: ${metadata.supported_reasoning_levels.map((level) => level.effort).join(", ")}`,
            metadata.cost && `cost per 1M tokens: $${metadata.cost.input} input, $${metadata.cost.output} output`,
          ].filter(Boolean).join("; "),
        };
      });
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

/** Map Jev's normalized reasoning requirement to an effort supported by the routed model. */
export function selectCodexReasoningEffort({
  reasoningRequired,
  supported = [],
  defaultEffort,
  requested,
} = {}) {
  const known = [...new Set(supported)].filter((effort) => REASONING_EFFORTS.includes(effort));
  if (!Number.isFinite(reasoningRequired)) {
    if (!known.length || known.includes(requested)) return requested;
    return known.includes(defaultEffort) ? defaultEffort : known[0];
  }
  const target = reasoningRequired < 0.25
    ? "low"
    : reasoningRequired < 0.6
      ? "medium"
      : reasoningRequired < 0.85
        ? "high"
        : "xhigh";
  if (!known.length) return requested ?? defaultEffort ?? target;
  const targetRank = REASONING_EFFORTS.indexOf(target);
  return known
    .map((effort) => ({ effort, rank: REASONING_EFFORTS.indexOf(effort) }))
    .filter(({ rank }) => rank >= targetRank)
    .sort((a, b) => a.rank - b.rank)[0]?.effort
    ?? known.sort((a, b) => REASONING_EFFORTS.indexOf(b) - REASONING_EFFORTS.indexOf(a))[0];
}

export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier), effort) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (effort) {
    body.reasoning ??= {};
    body.reasoning.effort = effort;
  } else if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

export function jevDecisionEvents({ tier, model = codexModelOf(tier), effort, confidence, reason, warning, context }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const decision = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
  const details = [decision, ...(effort ? [`Effort: ${effort}`] : [])];
  if (context?.truncated) details.push(`[Jev] routing context shortened to ${context.includedChars} of ${context.originalChars} characters; OpenAI context is unchanged.`);
  if (warning) details.push(`[Jev] warning: could not refresh the Codex model catalog: ${warning}`);
  const text = details.join("\n");
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
  Number.isFinite(fetchedAt) && now >= fetchedAt && now - fetchedAt < CODEX_MODEL_CATALOG_MAX_AGE_MS;

/**
 * Refreshes the routable allowlist from OpenAI's published catalog, intersected with the
 * models currently available to this account. The result is persisted for cold starts.
 */
export async function refreshCodexModels({
  models,
  availableModels,
  headers = {},
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  catalogURL = OPENAI_MODEL_CATALOG_URL,
  cacheFile = OPENAI_MODEL_CACHE_FILE,
  fetchImpl = fetch,
} = {}) {
  let available = availableModels;
  if (!(available instanceof Map)) {
    const base = upstreamFor(headers, "/models", chatgptBaseURL, apiBaseURL);
    const url = `${base.replace(/\/$/, "")}/models?client_version=1`;
    const response = await fetchImpl(url, {
      headers: Object.fromEntries(
        Object.entries(headers).filter(([name]) => !["host", "content-length"].includes(name.toLowerCase())),
      ),
    });
    if (!response.ok) throw new Error(`OpenAI account model catalog returned HTTP ${response.status}`);
    available = normalizeAvailableModels(await response.json());
  }
  const published = await fetchPublishedOpenAIModels({
    fetchImpl,
    catalogURL,
    previous: [...models.values()],
  });
  const next = new Map();
  for (const metadata of published) {
    const account = available.get(metadata.slug);
    if (!account) continue;
    next.set(metadata.slug, {
      ...account,
      ...metadata,
      slug: metadata.slug,
      supported_in_api: true,
      supported_reasoning_levels: metadata.supported_reasoning_levels?.length
        ? metadata.supported_reasoning_levels
        : account.supported_reasoning_levels,
      default_reasoning_level: metadata.default_reasoning_level ?? account.default_reasoning_level,
      context_window: metadata.context_window ?? account.context_window,
    });
  }
  if (!next.size) throw new Error("No published routing models are available to this account");
  const fetchedAt = Date.now();
  writeOpenAIModelCache({ version: MODEL_CACHE_VERSION, fetchedAt, models: [...next.values()] }, cacheFile);
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
  ...(turn.effort ? [`Effort: ${turn.effort}`] : []),
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
  catalogURL = OPENAI_MODEL_CATALOG_URL,
  modelCacheFile = OPENAI_MODEL_CACHE_FILE,
  fetchImpl = fetch,
  route = askJev,
  statusId = "",
} = {}) {
  const states = new Map();
  const usageTurns = new Map();
  const cachedCatalog = readOpenAIModelCache(modelCacheFile);
  const models = new Map((cachedCatalog?.models ?? []).map((model) => [model.slug, model]));
  const accountModels = new Map();
  let modelCatalogFetchedAt = cachedCatalog?.fetchedAt ?? 0;
  let modelCatalogRefresh;

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
                modelCatalogRefresh ??= refreshCodexModels({
                  models,
                    availableModels: accountModels.size ? accountModels : undefined,
                    headers: req.headers,
                    chatgptBaseURL,
                    apiBaseURL,
                    catalogURL,
                    cacheFile: modelCacheFile,
                    fetchImpl,
                  })
                  .finally(() => { modelCatalogRefresh = null; });
                await modelCatalogRefresh;
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
            const currentEffort = states.get(key)?.effort;
            const current = codexTierOf(currentModel) ?? "opus";
            const prompt = codexNewTurnPrompt(body);
            const explaining = prompt?.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt ?? "");
            isUsageCommand = /^\$jev-usage\b/i.test(prompt ?? "");
            let tier = current;
            let model = currentModel;
            let effort = currentEffort;
            if (prompt && !explaining && !isUsageCommand) {
              const context = codexRoutingContext(body);
              const contextTokens = Math.round((JSON.stringify(body.input).length + (body.instructions?.length ?? 0)) / 4);
              const jev = await route({ prompt, current: currentModel, currentEffort, contextTokens, models: candidates, context, selectReasoning: true });
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
              const modelInfo = models.get(model);
              const confident = jev?.confidence >= THRESHOLDS.minConfidence;
              const recommendedEffort = confident && shouldUseExactModel(decision.reason, chosen?.tier, tier) && model === jev?.choice &&
                modelInfo?.supported_reasoning_levels?.some((level) => level.effort === jev.effort)
                ? jev.effort : undefined;
              effort = recommendedEffort ?? selectCodexReasoningEffort({
                reasoningRequired: confident ? jev?.metrics?.reasoningRequired : undefined,
                supported: modelInfo?.supported_reasoning_levels?.map((level) => level.effort),
                defaultEffort: modelInfo?.default_reasoning_level,
                requested: model === currentModel ? currentEffort ?? body.reasoning?.effort : body.reasoning?.effort,
              });
              states.set(key, { tier, model, effort });
              routing = {
                prompt,
                tier,
                model,
                effort,
                confidence: jev?.confidence ?? null,
                metrics: jev?.metrics ?? null,
                reason: decision.reason,
                warning: catalogRefreshError,
                context: { originalChars: context.original_chars, includedChars: context.included_chars, truncated: context.truncated },
                jev: jev ? { request: jev.request, response: jev.response } : null,
                at: Date.now(),
              };
              writeDecision(statusId, routing);
              debug(`${key} ${current} -> ${tier} (${decision.reason}) | ${prompt.slice(0, 60)}`);
            }
            applyCodexTier(body, tier, models, model, effort);
            const existingTurn = usageTurns.get(key);
            if (prompt && !explaining && !isUsageCommand) {
              // A fresh prompt normally begins a logical turn. A retransmission while its
              // prior response is still open is a retry and belongs to that same turn.
              usageTurn = existingTurn?.open && existingTurn.prompt === prompt
                ? existingTurn
                : { id: `turn-${randomUUID()}`, prompt, model: body.model, effort: body.reasoning?.effort, at: Date.now(), open: true, requests: [] };
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
                const rawCatalog = JSON.parse(data.toString());
                const available = normalizeAvailableModels(rawCatalog);
                accountModels.clear();
                for (const [id, model] of available) accountModels.set(id, model);
                const catalog = addJevModel(rawCatalog);
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
