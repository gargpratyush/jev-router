import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// One file per session rather than a shared map, so concurrent jev-claude sessions can never
// clobber each other's status. Kept in the temp dir so the OS eventually cleans up.
const DIR = join(tmpdir(), "jev-claude");

// Status files hold prompt text and exact Jev exchanges, so only the owner may read them.
// On Linux the temp dir is the shared /tmp; macOS and Windows temp dirs are already per-user,
// where these modes are harmless (Windows ignores them).
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Files not updated for this long belong to finished sessions and are removed.
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
let pruned = false;

const fileFor = (sessionId) => join(DIR, `${sessionId.replace(/[^\w-]/g, "")}.json`);

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    ensureDir();
    const file = fileFor(sessionId);
    writeFileSync(file, JSON.stringify(status), { mode: FILE_MODE });
    // `mode` only applies on creation; tighten files written by earlier versions too.
    chmodSync(file, FILE_MODE);
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

// Durable, unlike the status files above. Those sit in the temp dir and keep the last 20
// decisions because the status line is cosmetic. Cost attribution is not: a rewritten turn
// is billed against the model we picked, and nothing downstream records which one that was.
// Claude Code names the real model on its own per-request records, but Codex writes only the
// id it asked for, so every Codex turn through the router lands under `jev-router` and prices
// to nothing. This ledger is the missing half of that join.
//
// The prompt is deliberately not written here. The status files are 0600 precisely because
// they carry prompt text, and a file that is meant to outlive the session has no business
// keeping it — session, time, tier and model are all an attribution needs.
const LEDGER =
  process.env.JEV_ROUTING_LEDGER ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "jev-router",
    "routing.jsonl",
  );

function appendLedger(record) {
  try {
    mkdirSync(dirname(LEDGER), { recursive: true, mode: DIR_MODE });
    appendFileSync(LEDGER, JSON.stringify(record) + "\n", { mode: FILE_MODE });
    return true;
  } catch {
    // Attribution is a bonus. A request is never failed for it.
    return false;
  }
}

/** Append one routing decision to the durable ledger. Never throws. */
export function appendRouting(sessionId, { tier, model, at } = {}) {
  if (!sessionId || !model) return false;
  return appendLedger({ session: sessionId, tier, model, at: at ?? Date.now() });
}

/**
 * Record that a proxy-local id and a real session id name the same conversation.
 *
 * Claude Code sends its session id in the request body, so its decisions are already filed
 * under the id the transcript uses. Codex sends nothing of the kind: the proxy files under
 * `codex-<pid>` while Codex mints its own uuid and reveals it only in the rollout filename.
 * Without this line the two halves cannot be joined and every routed Codex turn stays
 * attributed to the alias.
 */
export function appendSessionAlias(alias, session, at = Date.now()) {
  if (!alias || !session || alias === session) return false;
  return appendLedger({ alias, session, at });
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
  appendRouting(sessionId, decision);
}

/** Ledger path, exposed for tests and for the agent-os reader. */
export const ROUTING_LEDGER = LEDGER;

/** Latest routing decision for a session, or null if none has been made yet. */
export function readStatus(sessionId) {
  try {
    return JSON.parse(readFileSync(fileFor(sessionId), "utf8"));
  } catch {
    return null;
  }
}

function ensureDir() {
  mkdirSync(DIR, { recursive: true, mode: DIR_MODE });
  // Directories created by earlier versions were world-readable. chmod fails if another user
  // owns the directory, in which case the write below fails too and status is skipped.
  chmodSync(DIR, DIR_MODE);
}

/** Delete status files untouched for `maxAgeMs`. Runs once per process on the first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(DIR, name);
      try {
        if (now - statSync(file).mtimeMs > maxAgeMs) {
          unlinkSync(file);
          removed++;
        }
      } catch {
        // Another session may have removed or replaced it; ignore.
      }
    }
  } catch {
    // Missing or unreadable directory: nothing to prune.
  }
  return removed;
}

/** Directory holding status files, exposed for tests and diagnostics. */
export const STATUS_DIR = DIR;
