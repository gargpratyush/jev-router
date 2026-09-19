import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
const OPENROUTER_MODEL = "~typesafe/jev-latest";

/**
 * Picks the transport for the routing call. TypeSafe wins when both keys are present
 * because a direct account is the cheaper path. Null means "no routing at all".
 *
 * @returns {?("typesafe"|"openrouter")}
 */
export function routingBackend(env = process.env) {
  if (env.JEV_API_KEY || env.TYPESAFE_API_KEY) return "typesafe";
  if (env.OPENROUTER_API_KEY) return "openrouter";
  return null;
}

/**
 * Same Jev model, reached through OpenRouter's decisions endpoint. The response body is
 * the shape the TypeSafe SDK returns, so callers cannot tell the two apart.
 *
 * Retries once on a network error, a timeout or a 5xx. A 4xx is a bad key or a bad
 * request, so a second attempt would only waste the turn's latency budget.
 */
export async function askOpenRouter(request, signal) {
  const body = JSON.stringify({
    model: process.env.JEV_OPENROUTER_MODEL ?? OPENROUTER_MODEL,
    ...request,
  });
  const headers = {
    authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "content-type": "application/json",
    "HTTP-Referer": "https://github.com/clatter971-homelab/jev-router",
    "X-Title": "jev-router",
  };
  let lastError;
  for (let attempt = 0; attempt <= THRESHOLDS.jevMaxRetries; attempt += 1) {
    const timeout = AbortSignal.timeout(THRESHOLDS.jevTimeoutMs);
    const attemptSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetch(OPENROUTER_URL, { method: "POST", headers, body, signal: attemptSignal });
    } catch (err) {
      // The caller's own deadline fired; retrying cannot beat it.
      if (signal?.aborted) throw err;
      lastError = err;
      continue;
    }
    if (response.ok) return await response.json();
    const text = (await response.text().catch(() => "")).slice(0, 200);
    const err = new Error(`OpenRouter returned ${response.status}: ${text}`);
    if (response.status < 500) throw err;
    lastError = err;
  }
  throw lastError;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models }) {
  if (!models?.length) return null;
  const backend = routingBackend();
  if (!backend) {
    log(`no routing key found, keeping ${current}`);
    return null;
  }
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
  try {
    const result =
      backend === "typesafe"
        ? await getClient().systemOne(request, { signal: abort.signal })
        : await askOpenRouter(request, abort.signal);
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...answer,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
