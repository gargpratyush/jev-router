import test from "node:test";
import assert from "node:assert/strict";
import { buildJevRequest, parseJevModelAnswer } from "../src/router.mjs";
import { codexRoutingContext } from "../src/codex-context.mjs";

const models = [{
  id: "gpt-test", tier: "sonnet", description: "Coding and tool use",
  capabilities: { reasoningEfforts: ["low", "high"], contextWindow: 200000, tools: ["Apply patch"], modalities: { input: ["Text", "Image"] } },
  cost: { input: 1, cached_input: 0.1, output: 5 },
}];

test("Jev receives context and complete model metadata with only supported pair choices", () => {
  const context = { instructions: "Preserve watchdog servicing", conversation: "Implement the previous plan" };
  const request = buildJevRequest({ prompt: "Implement it", current: "gpt-test", currentEffort: "high", contextTokens: 500, models, context, selectReasoning: true });
  assert.equal(request.state.context, context);
  assert.deepEqual(request.state.environment.model_details[0].capabilities, models[0].capabilities);
  assert.deepEqual(request.state.environment.model_details[0].cost, models[0].cost);
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["gpt-test::low", "gpt-test::high"]);
  assert.deepEqual(parseJevModelAnswer({ choice: "gpt-test::high", confidence: 0.8 }, models, true), {
    choice: "gpt-test", effort: "high", confidence: 0.8,
  });
  assert.throws(() => parseJevModelAnswer({ choice: "gpt-test::ultra" }, models, true), /unknown/);
});

test("shared Claude routing retains exact model choices", () => {
  const request = buildJevRequest({ prompt: "Fix it", current: "gpt-test", contextTokens: 0, models });
  assert.deepEqual(Object.keys(request.questions.model.criteria), ["gpt-test"]);
  assert.equal(parseJevModelAnswer({ choice: "gpt-test" }, models).choice, "gpt-test");
});

test("routing context retains instructions, plans, tool evidence and media markers without changing the upstream body", () => {
  const body = {
    instructions: "Project instructions: preserve flash-write limits",
    tools: [{ type: "function", name: "read_file", description: "Read project files" }],
    input: [
      { role: "developer", content: "Repository uses native tests" },
      { role: "assistant", content: "Plan: batch writes" },
      { type: "function_call_output", call_id: "read1", output: "Current code: write()" },
      { role: "user", content: [{ type: "input_text", text: "Implement that plan" }, { type: "input_image", image_url: "data:image/png;base64,PRIVATE_BYTES" }] },
    ],
  };
  const original = JSON.stringify(body);
  const context = codexRoutingContext(body);
  assert.match(context.instructions, /flash-write/);
  assert.match(context.conversation, /native tests/);
  assert.match(context.conversation, /Plan: batch writes/);
  assert.match(context.conversation, /Current code: write/);
  assert.match(context.conversation, /input_image/);
  assert.match(context.tools, /read_file/);
  assert.doesNotMatch(JSON.stringify(context), /PRIVATE_BYTES|data:image/);
  assert.equal(context.truncated, false);
  assert.equal(JSON.stringify(body), original);
});

test("oversized context is bounded and explicitly marked while preserving the start and latest messages", () => {
  const context = codexRoutingContext({
    instructions: "Follow AGENTS.md",
    input: [{ role: "user", content: "Initial project plan" }, { role: "assistant", content: "x".repeat(100000) }, { role: "user", content: "Latest follow-up" }],
  }, 1000);
  assert(context.included_chars <= 1000);
  assert(context.original_chars > 100000);
  assert.equal(context.truncated, true);
  assert.match(context.conversation, /Initial project plan/);
  assert.match(context.conversation, /Latest follow-up/);
  assert.match(context.conversation, /omitted/);
});
