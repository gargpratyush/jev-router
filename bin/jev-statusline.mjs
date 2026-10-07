#!/usr/bin/env node
// Status line for Claude Code. Claude Code pipes session JSON on stdin and renders whatever
// this prints. See https://code.claude.com/docs/en/statusline
import { readStatus } from "../src/lib/status.mjs";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const COLOR = { haiku: "\x1b[32m", sonnet: "\x1b[36m", opus: "\x1b[35m", fable: "\x1b[33m" };

// A status line replaces Claude Code's footer hints, so echo the basics it stops showing.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);

let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString() || "{}");
} catch {
  // Malformed input still gets a usable line below.
}

const status = readStatus(input.session_id);
const dir = (input.workspace?.current_dir ?? input.cwd ?? "").split(/[\\/]/).pop();
const pct = Math.round(input.context_window?.used_percentage ?? 0);

let routed = `${DIM}jev: waiting for first prompt${RESET}`;
if (status?.manual) {
  // The user picked this model with /model, so show their choice rather than a tier.
  routed = `${DIM}⏸ manual${RESET} ${input.model?.display_name ?? ""}`.trimEnd();
} else if (status) {
  const color = COLOR[status.tier] ?? "";
  const p = status.confidence != null ? ` ${DIM}(p=${status.confidence.toFixed(2)})${RESET}` : "";
  // Only name the reason when routing declined to do the obvious thing, so the common case
  // stays short and the interesting case explains itself.
  const held =
    status.reason &&
    status.reason !== "jev" &&
    status.reason !== "jev/no-change" &&
    !status.reason.includes("override");
  const why = held ? ` ${DIM}(${status.reason.split("/")[0]})${RESET}` : "";
  routed = `${color}${status.model ?? status.tier}${RESET}${p}${why}`;
}

process.stdout.write(`${routed} ${DIM}·${RESET} ${dir} ${DIM}· ${pct}% context${RESET}\n`);
