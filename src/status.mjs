import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * Writes a file into the status directory so only the owner can read it, creating the directory
 * the same way. Also used for the temporary Claude Code settings file, which is handed to
 * `--settings` and names a command Claude Code then executes, so on Linux, where the temp dir is
 * the shared /tmp, a readable copy would let another user choose that command. Throws rather than
 * falling back to a loose file, because no status line is better than one someone else controls.
 */
export function writePrivate(file, contents) {
  ensureDir();
  writeFileSync(file, contents, { mode: FILE_MODE });
  // `mode` only applies on creation; tighten files written by earlier versions too.
  chmodSync(file, FILE_MODE);
}

/** Publish the latest routing decision so the status line can display it. */
export function writeStatus(sessionId, status) {
  if (!sessionId) return;
  try {
    writePrivate(fileFor(sessionId), JSON.stringify(status));
    if (!pruned) {
      pruned = true;
      pruneStale();
    }
  } catch {
    // Status display is cosmetic and must never interfere with a request.
  }
}

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  const history = [...(previous?.history ?? []), decision].slice(-20);
  writeStatus(sessionId, { ...decision, history });
}

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
