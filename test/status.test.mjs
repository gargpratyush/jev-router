import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// `LEDGER` resolves when the module loads, so the override has to be in place first and the
// import has to be dynamic. Everything here shares one ledger file on purpose: it is
// append-only, and proving that two sessions interleave without clobbering is the point.
const LEDGER = join(mkdtempSync(join(tmpdir(), "jev-ledger-")), "routing.jsonl");
process.env.JEV_ROUTING_LEDGER = LEDGER;
const { appendRouting, writeDecision } = await import("../src/status.mjs");

// Tolerates a missing file so each test can also be run on its own with --test-name-pattern.
const lines = () => {
  let text = "";
  try {
    text = readFileSync(LEDGER, "utf8");
  } catch {
    return [];
  }
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

test("a routing decision is recorded durably, without the prompt", () => {
  writeDecision("sess-a", {
    tier: "haiku",
    model: "z-ai/glm-5.3-flash",
    prompt: "rename this variable",
    at: 1000,
  });
  const [row] = lines();
  assert.deepEqual(row, {
    session: "sess-a",
    tier: "haiku",
    model: "z-ai/glm-5.3-flash",
    at: 1000,
  });
  // The status files are 0600 because they carry prompt text. A file meant to outlive the
  // session must not, so this is an assertion about the ledger's contents, not a detail.
  assert.equal("prompt" in row, false);
});

test("every turn is kept, so a session that switches model stays attributable", () => {
  appendRouting("sess-b", { tier: "opus", model: "claude-opus-5-5", at: 2000 });
  appendRouting("sess-b", { tier: "sonnet", model: "claude-sonnet-5", at: 3000 });
  const b = lines().filter((r) => r.session === "sess-b");
  // The status file keeps only the last 20 and lives in the temp dir. If this ever
  // collapses to one row per session, cost attribution silently picks the wrong model
  // for every turn before the last.
  assert.deepEqual(
    b.map((r) => [r.at, r.model]),
    [[2000, "claude-opus-5-5"], [3000, "claude-sonnet-5"]],
  );
});

test("a decision with nothing to attribute is not written", () => {
  const before = lines().length;
  assert.equal(appendRouting("", { model: "claude-opus-5" }), false);
  assert.equal(appendRouting("sess-c", { tier: "opus" }), false); // no model: nothing to credit
  assert.equal(lines().length, before);
});

test("an unwritable ledger never fails the request", () => {
  // In a child process because the path resolves once, when the module loads. Re-importing
  // under a query string to dodge the cache hangs the test runner, and the thing worth
  // proving is the behaviour of a fresh process anyway.
  // A directory path that runs through a regular file: mkdir gives ENOTDIR at once. Staying
  // inside the test's own temp dir keeps it hermetic, and a system path such as /proc can
  // make a recursive mkdir hang rather than fail.
  const blocker = join(dirname(LEDGER), "not-a-dir");
  writeFileSync(blocker, "");
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'const s = await import(process.argv[1]);' +
        ' console.log(s.appendRouting("sess-d", { tier: "opus", model: "claude-opus-5" }));',
      new URL("../src/status.mjs", import.meta.url).href,
    ],
    { env: { ...process.env, JEV_ROUTING_LEDGER: join(blocker, "deeper", "routing.jsonl") } },
  );
  assert.equal(out.toString().trim(), "false");
});
