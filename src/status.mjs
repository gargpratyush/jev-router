import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One file per session rather than a shared map, so concurrent jev-claude sessions can never
// clobber each other's status. Kept in the temp dir so the OS eventually cleans up.
// On POSIX the name includes the uid: /tmp is shared, and a fixed name would let another user
// create the directory (or a symlink) first. Windows temp dirs are already per-user.
const POSIX = typeof process.getuid === "function";
const DIR = join(tmpdir(), POSIX ? `jev-claude-${process.getuid()}` : "jev-claude");

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
    ensurePrivateDir();
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

/**
 * Create the private temp directory if needed and return its path. Throws if the path is a
 * symlink or not owned by the current user, so nothing is written where someone else controls it.
 */
export function ensurePrivateDir(dir = DIR) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (POSIX) {
    const info = lstatSync(dir);
    if (!info.isDirectory() || info.uid !== process.getuid()) {
      throw new Error(`${dir} is not a directory owned by the current user`);
    }
  }
  chmodSync(dir, DIR_MODE);
  return dir;
}

/** Delete status files untouched for `maxAgeMs`. Runs once per process on the first write. */
export function pruneStale(maxAgeMs = STALE_AFTER_MS, now = Date.now()) {
  let removed = 0;
  try {
    for (const name of readdirSync(DIR)) {
      // settings.json is rewritten on every launch and must outlive long sessions.
      if (!name.endsWith(".json") || name === "settings.json") continue;
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
