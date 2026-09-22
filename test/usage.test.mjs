import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, formatUsage, formatUsageReport, normalizeUsage, usageFromResponse } from "../src/usage.mjs";

const rawUsage = {
  input_tokens: 42_381,
  input_tokens_details: { cached_tokens: 38_916 },
  output_tokens: 3_247,
  output_tokens_details: { reasoning_tokens: 1_104 },
  total_tokens: 45_628,
};

test("normalizes Responses API usage without double counting cached or reasoning tokens", () => {
  assert.deepEqual(normalizeUsage(rawUsage), {
    inputTokens: 42_381,
    cachedInputTokens: 38_916,
    nonCachedInputTokens: 3_465,
    outputTokens: 3_247,
    reasoningTokens: 1_104,
    totalTokens: 45_628,
  });
  assert.equal(formatUsage(normalizeUsage(rawUsage)).includes("Total: 45,628"), true);
});

test("keeps raw response usage and supports missing optional usage details", () => {
  const result = usageFromResponse({ response: { model: "gpt-6-sol", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } });
  assert.equal(result.model, "gpt-6-sol");
  assert.deepEqual(result.raw, { input_tokens: 8, output_tokens: 3, total_tokens: 11 });
  assert.equal(result.usage.cachedInputTokens, undefined);
  assert.equal(result.usage.nonCachedInputTokens, undefined);
  assert.equal(result.usage.reasoningTokens, undefined);
  assert.equal(normalizeUsage(undefined), null);
});

test("aggregates retries only from authoritative per-request totals", () => {
  const requests = [
    { usage: normalizeUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 4 }, output_tokens: 2, total_tokens: 12 }) },
    { usage: normalizeUsage({ input_tokens: 7, input_tokens_details: { cached_tokens: 3 }, output_tokens: 5, total_tokens: 12 }) },
  ];
  assert.deepEqual(aggregateUsage(requests), {
    inputTokens: 17,
    cachedInputTokens: 7,
    nonCachedInputTokens: 10,
    outputTokens: 7,
    reasoningTokens: undefined,
    totalTokens: 24,
  });
});

test("marks an aggregate unavailable when any constituent request lacks usage metadata", () => {
  assert.equal(aggregateUsage([{ usage: normalizeUsage(rawUsage) }, { usage: null }]), null);
  const report = formatUsageReport([{ model: "gpt-6-sol", aggregate: null, requests: [{ usage: null }] }]);
  assert.match(report, /Usage: unavailable/);
  assert.match(report, /gpt-6-sol/);
});
