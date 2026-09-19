import test from "node:test";
import assert from "node:assert/strict";
import { askJev } from "../src/router.mjs";
import { hasCredentials, providerName } from "../src/config.mjs";

const MODELS = [{ id: "claude-opus-5", tier: "opus", description: "Claude Opus 5" }];

const cloudflareResult = {
  result: {
    model: "jev-1.13.0",
    answers: {
      model: {
        type: "choice",
        choice: "claude-opus-5",
        confidence: 0.9,
        probabilities: { "claude-opus-5": 0.9 },
      },
      task_complexity: { type: "score", score: 3 },
      reasoning_required: { type: "score", score: 3 },
      tool_complexity: { type: "score", score: 2 },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  },
  success: true,
  errors: [],
  messages: [],
};

test("provider selection is explicit and defaults to typesafe", () => {
  delete process.env.JEV_PROVIDER;
  assert.equal(providerName(), "typesafe");
  process.env.JEV_PROVIDER = "cloudflare";
  assert.equal(providerName(), "cloudflare");
  process.env.JEV_PROVIDER = "vercel";
  assert.equal(providerName(), "vercel");
  process.env.JEV_PROVIDER = "nonsense";
  assert.equal(providerName(), "typesafe");
  delete process.env.JEV_PROVIDER;
});

test("hasCredentials checks the active provider's variables", () => {
  delete process.env.JEV_PROVIDER;
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.AI_GATEWAY_API_KEY;
  assert.equal(hasCredentials(), false);
  process.env.JEV_API_KEY = "k";
  assert.equal(hasCredentials(), true);
  delete process.env.JEV_API_KEY;

  process.env.JEV_PROVIDER = "cloudflare";
  assert.equal(hasCredentials(), false, "token alone is not enough");
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  assert.equal(hasCredentials(), false, "account id alone is not enough");
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  assert.equal(hasCredentials(), true);
  delete process.env.JEV_PROVIDER;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;

  process.env.JEV_PROVIDER = "vercel";
  assert.equal(hasCredentials(), false, "gateway key is required");
  process.env.AI_GATEWAY_API_KEY = "gk";
  assert.equal(hasCredentials(), true);
  delete process.env.JEV_PROVIDER;
  delete process.env.AI_GATEWAY_API_KEY;
});

test("cloudflare provider sends the REST envelope and unwraps result", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(cloudflareResult), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });
  process.env.JEV_PROVIDER = "cloudflare";
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";

  const out = await askJev({
    prompt: "fix the bug",
    current: "sonnet",
    contextTokens: 100,
    models: MODELS,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "typesafe/jev");
  assert.equal(body.input.state.request, "fix the bug");
  assert.equal(body.input.state.session.current_model, "sonnet");
  assert.equal(body.input.state.session.context_tokens, 100);
  assert.deepEqual(Object.keys(body.input.questions), [
    "task_complexity",
    "reasoning_required",
    "tool_complexity",
    "model",
  ]);

  assert.equal(out.choice, "claude-opus-5");
  assert.equal(out.confidence, 0.9);
  assert.equal(typeof out.ms, "number");
  assert.equal(out.metrics.taskComplexity, 3 / 9);
  assert.equal(out.request.state.request, "fix the bug");
  assert.equal(out.response.answers.model.choice, "claude-opus-5");
});

test("cloudflare failures fail open with null", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });
  process.env.JEV_PROVIDER = "cloudflare";
  process.env.CLOUDFLARE_API_TOKEN = "tok";
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";

  // HTTP 200 but success: false
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, errors: [{ code: 7000, message: "no" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  let out = await askJev({ prompt: "x", current: "sonnet", contextTokens: 0, models: MODELS });
  assert.equal(out, null);

  // HTTP 500
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "boom" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  out = await askJev({ prompt: "x", current: "sonnet", contextTokens: 0, models: MODELS });
  assert.equal(out, null);
});

test("default provider never touches the Cloudflare endpoint", async (t) => {
  const originalFetch = globalThis.fetch;
  let cloudflareCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes("api.cloudflare.com")) cloudflareCalls++;
    throw new Error("typesafe path should use the SDK, not global fetch");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
  });
  delete process.env.JEV_PROVIDER;

  // No TYPESAFE_API_KEY: getClient() throws at construction, caught inside askJev -> null.
  const out = await askJev({ prompt: "x", current: "sonnet", contextTokens: 0, models: MODELS });
  assert.equal(out, null);
  assert.equal(cloudflareCalls, 0);
});

const vercelResult = {
  answers: {
    model: {
      type: "choice",
      choice: "claude-opus-5",
      probabilities: { "claude-opus-5": 0.9 },
    },
    task_complexity: { type: "score", score: 3 },
    reasoning_required: { type: "score", score: 3 },
    tool_complexity: { type: "score", score: 2 },
  },
  usage: { inputTokens: 100, outputTokens: 20 },
  providerMetadata: { typesafe: { confidence: { model: 0.88 } } },
};

test("vercel provider sends gateway headers and backfills confidence", async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(vercelResult), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  process.env.JEV_PROVIDER = "vercel";
  process.env.AI_GATEWAY_API_KEY = "gk";

  const out = await askJev({
    prompt: "fix the bug",
    current: "sonnet",
    contextTokens: 100,
    models: MODELS,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer gk");
  assert.equal(calls[0].init.headers["ai-model-id"], "typesafe-ai/jev");
  assert.equal(calls[0].init.headers["ai-evaluation-model-specification-version"], "4");
  assert.equal(calls[0].init.headers["ai-gateway-protocol-version"], "0.0.1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, undefined, "the model id rides in a header, not the body");
  assert.equal(body.state.request, "fix the bug");
  assert.deepEqual(Object.keys(body.questions), [
    "task_complexity",
    "reasoning_required",
    "tool_complexity",
    "model",
  ]);

  assert.equal(out.choice, "claude-opus-5");
  assert.equal(out.confidence, 0.88, "confidence is backfilled from providerMetadata");
  assert.equal(out.response.answers.model.confidence, 0.88);
  assert.equal(out.metrics.taskComplexity, 3 / 9);
  assert.equal(out.request.state.request, "fix the bug");
});

test("vercel answers without providerMetadata keep confidence undefined", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ ...vercelResult, providerMetadata: undefined }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  process.env.JEV_PROVIDER = "vercel";
  process.env.AI_GATEWAY_API_KEY = "gk";

  const out = await askJev({ prompt: "x", current: "sonnet", contextTokens: 0, models: MODELS });
  assert.equal(out.choice, "claude-opus-5");
  assert.equal(out.confidence, undefined);
});

test("vercel failures fail open with null", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.JEV_PROVIDER;
    delete process.env.AI_GATEWAY_API_KEY;
  });
  process.env.JEV_PROVIDER = "vercel";
  process.env.AI_GATEWAY_API_KEY = "gk";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ error: { message: "Authentication failed", type: "authentication_error" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  const out = await askJev({ prompt: "x", current: "sonnet", contextTokens: 0, models: MODELS });
  assert.equal(out, null);
});
