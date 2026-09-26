#!/usr/bin/env node
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readStatus, STATUS_DIR } from "../src/status.mjs";
import { formatExplanation, formatHistory } from "../src/explain.mjs";

const args = process.argv.slice(2);
const isHistory = args.includes("--history") || args.includes("-h") || args.includes("--all");
const targetArg = args.find((a) => !a.startsWith("-"));

let sessionId = targetArg ?? process.env.JEV_CODEX_STATUS_ID;

if (!sessionId) {
  // Find newest session in STATUS_DIR
  try {
    const files = readdirSync(STATUS_DIR)
      .filter((f) => f.endsWith(".json") && f !== "settings.json")
      .map((f) => ({
        id: f.replace(/\.json$/, ""),
        mtime: statSync(join(STATUS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) sessionId = files[0].id;
  } catch {
    // ignore
  }
}

const status = readStatus(sessionId);
if (isHistory) {
  process.stdout.write(`${formatHistory(status)}\n`);
} else {
  process.stdout.write(`${formatExplanation(status)}\n`);
}
