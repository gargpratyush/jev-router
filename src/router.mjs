import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  providerName,
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

const CLOUDFLARE_RUN_URL = "https://api.cloudflare.com/client/v4/accounts";
const CLOUDFLARE_JEV_MODEL = "typesafe/jev";

/**
 * Cloudflare Workers AI hosts the same Jev model behind its own REST envelope: the request
 * wraps state and questions in `input`, and the response wraps answers in `result`. No retry
 * here — the deadline below bounds the whole call, and a failed route keeps the current model.
 */
async function runCloudflare(request, signal) {
  const res = await fetch(
    `${CLOUDFLARE_RUN_URL}/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLOUDFLARE_JEV_MODEL,
        input: { state: request.state, questions: request.questions },
      }),
      signal,
    },
  );
  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result;
}

const VERCEL_EVAL_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";
const VERCEL_JEV_MODEL = "typesafe-ai/jev";

/**
 * The Vercel AI Gateway fronts the same Jev model behind its evaluation-model endpoint: the
 * model id rides in a header, and choice/score answers carry no top-level confidence —
 * TypeSafe's confidence statistic lives in providerMetadata keyed by question id, so it is
 * copied back onto each answer. No retry here — the deadline below bounds the whole call,
 * and a failed route keeps the current model.
 */
async function runVercel(request, signal) {
  const res = await fetch(VERCEL_EVAL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      "content-type": "application/json",
      "ai-model-id": VERCEL_JEV_MODEL,
      "ai-evaluation-model-specification-version": "4",
      "ai-gateway-protocol-version": "0.0.1",
    },
    body: JSON.stringify({ state: request.state, questions: request.questions }),
    signal,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  }
  const confidence = json.providerMetadata?.typesafe?.confidence ?? {};
  for (const [id, answer] of Object.entries(json.answers ?? {})) {
    if (answer.confidence === undefined && confidence[id] !== undefined) {
      answer.confidence = confidence[id];
    }
  }
  return json;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models }) {
  if (!models?.length) return null;
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
    const provider = providerName();
    const result =
      provider === "cloudflare"
        ? await runCloudflare(request, abort.signal)
        : provider === "vercel"
          ? await runVercel(request, abort.signal)
          : await getClient().systemOne(request, { signal: abort.signal });
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
