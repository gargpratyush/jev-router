#!/usr/bin/env node
import { routeTurn } from "../../src/lib/index.mjs";

const offline = process.argv.includes("--offline");
const models = [
  { id: "toy-fast-v1", tier: "haiku", description: "Fast toy model" },
  { id: "toy-balanced-v1", tier: "sonnet", description: "Balanced toy model" },
  { id: "toy-strong-v1", tier: "opus", description: "Strong toy model" },
];
const defaults = Object.fromEntries(models.map(({ tier, id }) => [tier, id]));
const workload = [
  "Summarize the latest tool result.",
  "Plan a safe refactor across the parser and its tests.",
];

const offlineRoute = async ({ prompt }) => ({
  choice: prompt.startsWith("Plan") ? "toy-strong-v1" : "toy-balanced-v1",
  confidence: 0.96,
  metrics: { taskComplexity: 0.5, reasoningRequired: 0.5, toolComplexity: 0.1, contextSize: 0 },
  request: { offline: true, prompt },
  response: { offline: true },
  ms: 0,
});

let current = "opus";
let currentModel = defaults[current];

for (const [index, prompt] of workload.entries()) {
  const decision = await routeTurn({
    prompt,
    current,
    currentModel,
    models,
    contextTokens: index * 500,
    contextWindow: 32_000,
    getDefaultModel: (tier) => defaults[tier],
    route: offline ? offlineRoute : undefined,
  });

  console.log(
    `Native pattern: tier=${decision.tier} model=${decision.model} reason=${decision.reason}`,
  );

  // This is where an owned orchestrator would call its model SDK with decision.model.
  current = decision.tier;
  currentModel = decision.model;
}
