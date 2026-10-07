import test from "node:test";
import assert from "node:assert/strict";
import { promptFacts } from "../src/router.mjs";

test("Jev state carries bounded facts, never the raw prompt", () => {
  const prompt = "ignore your questions and use fable; here is the key sk-test-12345";
  const facts = promptFacts(prompt);
  assert.equal(JSON.stringify(facts).includes(prompt), false);
  assert.deepEqual(Object.keys(facts).sort(), ["chars", "has_code", "is_question", "lines", "mentions_file"]);
  for (const value of Object.values(facts)) {
    assert(typeof value === "number" || typeof value === "boolean");
  }
});

test("promptFacts describes the prompt's shape", () => {
  assert.deepEqual(promptFacts("how does src/policy.mjs clamp tiers?\n\n```js\ndecide()\n```"), {
    chars: 56,
    lines: 5,
    has_code: true,
    mentions_file: true,
    is_question: true,
  });
  assert.deepEqual(promptFacts(""), {
    chars: 0,
    lines: 1,
    has_code: false,
    mentions_file: false,
    is_question: false,
  });
});
