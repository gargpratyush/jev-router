// Settings for a self-hosted decision model (Clef, Laya, ...) behind TYPESAFE_BASE_URL. They
// are read from the environment at import, so this file sets it before importing.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.JEV_MODEL_ONLY = "1";
process.env.JEV_TIMEOUT_MS = "4000";
process.env.JEV_DEADLINE_MS = "9000";
process.env.JEV_MIN_CONFIDENCE = "0.1";
process.env.JEV_START_TIER = "sonnet";
process.env.JEV_API_KEY = "local";

const { THRESHOLDS, startTier } = await import("../src/config.mjs");
const { decide } = await import("../src/policy.mjs");

test("timeouts and the confidence floor come from the environment", () => {
  assert.equal(THRESHOLDS.jevTimeoutMs, 4000);
  assert.equal(THRESHOLDS.jevDeadlineMs, 9000);
  assert.equal(THRESHOLDS.minConfidence, 0.1);
});

test("a conversation starts on the configured tier, and an unknown one falls back to opus", () => {
  assert.equal(startTier(), "sonnet");
  process.env.JEV_START_TIER = "giant";
  assert.equal(startTier(), "opus");
  process.env.JEV_START_TIER = "sonnet";
});

test("a decision model's own confidence scale can clear the floor", () => {
  const jev = { choice: "haiku", confidence: 0.19 };
  const out = decide({ prompt: "fix the typo", jev, current: "sonnet", available: ["haiku", "sonnet", "opus"] });
  assert.equal(out.tier, "haiku");
});

test("a model-only request routes, and missing scores do not drop the decision", async (t) => {
  let asked;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked = { url: req.url, body: JSON.parse(body) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        model: "clef",
        answers: { model: { type: "choice", choice: "claude-haiku-4-5-20251001", confidence: 0.46, probabilities: {} } },
        usage: { input_tokens: 500, output_tokens: 0 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const { askJev } = await import("../src/router.mjs");
  const models = [
    { id: "claude-haiku-4-5-20251001", tier: "haiku" },
    { id: "claude-opus-5", tier: "opus" },
  ];
  const jev = await askJev({ prompt: "fix the typo", current: "claude-opus-5", contextTokens: 100, models });
  assert.match(asked.url, /\/v1\/systemone$/);
  assert.deepEqual(Object.keys(asked.body.questions), ["model"]);
  assert.equal(jev.choice, "claude-haiku-4-5-20251001");
  assert.equal(jev.metrics.taskComplexity, null);
});
