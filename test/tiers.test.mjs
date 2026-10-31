import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableTiers, parseTierList, readSavedTiers } from "../src/config.mjs";
import { runTiersCommand, saveTiers } from "../src/tiers.mjs";

const withHome = (t) => {
  const home = mkdtempSync(join(tmpdir(), "jev-tiers-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });
  return home;
};

const captureStdout = (run) => {
  const write = process.stdout.write;
  let out = "";
  process.stdout.write = (chunk) => ((out += chunk), true);
  try {
    run();
  } finally {
    process.stdout.write = write;
  }
  return out;
};

test("offers every tier except fable by default", () => {
  // Act & Assert
  assert.deepEqual(availableTiers({}, ""), ["haiku", "sonnet", "opus"]);
});

test("JEV_ALLOWED_TIERS narrows routing and ignores unknown names", () => {
  // Act & Assert
  assert.deepEqual(availableTiers({ JEV_ALLOWED_TIERS: " sonnet , gpt-9 " }, ""), ["sonnet"]);
  assert.deepEqual(availableTiers({ JEV_ALLOWED_TIERS: "gpt-9" }, ""), ["haiku", "sonnet", "opus"]);
});

test("a saved list wins over JEV_ALLOWED_TIERS", () => {
  // Act & Assert
  assert.deepEqual(availableTiers({ JEV_ALLOWED_TIERS: "haiku" }, "sonnet,opus"), ["sonnet", "opus"]);
});

test("fable stays opt-in even when a list names it", () => {
  // Act & Assert
  assert.deepEqual(availableTiers({}, "sonnet,fable"), ["sonnet"]);
  assert.deepEqual(availableTiers({ JEV_ALLOW_FABLE: "1" }, "sonnet,fable"), ["sonnet", "fable"]);
});

test("parseTierList accepts commas and spaces and rejects bad lists", () => {
  // Act & Assert
  assert.equal(parseTierList("Haiku, sonnet  opus"), "haiku,sonnet,opus");
  assert.equal(parseTierList(""), null);
  assert.equal(parseTierList("sonnet,gpt-9"), null);
});

test("the tiers command saves a list, shows it, and resets it", (t) => {
  // Arrange
  withHome(t);

  // Act
  const set = captureStdout(() => runTiersCommand(["haiku,", "sonnet"]));
  const saved = readSavedTiers();
  const reset = captureStdout(() => runTiersCommand(["reset"]));

  // Assert
  assert.equal(set, "Jev routes between haiku, sonnet.\n");
  assert.equal(saved, "haiku,sonnet");
  assert.equal(reset, "Jev routes between haiku, sonnet, opus.\n");
  assert.equal(readSavedTiers(), "");
});

test("the tiers command rejects an unknown tier without saving", (t) => {
  // Arrange
  withHome(t);
  saveTiers("sonnet");
  const previousCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousCode;
  });

  // Act
  const stderr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    runTiersCommand(["gpt-9"]);
  } finally {
    process.stderr.write = stderr;
  }

  // Assert
  assert.equal(process.exitCode, 2);
  assert.equal(readSavedTiers(), "sonnet");
});
