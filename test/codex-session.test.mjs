import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Same reason as status.test.mjs: the ledger path resolves when the module loads.
const LEDGER = join(mkdtempSync(join(tmpdir(), "jev-claim-")), "routing.jsonl");
process.env.JEV_ROUTING_LEDGER = LEDGER;
const { claimSession, rolloutIds } = await import("../src/codex-cli.mjs");

const UUID_A = "01a0ea4a-9d84-78c3-a2aa-57e7ed9d9e5b";
const UUID_B = "01a0ea52-f0b3-78a2-8e6e-a02a49c2d9ec";

function sessions() {
  const dir = join(mkdtempSync(join(tmpdir(), "jev-sessions-")), "sessions");
  mkdirSync(join(dir, "2026", "09", "28"), { recursive: true });
  return dir;
}

const rollout = (dir, uuid, day = "28") =>
  writeFileSync(join(dir, "2026", "09", day, `rollout-2026-09-${day}T19-12-33-${uuid}.jsonl`), "");

const lines = () => {
  try {
    return readFileSync(LEDGER, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

// Never sleeps for real: a 250 ms poll times out the suite long before it proves anything.
const nowait = { sleep: async () => {}, waitMs: 0 };

test("session ids are read out of the rollout filenames, at any depth", () => {
  const dir = sessions();
  rollout(dir, UUID_A);
  mkdirSync(join(dir, "2026", "10", "01"), { recursive: true });
  writeFileSync(join(dir, "2026", "10", "01", `rollout-2026-10-01T00-00-00-${UUID_B}.jsonl`), "");
  writeFileSync(join(dir, "2026", "09", "28", "not-a-rollout.jsonl"), "");
  assert.deepEqual([...rolloutIds(dir)].sort(), [UUID_A, UUID_B].sort());
});

test("a missing sessions directory is empty, not an error", () => {
  assert.deepEqual([...rolloutIds("/nowhere/at/all")], []);
});

test("the one rollout that appears after the snapshot is claimed", async () => {
  const dir = sessions();
  const before = rolloutIds(dir);
  rollout(dir, UUID_A);
  assert.equal(await claimSession("codex-123", before, { dir, ...nowait }), UUID_A);
  const [row] = lines().filter((r) => r.alias === "codex-123");
  assert.equal(row.session, UUID_A);
});

test("a rollout that already existed is not claimed", async () => {
  const dir = sessions();
  rollout(dir, UUID_A);
  const before = rolloutIds(dir); // snapshot taken after it exists
  assert.equal(await claimSession("codex-124", before, { dir, tries: 2, ...nowait }), null);
  assert.deepEqual(lines().filter((r) => r.alias === "codex-124"), []);
});

test("two concurrent Codex runs claim nothing rather than guess", async () => {
  const dir = sessions();
  const before = rolloutIds(dir);
  rollout(dir, UUID_A);
  rollout(dir, UUID_B);
  // The whole point: a wrong alias bills a turn to the wrong model, which is worse than
  // leaving it unpriced. Ambiguity has to resolve to silence.
  assert.equal(await claimSession("codex-125", before, { dir, ...nowait }), null);
  assert.deepEqual(lines().filter((r) => r.alias === "codex-125"), []);
});

test("polling gives Codex time to write the rollout", async () => {
  const dir = sessions();
  const before = rolloutIds(dir);
  let ticks = 0;
  const claimed = await claimSession("codex-126", before, {
    dir,
    tries: 10,
    sleep: async () => {
      if (++ticks === 3) rollout(dir, UUID_A); // appears on the third poll, not the first
    },
  });
  assert.equal(claimed, UUID_A);
  assert.equal(ticks, 3);
});
