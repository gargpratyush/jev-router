import test from "node:test";
import assert from "node:assert/strict";
import { askJev, routingBackend } from "../src/router.mjs";
import { COMPLEXITY_MAX_SCORE } from "../src/config.mjs";

const MODELS = [
  { id: "claude-haiku-4-5", description: "fast" },
  { id: "claude-sonnet-4-5", description: "balanced" },
];

const ASK = { prompt: "hello", current: "claude-sonnet-4-5", contextTokens: 1000, models: MODELS };

/** The body the OpenRouter decisions endpoint returns, same shape as the TypeSafe SDK. */
const score = (n) => ({ type: "score", score: n, legend: [], probabilities: {}, confidence: 0.8 });
const okBody = () => ({
  model: "~typesafe/jev-latest",
  usage: { cost: 0.00004 },
  answers: {
    model: {
      type: "choice",
      choice: "claude-haiku-4-5",
      probabilities: { "claude-haiku-4-5": 0.9, "claude-sonnet-4-5": 0.1 },
      confidence: 0.9,
    },
    task_complexity: score(2),
    reasoning_required: score(1),
    tool_complexity: score(0),
  },
});

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Swaps in a fetch stub and an OpenRouter-only environment, and puts both back after. */
function withOpenRouter(t, fetchImpl) {
  const realFetch = globalThis.fetch;
  const realJev = process.env.JEV_API_KEY;
  const realTypeSafe = process.env.TYPESAFE_API_KEY;
  const realKey = process.env.OPENROUTER_API_KEY;
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return fetchImpl(calls.length);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    if (realJev === undefined) delete process.env.JEV_API_KEY;
    else process.env.JEV_API_KEY = realJev;
    if (realTypeSafe === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = realTypeSafe;
    if (realKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = realKey;
  });
  return calls;
}

test("routingBackend prefers TypeSafe and falls back to OpenRouter", () => {
  assert.equal(routingBackend({ JEV_API_KEY: "a" }), "typesafe");
  assert.equal(routingBackend({ TYPESAFE_API_KEY: "a" }), "typesafe");
  assert.equal(routingBackend({ OPENROUTER_API_KEY: "b" }), "openrouter");
  assert.equal(routingBackend({ JEV_API_KEY: "a", OPENROUTER_API_KEY: "b" }), "typesafe");
  assert.equal(routingBackend({}), null);
});

test("askJev routes over OpenRouter and reads the answers", async (t) => {
  const calls = withOpenRouter(t, () => jsonResponse(200, okBody()));

  const result = await askJev(ASK);

  assert.equal(result.choice, "claude-haiku-4-5");
  assert.equal(result.confidence, 0.9);
  assert.equal(result.metrics.taskComplexity, 2 / COMPLEXITY_MAX_SCORE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-key");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "~typesafe/jev-latest");
  assert.ok(sent.state.request);
  assert.ok(sent.questions.model);
});

test("askJev retries once after a 500 and then succeeds", async (t) => {
  const calls = withOpenRouter(t, (n) =>
    n === 1 ? jsonResponse(500, { error: "upstream" }) : jsonResponse(200, okBody()),
  );

  const result = await askJev(ASK);

  assert.equal(calls.length, 2);
  assert.equal(result.choice, "claude-haiku-4-5");
});

test("askJev gives up on a 400 and keeps the current model", async (t) => {
  const calls = withOpenRouter(t, () => jsonResponse(400, { error: "bad request" }));

  const result = await askJev(ASK);

  assert.equal(result, null);
  assert.equal(calls.length, 1);
});
