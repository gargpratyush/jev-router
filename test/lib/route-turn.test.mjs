import test from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { formatExplanation, readStatus, routeTurn, STATUS_DIR } from "../../src/lib/index.mjs";

const models = [
  { id: "test-haiku-v1", tier: "haiku" },
  { id: "test-sonnet-v1", tier: "sonnet" },
  { id: "test-opus-v2", tier: "opus" },
];
const defaults = {
  haiku: "test-haiku-v1",
  sonnet: "test-sonnet-v1",
  opus: "test-opus-default",
};

test("routeTurn consults the router, applies policy, resolves the exact model, and records the decision", async (t) => {
  const statusId = `route-turn-${process.pid}-${Date.now()}`;
  t.after(() => {
    try {
      unlinkSync(join(STATUS_DIR, `${statusId}.json`));
    } catch {
      // A failed status write leaves nothing to clean up; the assertions below report it.
    }
  });

  let routeInput;
  const decision = await routeTurn({
    prompt: "Refactor the parser safely",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models,
    contextTokens: 1_200,
    contextWindow: 100_000,
    statusId,
    getDefaultModel: (tier) => defaults[tier],
    route: async (input) => {
      routeInput = input;
      return {
        choice: "test-opus-v2",
        confidence: 0.91,
        metrics: { taskComplexity: 0.8 },
        request: { state: { session: { current_model: input.current, context_tokens: input.contextTokens } } },
        response: { answers: { model_tier: { choice: "opus" } } },
        ms: 4,
      };
    },
  });

  assert.equal(routeInput.current, "test-sonnet-v1");
  assert.equal(routeInput.contextWindow, 100_000);
  assert.deepEqual(routeInput.models, models);
  assert.equal(decision.tier, "opus");
  assert.equal(decision.model, "test-opus-v2");
  assert.equal(decision.reason, "jev");
  assert.equal(decision.confidence, 0.91);
  assert.equal(typeof decision.at, "number");

  const recorded = readStatus(statusId);
  assert.equal(recorded.prompt, "Refactor the parser safely");
  assert.equal(recorded.model, "test-opus-v2");
  assert.equal(recorded.history.length, 1);
  assert.match(formatExplanation(recorded), /Selected model: TEST-OPUS-V2/);
});

test("routeTurn keeps the current exact model when policy rejects a low-confidence downgrade", async () => {
  const decision = await routeTurn({
    prompt: "Investigate the race",
    current: "opus",
    currentModel: "test-opus-current",
    models,
    contextTokens: 500,
    contextWindow: 100_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => ({ choice: "test-haiku-v1", confidence: 0.1 }),
  });

  assert.equal(decision.tier, "opus");
  assert.equal(decision.model, "test-opus-current");
  assert.match(decision.reason, /low-confidence-no-downgrade/);
});

test("routeTurn degrades safely to the current model when the router returns null", async () => {
  let calls = 0;
  const decision = await routeTurn({
    prompt: "Continue the current task",
    current: "sonnet",
    currentModel: "test-sonnet-current",
    models,
    contextTokens: 800,
    contextWindow: 100_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => {
      calls++;
      return null;
    },
  });

  assert.equal(calls, 1);
  assert.equal(decision.tier, "sonnet");
  assert.equal(decision.model, "test-sonnet-current");
  assert.equal(decision.confidence, null);
  assert.match(decision.reason, /jev-unavailable/);
});

test("routeTurn never offers the router a tier the operator has disabled", async () => {
  // `fable` bills extra usage credits, so it is unavailable unless JEV_ALLOW_FABLE is set.
  // Offering it to the router would spend a choice the policy ladder could only clamp away.
  const seen = [];
  await routeTurn({
    prompt: "write the migration",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models: [...models, { id: "test-fable-v1", tier: "fable" }],
    contextTokens: 100,
    getDefaultModel: (tier) => defaults[tier],
    route: async ({ models: offered }) => {
      seen.push(...offered.map((model) => model.tier));
      return null;
    },
  });

  assert.equal(seen.includes("fable"), false, "a disabled tier must never reach the router");
  assert.deepEqual(seen, ["haiku", "sonnet", "opus"]);
});

test("routeTurn records into an injected store, not the shared one", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createStatusStore } = await import("../../src/adapters/index.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jev-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createStatusStore({ dir });
  const statusId = `injected-store-${process.pid}`;

  await routeTurn({
    prompt: "rename a variable",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models,
    contextWindow: 200_000,
    statusId,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => ({ choice: "test-haiku-v1", confidence: 0.95 }),
    store,
  });

  assert.equal(store.readStatus(statusId)?.model, "test-haiku-v1");
  assert.equal(readStatus(statusId), null, "nothing leaks into the shared store");
});

test("a model whose window cannot hold the request is skipped, and policy steps up", async () => {
  const sized = [
    { id: "test-haiku-v1", tier: "haiku", maxInputTokens: 200_000 },
    { id: "test-sonnet-v1", tier: "sonnet", maxInputTokens: 1_000_000 },
    { id: "test-opus-v2", tier: "opus" },
  ];
  let offered;
  const decision = await routeTurn({
    prompt: "what is 2+2?",
    current: "opus",
    currentModel: "test-opus-v2",
    models: sized,
    contextTokens: 7_000,
    requestTokens: 218_000,
    contextWindow: 200_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async (input) => ((offered = input.models), { choice: "test-haiku-v1", confidence: 1 }),
  });

  assert.deepEqual(offered.map((m) => m.id), ["test-sonnet-v1", "test-opus-v2"], "Jev is not offered a model that cannot fit");
  assert.notEqual(decision.tier, "haiku");
});

test("a conversation that outgrows its current model moves to one that fits", async () => {
  const decision = await routeTurn({
    prompt: "keep going",
    current: "haiku",
    currentModel: "test-haiku-v1",
    models: [
      { id: "test-haiku-v1", tier: "haiku", maxInputTokens: 200_000 },
      { id: "test-sonnet-v1", tier: "sonnet" },
    ],
    contextTokens: 190_000,
    requestTokens: 190_000,
    contextWindow: 200_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => null,
  });

  assert.equal(decision.tier, "sonnet");
  assert.equal(decision.model, "test-sonnet-v1");
});

test("headroom keeps a request just under the window off that model", async () => {
  const decision = await routeTurn({
    prompt: "small task",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models: [
      { id: "test-haiku-v1", tier: "haiku", maxInputTokens: 200_000 },
      { id: "test-sonnet-v1", tier: "sonnet" },
    ],
    contextTokens: 1_000,
    requestTokens: 195_000,
    contextWindow: 200_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async () => ({ choice: "test-haiku-v1", confidence: 1 }),
  });

  assert.equal(decision.tier, "sonnet");
});

test("when no model can hold the request, the turn stays where it was", async () => {
  const decision = await routeTurn({
    prompt: "huge",
    current: "sonnet",
    currentModel: "test-sonnet-v1",
    models: [
      { id: "test-haiku-v1", tier: "haiku", maxInputTokens: 200_000 },
      { id: "test-sonnet-v1", tier: "sonnet", maxInputTokens: 200_000 },
    ],
    contextTokens: 300_000,
    requestTokens: 300_000,
    contextWindow: 200_000,
    getDefaultModel: (tier) => defaults[tier],
    route: async ({ models }) => (models.length ? { choice: models[0].id, confidence: 1 } : null),
  });

  assert.equal(decision.tier, "sonnet");
  assert.equal(decision.model, "test-sonnet-v1");
});
