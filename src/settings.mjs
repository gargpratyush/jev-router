import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AUTO_MODEL } from "./config.mjs";

export const USER_SETTINGS = join(homedir(), ".claude", "settings.json");

/** Used only when the original's mode cannot be read. Settings files can hold credentials. */
const FALLBACK_MODE = 0o600;

/**
 * Replaces `file` in one step. A plain write truncates first, so a crash in between leaves the
 * user with an unreadable settings file, and this runs while the process is already shutting
 * down. Writing a sibling and renaming over the target means a reader sees either the old
 * contents or the new ones and never half of each; the rename stays inside one directory, which
 * is atomic on POSIX and replaces the target on Windows. The original mode is carried over so
 * putting a model back never loosens or tightens a file the user owns.
 */
function replaceFile(file, contents) {
  let mode = FALLBACK_MODE;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // No readable original, so there is no mode to carry over.
  }
  const temp = `${file}.jev-${process.pid}.tmp`;
  try {
    writeFileSync(temp, contents, { mode });
    // `mode` only applies on creation, and a leftover temp file would keep its own.
    chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already gone.
    }
    throw err;
  }
}

/**
 * The model saved as the user's default, ignoring a sentinel left behind by a session that
 * did not exit cleanly, which is not a preference worth restoring.
 */
export function readSavedModel(file = USER_SETTINGS) {
  try {
    const model = JSON.parse(readFileSync(file, "utf8")).model;
    return model === AUTO_MODEL ? undefined : model;
  } catch {
    return undefined;
  }
}

/**
 * Puts `previous` back if the settings file now holds the sentinel. Selecting a row with
 * Enter makes Claude Code save it as the default for new sessions, and a saved "jev-router"
 * would break plain `claude`, which has no proxy to resolve it. Anything other than an exact
 * sentinel match is left alone, so a real model chosen during the session survives.
 */
export function restoreSavedModel(previous, file = USER_SETTINGS) {
  try {
    const settings = JSON.parse(readFileSync(file, "utf8"));
    if (settings.model !== AUTO_MODEL) return false;
    if (previous === undefined) delete settings.model;
    else settings.model = previous;
    replaceFile(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
