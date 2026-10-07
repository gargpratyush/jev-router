import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStatusStore, DEFAULT_STATUS_DIR, STATUS_DIR } from "../../src/lib/status.mjs";

// Each test gets a store of its own, so nothing here touches the directory that live
// sessions and `jev-explain` read.
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "jev-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createStatusStore({ dir });
}

test("status round-trips per session and misses cleanly", (t) => {
  const { writeStatus, readStatus } = isolated(t);
  writeStatus("s1", { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.deepEqual(readStatus("s1"), { tier: "opus", confidence: 0.87, reason: "jev" });
  assert.equal(readStatus("no-such-session"), null);
  assert.doesNotThrow(() => writeStatus("", { tier: "opus" }));
});

test("status files are private to their owner", { skip: process.platform === "win32" }, (t) => {
  const { writeStatus, STATUS_DIR: dir } = isolated(t);
  writeStatus("perm", { tier: "opus" });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "perm.json")).mode & 0o777, 0o600);
});

test("stale status files are pruned and fresh ones kept", (t) => {
  const { writeStatus, pruneStale, STATUS_DIR: dir } = isolated(t);
  writeStatus("seed", { tier: "opus" }); // creates the directory with the right mode
  const stale = join(dir, "stale.json");
  const fresh = join(dir, "fresh.json");
  writeFileSync(stale, "{}");
  writeFileSync(fresh, "{}");
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  assert.equal(pruneStale(), 1);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true);
});

test("routing status retains the exact recent Jev exchanges", (t) => {
  const { writeDecision, readStatus } = isolated(t);
  writeDecision("h", { prompt: "first", jev: { request: { id: 1 }, response: { confidence: 0.6 } } });
  writeDecision("h", { prompt: "second", jev: { request: { id: 2 }, response: { confidence: 0.8 } } });
  const status = readStatus("h");
  assert.equal(status.prompt, "second");
  assert.deepEqual(status.history.map(({ prompt }) => prompt), ["first", "second"]);
  assert.equal(status.history[0].jev.response.confidence, 0.6);
});

test("only the last 20 exchanges are retained", (t) => {
  const { writeDecision, readStatus } = isolated(t);
  for (let i = 0; i < 25; i++) writeDecision("cap", { prompt: `p${i}` });
  const { history } = readStatus("cap");
  assert.equal(history.length, 20);
  assert.equal(history[0].prompt, "p5");
  assert.equal(history.at(-1).prompt, "p24");
});

test("a session id cannot escape its status directory", (t) => {
  const { writeStatus, readStatus, STATUS_DIR: dir } = isolated(t);
  writeStatus("../escape", { tier: "opus" });
  assert.equal(existsSync(join(dir, "escape.json")), true);
  assert.deepEqual(readStatus("../escape"), { tier: "opus" });
});

test("the module-level store keeps using the default directory", () => {
  assert.equal(STATUS_DIR, DEFAULT_STATUS_DIR);
});
