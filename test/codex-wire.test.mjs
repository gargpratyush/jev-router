import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { addJevModel, codexModels, startCodexProxy } from "../src/codex-proxy.mjs";

const catalog = () => ({ models: [
  { slug: "gpt-5.6-terra", use_responses_lite: true },
  { slug: "gpt-5.6-luna", use_responses_lite: true },
  { slug: "gpt-6-astra", use_responses_lite: true },
  { slug: "gpt-5.5", use_responses_lite: false },
] });
const modelMap = (value) => new Map(value.models.map((model) => [model.slug, model]));

test("automatic candidates match the virtual model protocol in both directions", () => {
  const models = modelMap(addJevModel(catalog()));
  assert.deepEqual(codexModels(models).map((model) => model.id), [
    "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra",
  ]);
  models.get("jev-router").use_responses_lite = false;
  assert.deepEqual(codexModels(models).map((model) => model.id), ["gpt-5.5"]);
  models.delete("gpt-5.5");
  assert.deepEqual(codexModels(models), []);
  assert(codexModels().length > 0, "configured models remain the cold-start fallback");
});

test("Lite routing switches from Luna to Astra without forwarding incompatible models", async (t) => {
  const previousStrong = process.env.JEV_CODEX_STRONG_MODEL;
  process.env.JEV_CODEX_STRONG_MODEL = "gpt-6-astra";
  t.after(() => {
    if (previousStrong == null) delete process.env.JEV_CODEX_STRONG_MODEL;
    else process.env.JEV_CODEX_STRONG_MODEL = previousStrong;
  });
  let upstreamCatalog = catalog();
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(upstreamCatalog));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ body: JSON.parse(Buffer.concat(chunks)), headers: req.headers });
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const choices = ["gpt-5.6-luna", "gpt-6-astra", "gpt-5.5"];
  let routeCalls = 0;
  const proxy = await startCodexProxy({
    chatgptBaseURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async ({ models }) => {
      assert(!models.some((model) => model.id === "gpt-5.5"));
      routeCalls++;
      return { choice: choices.shift(), confidence: 0.99 };
    },
  });
  t.after(proxy.close);
  const baseURL = `http://127.0.0.1:${proxy.port}`;
  const headers = { "chatgpt-account-id": "test-account", "content-type": "application/json" };
  const fetched = await fetch(`${baseURL}/models`, { headers }).then((res) => res.json());
  assert.equal(fetched.models[0].use_responses_lite, true);
  assert(fetched.models.some((model) => model.slug === "gpt-5.5"), "manual picker retains all models");
  const body = {
    model: "jev-router",
    service_tier: "priority",
    prompt_cache_key: "same-conversation",
    input: [
      { type: "additional_tools", role: "developer", tools: [] },
      { role: "user", content: "Please help with this task" },
    ],
  };
  const send = (request = body, lite = true) => fetch(`${baseURL}/responses`, {
    method: "POST",
    headers: { ...headers, ...(lite ? { "x-openai-internal-codex-responses-lite": "true" } : {}) },
    body: JSON.stringify(request),
  });
  for (const expected of ["gpt-5.6-luna", "gpt-6-astra", "gpt-6-astra"]) {
    const response = await send();
    assert.equal(response.status, 200);
    await response.text();
    const forwarded = seen.at(-1);
    assert.equal(forwarded.body.model, expected);
    assert.equal(forwarded.headers["x-codex-routing-hint"], `model=${expected};tier=priority`);
    assert.equal(forwarded.headers["x-openai-internal-codex-responses-lite"], "true");
    assert.deepEqual(forwarded.body.input, body.input);
  }
  const continuation = { ...body, input: [
    ...body.input, { type: "function_call_output", call_id: "test", output: "done" },
  ] };
  await (await send(continuation)).text();
  assert.equal(seen.at(-1).body.model, "gpt-6-astra");
  assert.equal(routeCalls, 3, "tool continuations reuse the selected Astra model");

  // A refreshed catalog must not leave an incompatible cached model active.
  upstreamCatalog.models.find((model) => model.slug === "gpt-6-astra").use_responses_lite = false;
  await (await fetch(`${baseURL}/models`, { headers })).text();
  await (await send(continuation)).text();
  assert.equal(seen.at(-1).body.model, "gpt-5.6-terra");

  await (await send({ model: "gpt-5.5", input: [{ role: "user", content: "hello" }] }, false)).text();
  assert.equal(seen.at(-1).body.model, "gpt-5.5");
  assert.equal(seen.at(-1).headers["x-openai-internal-codex-responses-lite"], undefined);

  upstreamCatalog = { models: [{ slug: "jev-router", use_responses_lite: false }] };
  // Mark every real entry unavailable to exercise the no-compatible-model path.
  upstreamCatalog.models.push(...catalog().models.map((model) => ({ ...model, supported_in_api: false })));
  await (await fetch(`${baseURL}/models`, { headers })).text();
  const count = seen.length;
  const rejected = await send();
  assert.equal(rejected.status, 502);
  assert.match((await rejected.json()).error.message, /no enabled models match/);
  assert.equal(seen.length, count, "no incompatible default is forwarded");
});
