import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addJevModel,
  applyCodexTier,
  codexConversationKey,
  codexModels,
  codexNewTurnPrompt,
  isCodexModelCatalogFresh,
  isCodexAuxiliaryPrompt,
  jevDecisionEvents,
  startCodexProxy,
  upstreamFor,
} from "../src/codex-proxy.mjs";
import { codexArgs, installCodexSkill, resolveCodex } from "../src/codex-cli.mjs";
import { readStatus } from "../src/status.mjs";

test("Codex uses a temporary authenticated Jev provider", () => {
  const args = codexArgs("http://127.0.0.1:1234", ["--sandbox", "read-only"]);
  assert.deepEqual(args.slice(0, 2), ["--model", "jev-router"]);
  assert(args.includes('model_provider="jev"'));
  assert(args.includes("model_providers.jev.requires_openai_auth=true"));
  assert.deepEqual(args.slice(-2), ["--sandbox", "read-only"]);
  assert.equal(codexArgs("http://127.0.0.1:1234", ["--model", "gpt-6-sol"]).filter((a) => a === "--model").length, 1);
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
      slug: "gpt-6-sol",
      display_name: "GPT-6 Sol",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
    }],
  });
  assert.equal(catalog.models[0].slug, "jev-router");
  assert.equal(catalog.models[0].display_name, "Jev Router");
  assert.equal(catalog.models[1].slug, "gpt-6-sol");
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
    "gpt-6-luna",
    { default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "medium" }] },
  ]]);
  applyCodexTier(body, "haiku", models);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("sends exact available GPT models to Jev", () => {
  const models = new Map([
    ["gpt-6-luna", { slug: "gpt-6-luna", display_name: "GPT-6 Luna" }],
    ["gpt-6-sol", { slug: "gpt-6-sol", display_name: "GPT-6 Sol" }],
  ]);
  assert.deepEqual(codexModels(models).map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-6-luna", tier: "haiku" },
    { id: "gpt-6-sol", tier: "opus" },
  ]);
});

test("includes Codex reasoning capabilities in the routing model description", () => {
  const [model] = codexModels(new Map([[
    "gpt-6-sol",
    {
      slug: "gpt-6-sol",
      display_name: "GPT-6 Sol",
      context_window: 200000,
      supported_reasoning_levels: [{ effort: "medium" }, { effort: "high" }],
      default_reasoning_level: "medium",
    },
  ]]));
  assert.deepEqual(model.capabilities, {
    reasoningEfforts: ["medium", "high"],
    defaultReasoningEffort: "medium",
    contextWindow: 200000,
  });
  assert.match(model.description, /reasoning: medium, high/);
});

test("expires the Codex model catalog after one day", () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  assert.equal(isCodexModelCatalogFresh(now - 23 * 60 * 60 * 1000, now), true);
  assert.equal(isCodexModelCatalogFresh(now - 24 * 60 * 60 * 1000, now), false);
  assert.equal(isCodexModelCatalogFresh(0, now), false);
});

test("uses unique GPT-6 models for the cold-start fallback", () => {
  assert.deepEqual(codexModels().map(({ id, tier }) => ({ id, tier })), [
    { id: "gpt-6-luna", tier: "haiku" },
    { id: "gpt-6-sol", tier: "opus" },
    { id: "gpt-6-astra", tier: "fable" },
  ]);
});

test("surfaces routing as a native commentary event", () => {
  const events = jevDecisionEvents({ tier: "opus", confidence: 0.91, reason: "jev" });
  assert.match(events, /response\.output_item\.added/);
  assert.match(events, /response\.output_text\.delta/);
  assert.match(events, /response\.output_item\.done/);
  assert.match(events, /"phase":"commentary"/);
  assert.match(events, /\[Jev\] routed this turn to gpt-6-sol/);
  assert.match(events, /confidence 0\.91/);

  const warning = jevDecisionEvents({
    tier: "opus",
    confidence: 0.91,
    reason: "jev",
    warning: "upstream unavailable",
  });
  assert.match(warning, /warning: could not refresh the Codex model catalog: upstream unavailable/);

  const unavailable = jevDecisionEvents({
    tier: "opus",
    confidence: null,
    reason: "jev-unavailable/no-change",
  });
  assert.match(unavailable, /JEV_API_KEY=\.\.\. to ~\/\.jev-router\.env/);
  assert.match(unavailable, /using gpt-6-sol/);
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
            slug: "gpt-6-luna",
            display_name: "GPT-6 Luna",
            visibility: "list",
            supported_in_api: true,
            priority: 2,
          }, {
            slug: "gpt-6-sol",
            display_name: "GPT-6 Sol",
            visibility: "list",
            supported_in_api: true,
            priority: 3,
          }],
        }));
      }
      const usage = req.url.includes("retry")
        ? { input_tokens: 7, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5, total_tokens: 12 }
        : { input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 12 };
      res.end(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r1"}}\n\n' +
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r1", model: "gpt-6-sol", usage } })}\n\n`,
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
      assert.deepEqual(models.map((model) => model.id), ["gpt-6-luna", "gpt-6-sol"]);
      return {
        choice: "gpt-6-sol",
        confidence: 0.91,
        request: { state: { request: "debug this race" } },
        response: { answers: { model: { choice: "gpt-6-sol", confidence: 0.91 } } },
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
  assert.equal(seen[1].body.model, "gpt-6-sol");
  assert.equal(readStatus(statusId).tier, "opus");
  assert.equal(readStatus(statusId).model, "gpt-6-sol");
  assert.equal(readStatus(statusId).prompt, "debug this race");
  assert.equal(readStatus(statusId).jev.request.state.request, "debug this race");
  assert.equal(readStatus(statusId).history.length, 1);
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);
  assert.deepEqual(readStatus(statusId).usage.turns[0].aggregate, {
    inputTokens: 10,
    cachedInputTokens: 4,
    nonCachedInputTokens: 6,
    outputTokens: 2,
    reasoningTokens: 1,
    totalTokens: 12,
  });
  assert.deepEqual(readStatus(statusId).usage.turns[0].requests[0].raw, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 12,
  });
  assert(response.indexOf("response.created") < response.indexOf("[Jev] routed this turn"));
  assert(response.indexOf("[Jev] routed this turn") < response.indexOf("response.completed"));
  assert(response.indexOf("response.completed") < response.indexOf("[Jev usage]"));

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
  assert.equal(seen[3].body.model, "gpt-6-sol");
  assert.equal(readStatus(statusId).metrics.reasoningRequired, 0.91);

  const usageReport = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      input: [
        { type: "additional_tools", role: "developer", tools: [{}] },
        { role: "user", content: [{ type: "input_text", text: "$jev-usage" }] },
      ],
    }),
  }).then((r) => r.text());
  assert.match(usageReport, /Jev usage — most recent turn/);
  assert.match(usageReport, /gpt-6-sol/);
  // The generated title request is a constituent request of the same logical turn.
  assert.match(usageReport, /Total: 24/);
  assert.equal(routeCalls, 1);
});

test("Windows Codex resolution avoids a blocked PowerShell shim", (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific command resolution");
  const bin = mkdtempSync(join(tmpdir(), "jev-codex-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "codex.ps1"), "exit 1\n");
  writeFileSync(join(bin, "codex.cmd"), "@exit /b 0\r\n");
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => { process.env.PATH = previousPath; });
  assert.equal(resolveCodex()?.file, join(bin, "codex.cmd"));
});
