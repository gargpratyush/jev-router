import { createHash, randomUUID } from "node:crypto";
import { availableTiers } from "./lib/config.mjs";
import { genericProxy } from "./generic-proxy.mjs";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const API_BASE_URL = "https://api.openai.com/v1";
export const CODEX_AUTO_MODEL = "jev-router";

const DEFAULT_MODELS = {
  haiku: "gpt-5.6-luna",
  sonnet: "gpt-5.6-terra",
  opus: "gpt-5.6-sol",
  fable: "gpt-6-astra",
};

const MODEL_ENV = {
  haiku: "JEV_CODEX_FAST_MODEL",
  sonnet: "JEV_CODEX_BALANCED_MODEL",
  opus: "JEV_CODEX_STRONG_MODEL",
  fable: "JEV_CODEX_LONG_MODEL",
};

export const codexModelOf = (tier) => process.env[MODEL_ENV[tier]] ?? DEFAULT_MODELS[tier];

function codexTierOf(model) {
  const configured = Object.keys(DEFAULT_MODELS).find((tier) => codexModelOf(tier) === model);
  if (configured) return configured;
  if (/(?:astra|fable|long)/i.test(model ?? "")) return "fable";
  if (/(?:sol|opus|strong|max|pro)/i.test(model ?? "")) return "opus";
  if (/(?:luna|haiku|fast|mini|nano)/i.test(model ?? "")) return "haiku";
  return /^gpt-/i.test(model ?? "") ? "sonnet" : null;
}

/**
 * Exact GPT models in Codex's catalog; configured ids are the cold-start fallback.
 */
export function codexModels(models = new Map()) {
  const available = [...models.values()]
    .filter((model) => model.slug !== CODEX_AUTO_MODEL && model.supported_in_api !== false)
    .map((model) => ({
      id: model.slug,
      tier: codexTierOf(model.slug),
      description: [
        model.display_name,
        model.description,
        model.context_window && `${model.context_window} context tokens`,
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

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item?.type === "text" || item?.type === "input_text")
    .map((item) => item.text)
    .join("\n");
}

function cleanPrompt(text) {
  return text
    .replace(/<system[-_]reminder>[\s\S]*?<\/system[-_]reminder>/gi, "")
    .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .trim();
}

export const isCodexAuxiliaryPrompt = (prompt) =>
  /^Generate a concise, single-line task title\b/i.test(prompt);

/**
 * User text that starts a new Codex turn, or null for tool continuations.
 */
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

/**
 * Stable conversation key from prompt_cache_key or first user message.
 */
export function codexConversationKey(body) {
  const stable =
    body?.prompt_cache_key ??
    body?.client_metadata?.["x-codex-turn-metadata"] ??
    `${body?.instructions ?? ""}|${textOf(body?.input?.find((item) => item?.role === "user")?.content)}`;
  return createHash("sha1").update(String(stable)).digest("hex").slice(0, 12);
}

/**
 * Add the Jev Router sentinel model to Codex's model catalog.
 */
export function addJevModel(catalog) {
  if (!Array.isArray(catalog?.models) || catalog.models.some((model) => model.slug === CODEX_AUTO_MODEL)) {
    return catalog;
  }
  const template =
    catalog.models.find((model) => model.slug === codexModelOf("sonnet")) ??
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

/**
 * Apply tier to request, clamping reasoning effort if needed.
 */
export function applyCodexTier(body, tier, models = new Map(), model = codexModelOf(tier)) {
  body.model = model;
  const info = models.get(model);
  const efforts = info?.supported_reasoning_levels?.map((level) => level.effort);
  if (body.reasoning?.effort && efforts?.length && !efforts.includes(body.reasoning.effort)) {
    body.reasoning.effort = info.default_reasoning_level;
  }
  return body;
}

/**
 * Determine upstream URL based on request.
 */
export const upstreamFor = (
  headers,
  path = "",
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
) => /\/models(?:\?|$)/.test(path) || headers["chatgpt-account-id"] ? chatgptBaseURL : apiBaseURL;

/**
 * Format routing decision as SSE events for inline display.
 */
export function jevDecisionEvents({ tier, model = codexModelOf(tier), confidence, reason }) {
  const detail = confidence == null ? reason : `${reason}, confidence ${confidence.toFixed(2)}`;
  const id = `jev-${randomUUID()}`;
  const text = reason.startsWith("jev-unavailable")
    ? `[Jev] unavailable; using ${model}. Add JEV_API_KEY=... to ~/.jev-router.env and restart jev-codex.`
    : `[Jev] routed this turn to ${model} (${detail}).`;
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

/**
 * Adapter for Codex / OpenAI API.
 */
function createCodexAdapter(catalogMap, statusId = "") {
  return {
    contextWindow: 128000, // Codex context window
    statusId,

    isRoutingRequest(req, body) {
      return req.method === "POST" && /\/responses(?:\?|$)/.test(req.url ?? "") && body.model === CODEX_AUTO_MODEL;
    },

    // Only a real user turn reflects the user's choice. Codex's auxiliary calls (titles,
    // summaries), tool continuations and explain turns must not flip the status to manual.
    isManualChoice(req, body) {
      if (req.method !== "POST" || !/\/responses(?:\?|$)/.test(req.url ?? "")) return false;
      if (body.model === CODEX_AUTO_MODEL) return false;
      const prompt = codexNewTurnPrompt(body);
      return !!prompt && !prompt.includes("<jev-explain>") && !/^\$jev-explain\b/i.test(prompt);
    },

    conversationKey(body) {
      return codexConversationKey(body);
    },

    newTurnPrompt(body) {
      return codexNewTurnPrompt(body);
    },

    getModels() {
      return codexModels(catalogMap);
    },

    // The account's own catalog wins, so a fallback never names a model it cannot reach.
    getDefaultModel(tier) {
      return codexModels(catalogMap).find((model) => model.tier === tier)?.id ?? codexModelOf(tier);
    },

    contextTokens(body) {
      return Math.round(JSON.stringify(body.input ?? "").length / 4);
    },


    applyTier(body, tier, model) {
      applyCodexTier(body, tier, catalogMap, model);
    },

    decorateModelCatalog(catalog) {
      addJevModel(catalog);
      // Store models in the map for later use
      for (const model of catalog.models) {
        catalogMap.set(model.slug, model);
      }
    },

    decorateResponse(res, response, routing) {
      const responseHeaders = { ...response.headers };
      delete responseHeaders["content-length"];
      res.writeHead(response.statusCode, responseHeaders);

      let pending = "";
      let inspected = false;
      response.on("data", (chunk) => {
        if (inspected) return void res.write(chunk);
        pending += chunk.toString();
        const end = pending.indexOf("\n\n");
        if (end < 0) return;
        const first = pending.slice(0, end + 2);
        res.write(first);
        const isSSE = /^(?:event|data):/m.test(first);
        if (isSSE) res.write(jevDecisionEvents(routing));
        res.write(pending.slice(end + 2));
        pending = "";
        inspected = true;
      });
      response.on("end", () => {
        if (pending) res.write(pending);
        res.end();
      });
    },
  };
}

/**
 * Start Codex proxy with model catalog collection.
 */
export async function startCodexProxy({
  chatgptBaseURL = CHATGPT_BASE_URL,
  apiBaseURL = API_BASE_URL,
  route,
  statusId = "",
} = {}) {
  const models = new Map();
  const adapter = createCodexAdapter(models, statusId);

  return genericProxy({
    adapter,
    upstreamURL: (req) => upstreamFor(req.headers, req.url, chatgptBaseURL, apiBaseURL),
    route,
    catalog: models,
  });
}
