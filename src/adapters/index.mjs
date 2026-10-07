export { genericProxy } from "../generic-proxy.mjs";
export { AUTO_MODEL, TIER_NAMES, isAuto } from "../lib/config.mjs";
// The native integration pattern: a harness that owns its own model calls wants the
// per-turn decision without an HTTP hop. The exports map blocks deep imports, so this
// re-export is the only way a consumer of the package can reach it. See docs/adapters.md.
export { routeTurn } from "../lib/route-turn.mjs";
// A harness that must not share the default status directory passes its own store to
// routeTurn or genericProxy, and reads its records back from the same store.
export { createStatusStore, readStatus } from "../lib/status.mjs";

/**
 * @typedef {"haiku" | "sonnet" | "opus" | "fable"} AdapterTier
 */

/**
 * @typedef {object} AdapterModel
 * @property {string} id Exact upstream model identifier.
 * @property {AdapterTier} tier Shared routing tier for the model.
 * @property {string} [description] Model information shown to the router.
 * @property {number} [maxInputTokens] Input window; models too small for a request are skipped.
 */

/**
 * Harness-specific behavior used by the generic routing proxy.
 *
 * @typedef {object} Adapter
 * @property {(req: import("node:http").IncomingMessage, body: object) => boolean} isRoutingRequest
 * @property {(body: object) => string} conversationKey
 * @property {(body: object) => (string | null)} newTurnPrompt
 * @property {(catalog: Map<string, object>) => AdapterModel[]} getModels
 * @property {(tier: AdapterTier) => string} getDefaultModel
 * @property {(body: object, tier: AdapterTier, model: string) => (void | object)} applyTier
 * @property {(req: import("node:http").IncomingMessage, body: object) => boolean} [isManualChoice]
 * @property {(body: object) => void} [normalizeRequest]
 * @property {(modelCatalog: object, catalog: Map<string, object>) => void} [decorateModelCatalog]
 * @property {(res: import("node:http").ServerResponse, response: import("node:http").IncomingMessage, routing: object) => void} [decorateResponse]
 * @property {(body: object) => number} [contextTokens]
 * @property {(body: object) => number} [requestTokens]
 * @property {(message: string) => object} [upstreamErrorBody]
 * @property {string | ((body: object, conversationKey: string) => string)} [statusId]
 * @property {number} contextWindow
 */

const REQUIRED_FUNCTIONS = [
  "isRoutingRequest",
  "conversationKey",
  "newTurnPrompt",
  "getModels",
  "getDefaultModel",
  "applyTier",
];

const OPTIONAL_FUNCTIONS = [
  "isManualChoice",
  "normalizeRequest",
  "decorateModelCatalog",
  "decorateResponse",
  "contextTokens",
  "requestTokens",
  "upstreamErrorBody",
];

const typeOf = (value) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * Validate an adapter without changing it.
 *
 * @param {Adapter} adapter
 * @returns {Adapter}
 * @throws {Error} When required hooks are absent or any supplied hook has the wrong type.
 */
export function validateAdapter(adapter) {
  const problems = [];
  const isObject = adapter !== null && typeof adapter === "object" && !Array.isArray(adapter);

  if (!isObject) problems.push(`adapter must be a non-null object (received ${typeOf(adapter)})`);

  for (const name of REQUIRED_FUNCTIONS) {
    const value = isObject ? adapter[name] : undefined;
    if (typeof value !== "function") {
      problems.push(`${name} is required and must be a function (received ${typeOf(value)})`);
    }
  }

  const contextWindow = isObject ? adapter.contextWindow : undefined;
  if (
    typeof contextWindow !== "number" ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    problems.push(
      `contextWindow is required and must be a positive finite number (received ${typeOf(contextWindow)})`,
    );
  }

  if (isObject) {
    for (const name of OPTIONAL_FUNCTIONS) {
      if (adapter[name] !== undefined && typeof adapter[name] !== "function") {
        problems.push(`${name} is optional but must be a function when provided (received ${typeOf(adapter[name])})`);
      }
    }

    if (
      adapter.statusId !== undefined &&
      typeof adapter.statusId !== "string" &&
      typeof adapter.statusId !== "function"
    ) {
      problems.push(
        `statusId is optional but must be a string or function when provided (received ${typeOf(adapter.statusId)})`,
      );
    }
  }

  if (problems.length) {
    throw new Error(`Invalid adapter:\n- ${problems.join("\n- ")}`);
  }
  return adapter;
}

/**
 * Define, validate, and return an adapter unchanged so editors can infer its shape.
 *
 * @template {Adapter} T
 * @param {T} adapter
 * @returns {T}
 */
export function defineAdapter(adapter) {
  validateAdapter(adapter);
  return adapter;
}
