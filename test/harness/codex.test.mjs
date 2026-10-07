import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJevModel,
  applyCodexTier,
  codexConversationKey,
  codexModels,
  codexNewTurnPrompt,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  startCodexProxy,
  upstreamFor,
} from "../../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill } from "../../src/codex-cli.mjs";
import { readStatus } from "../../src/lib/status.mjs";
import { runAdapterConformance } from "../../src/adapters/conformance.mjs";

const codexTools = { type: "additional_tools", role: "developer", tools: [{}] };

runAdapterConformance({
  name: "Codex",
  startProxy: ({ upstreamURL, route, statusId }) => startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route,
    statusId,
  }),
  routingPath: "/responses",
  catalogPath: "/models?client_version=conformance",
  sentinelModel: "jev-router",
  resolvedModel: "gpt-5.6-sol-conformance",
  resolvedTier: "opus",
  manualModel: "gpt-5.6-luna",
  catalogResponse: {
    models: [
      {
        slug: "gpt-5.6-terra-conformance",
        display_name: "GPT Terra Conformance",
        visibility: "list",
        supported_in_api: true,
      },
      {
        slug: "gpt-5.6-sol-conformance",
        display_name: "GPT Sol Conformance",
        visibility: "list",
        supported_in_api: true,
      },
    ],
  },
  expectedFallbackModel: "gpt-5.6-sol-conformance",
  expectedCatalogModelIds: [
    "gpt-5.6-terra-conformance",
    "gpt-5.6-sol-conformance",
  ],
  makeRoutingRequest: ({ model, prompt, statusId }) => ({
    model,
    prompt_cache_key: statusId,
    input: [codexTools, { role: "user", content: [{ type: "input_text", text: prompt }] }],
  }),
  makeToolContinuation: ({ model, prompt, statusId }) => ({
    model,
    prompt_cache_key: statusId,
    input: [
      codexTools,
      { role: "user", content: [{ type: "input_text", text: prompt }] },
      { type: "function_call", call_id: "call-1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "done" },
    ],
  }),
  makeExplainRequest: ({ model, prompt, statusId }) => ({
    model,
    prompt_cache_key: statusId,
    input: [
      codexTools,
      { role: "user", content: [{ type: "input_text", text: prompt }] },
      { role: "assistant", content: [{ type: "output_text", text: "done" }] },
      { role: "user", content: [{ type: "input_text", text: "$jev-explain" }] },
    ],
  }),
  makeManualRequest: ({ model, statusId }) => ({
    model,
    prompt_cache_key: statusId,
    input: [codexTools, { role: "user", content: "manual model request" }],
  }),
  authHeaders: {
    authorization: "Bearer codex-conformance-token",
    "chatgpt-account-id": "codex-conformance-account",
  },
});

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-5.6-sol"]).filter((a) => a === "--model").length, 1);
});

test("installs the bundled explanation skill for Codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-codex-skill-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = installCodexSkill(home);
  assert.match(target, /jev-router-explain[\\/]SKILL\.md$/);
  assert.match(readFileSync(target, "utf8"), /name: jev-explain/);
});

test("reads only fresh Codex user turns", () => {
  const body = {
    input: [
      { type: "additional_tools", role: "developer", tools: [{}] },
      { role: "user", content: [{ type: "input_text", text: "Fix the bug" }] },
      { role: "user", content: [{ type: "input_text", text: "<system_reminder>tools</system_reminder>" }] },
      {
        role: "user",
        content: "<environment_context><current_date>2026-09-17</current_date></environment_context>",
      },
    ],
  };
  assert.equal(codexNewTurnPrompt(body), "Fix the bug");
  body.input.push({ type: "function_call_output", call_id: "1", output: "done" });
  assert.equal(codexNewTurnPrompt(body), null);
  assert.equal(
    codexNewTurnPrompt({
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
    null,
  );
  assert.equal(isCodexAuxiliaryPrompt("Generate a concise, single-line task title of at most 36 characters"), true);
});

test("keeps sub-agent routing state separate", () => {
  const base = { input: [{ role: "user", content: "same prompt" }] };
  assert.notEqual(
    codexConversationKey({ ...base, prompt_cache_key: "main" }),
    codexConversationKey({ ...base, prompt_cache_key: "sub-agent" }),
  );
});

test("adds Jev Router to the native model catalog", () => {
  const catalog = addJevModel({
    models: [{
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.equal(catalog.models[0].slug, "jev-router");
  assert.equal(catalog.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[1].slug, "gpt-5.6-terra");
});

test("routes subscription auth to ChatGPT and API keys to the public API", () => {
  assert.equal(
    upstreamFor({ "chatgpt-account-id": "acct" }, "/responses"),
    "https://chatgpt.com/backend-api/codex",
  );
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/responses"), "https://api.openai.com/v1");
  assert.equal(upstreamFor({ authorization: "Bearer sk-test" }, "/models"), "https://chatgpt.com/backend-api/codex");
});

test("maps tiers and clamps unsupported reasoning effort", () => {
  const body = { model: "jev-router", reasoning: { effort: "max" } };
  const models = new Map([[
    "gpt-5.6-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-5.6-terra", { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra" }],
    ["gpt-5.6-sol", { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-5.6-terra", tier: "sonnet" },
    { id: "gpt-5.6-sol", tier: "opus" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-5\.6-sol/);
  assert.match(events, /confidence 0\.91/);

  const unavailable = jevDecisionEvents({
    tier: "sonnet",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /JEV_API_KEY=\.\.\. to ~\/\.jev-router\.env/);
  assert.match(unavailable, /using gpt-5\.6-terra/);
});

test("proxy preserves Codex auth, picker, routing, and native decision output", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        url: req.url,
        authorization: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null,
      });
      if (req.url.startsWith("/backend-api/codex/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          models: [{
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6-Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1"}}\n\n',
      );
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
  const statusId = `codex-test-${process.pid}`;
  let routeCalls = 0;
  const { port, close } = await startCodexProxy({
    chatgptBaseURL: `${upstreamURL}/backend-api/codex`,
    apiBaseURL: `${upstreamURL}/v1`,
    route: async ({ models }) => {
      routeCalls++;
      assert.deepEqual(models.map((model) => model.id), ["gpt-5.6-terra", "gpt-5.6-sol"]);
      return {
        choice: "gpt-5.6-sol",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-5.6-sol", confidence: 0.91 } } },
        metrics: {
          taskComplexity: 0.82,
          reasoningRequired: 0.91,
          toolComplexity: 0.64,
          contextSize: 0.31,
        },
      };
    },
    statusId,
  });
  t.after(close);
  const headers = { authorization: "Bearer subscription-token", "chatgpt-account-id": "acct" };

  const catalog = await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers }).then((r) => r.json());
  assert.equal(catalog.models[0].slug, "jev-router");

  const response = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "debug this race" }] },
      ],
    }),
  }).then((r) => r.text());

  assert.equal(seen[0].authorization, "Bearer subscription-token");
  assert.equal(seen[0].account, "acct");
  assert.equal(seen[1].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: "Generate a concise, single-line task title of at most 36 characters" },
        {
          role: "user",
          content: "<environment_context><timezone>Asia/Calcutta</timezone></environment_context>",
        },
      ],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(readStatus(statusId).confidence, 0.91);
  assert.equal(readStatus(statusId).history.length, 1);

  await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      prompt_cache_key: "main",
      input: [{ role: "user", content: [{ type: "input_text", text: "$jev-explain" }] }],
    }),
  });
  assert.equal(routeCalls, 1);
  assert.equal(seen[3].body.model, "gpt-5.6-sol");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
});

// Regression tests for behavior the pipeline extraction dropped; see PR #44 review.
async function codexUpstream(t, catalog) {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url.includes("/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ models: catalog }));
      }
      seen.push(JSON.parse(Buffer.concat(chunks)));
      res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}`;
  return { seen, chatgptBaseURL: `${base}/backend-api/codex`, apiBaseURL: `${base}/v1` };
}

const postResponses = (port, body) =>
  fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "chatgpt-account-id": "acct" },
    body: JSON.stringify(body),
  }).then((r) => r.text());

const userTurn = (text) => ({ role: "user", content: [{ type: "input_text", text }] });

test("a Codex fallback uses the account's catalog model, not the static id", async (t) => {
  const { seen, ...urls } = await codexUpstream(t, [
    { slug: "gpt-5.5-pro", display_name: "GPT-5.5 Pro", visibility: "list", supported_in_api: true },
  ]);
  const { port, close } = await startCodexProxy({ ...urls, route: async () => null });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/models?client_version=1`, { headers: { "chatgpt-account-id": "acct" } });
  await postResponses(port, { model: "jev-router", input: [codexTools, userTurn("hi")] });

  assert.equal(seen[0].model, "gpt-5.5-pro");
});

test("Codex auxiliary calls and explain turns leave the recorded decision in place", async (t) => {
  const { seen, ...urls } = await codexUpstream(t, []);
  const statusId = `codex-status-${process.pid}`;
  const { port, close } = await startCodexProxy({
    ...urls,
    statusId,
    route: async () => ({ choice: "gpt-5.6-terra", confidence: 0.84 }),
  });
  t.after(close);

  await postResponses(port, { model: "jev-router", prompt_cache_key: "main", input: [codexTools, userTurn("rename x")] });
  assert.equal(readStatus(statusId).tier, "sonnet");

  // A title request on a model of Codex's own choosing is not the user picking a model.
  await postResponses(port, {
    model: "gpt-5.6-luna",
    input: [userTurn("Generate a concise, single-line task title of at most 36 characters")],
  });
  // An explain turn, with tools present, must not overwrite what it is explaining.
  await postResponses(port, {
    model: "jev-router",
    prompt_cache_key: "main",
    input: [codexTools, userTurn("rename x"), { role: "assistant", content: [{ type: "output_text", text: "done" }] }, userTurn("$jev-explain")],
  });
  let status = readStatus(statusId);
  assert.equal(status.manual, undefined);
  assert.equal(status.tier, "sonnet");
  assert.equal(status.history.length, 1);

  // A real turn on a model the user picked is manual.
  await postResponses(port, { model: "gpt-5.6-sol", input: [codexTools, userTurn("now do y")] });
  status = readStatus(statusId);
  assert.equal(status.manual, true);
  assert.equal(seen.length, 4);
});
