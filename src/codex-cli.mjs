import { spawn } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_AUTO_MODEL, startCodexProxy } from "./codex-proxy.mjs";
import { appendSessionAlias } from "./status.mjs";

const PROVIDER = "jev";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPLAIN_SKILL = join(ROOT, "skills", "codex", "jev-explain", "SKILL.md");

export function installCodexSkill(home = homedir()) {
  const target = join(home, ".agents", "skills", "jev-router-explain", "SKILL.md");
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(EXPLAIN_SKILL, target);
  return target;
}

export function loadEnv() {
  for (const file of [
    join(process.cwd(), ".env"),
    join(ROOT, ".env"),
    join(homedir(), ".jev-router.env"),
    join(homedir(), ".jev-claude.env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing or unreadable; values may still come from the real environment.
    }
  }
}

export function resolveCodex() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `codex${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

export const codexArgs = (baseURL, args) => [
  "--no-daemon",
  ...(args.some((arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model="))
    ? []
    : ["--model", CODEX_AUTO_MODEL]),
  "--config",
  `model_provider="${PROVIDER}"`,
  "--config",
  `model_providers.${PROVIDER}.name="Jev Router"`,
  "--config",
  `model_providers.${PROVIDER}.base_url="${baseURL}"`,
  "--config",
  `model_providers.${PROVIDER}.wire_api="responses"`,
  "--config",
  `model_providers.${PROVIDER}.requires_openai_auth=true`,
  "--config",
  `model_providers.${PROVIDER}.supports_websockets=false`,
  ...args,
];

const sessionsDir = (home = homedir()) =>
  join(process.env.CODEX_HOME || join(home, ".codex"), "sessions");

/**
 * Session ids of every rollout Codex has written, read out of the filenames.
 *
 * Names rather than mtimes on purpose: a set difference needs no clock, so it is immune to
 * the rollout directory being bucketed by UTC date while the process runs in local time,
 * and it costs one directory walk instead of a stat per file.
 */
export function rolloutIds(dir = sessionsDir()) {
  try {
    return new Set(
      readdirSync(dir, { recursive: true })
        .map((entry) => /rollout-.*?-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i
          .exec(String(entry))?.[1])
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Link this Codex run's rollout to the proxy's alias, once Codex has created it.
 *
 * Codex writes the rollout a moment after start, so the set is polled rather than read once.
 * Two new rollouts means another Codex started alongside this one and nothing here can tell
 * which is which — that writes nothing, because an absent attribution leaves a turn unpriced
 * while a wrong one bills it to the wrong model.
 */
export async function claimSession(alias, before, {
  dir = sessionsDir(),
  tries = 40,
  waitMs = 250,
  // `unref` so a poll still in flight can never hold the launcher open after Codex quits.
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
} = {}) {
  if (!alias) return null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const fresh = [...rolloutIds(dir)].filter((id) => !before.has(id));
    if (fresh.length === 1) return appendSessionAlias(alias, fresh[0]) ? fresh[0] : null;
    if (fresh.length > 1) return null;
    await sleep(waitMs);
  }
  return null;
}

// Loads configuration, starts the optional routing proxy, and launches the Codex CLI.
export async function runCodex() {
  loadEnv();
  try {
    installCodexSkill();
  } catch (err) {
    process.stderr.write(`[jev] could not install the Codex explanation skill: ${err.message}\n`);
  }
  const command = resolveCodex();
  if (!command) {
    process.stderr.write(
      "[jev] OpenAI Codex is not installed, or `codex` is not on your PATH.\n" +
        "[jev] jev-codex runs the real Codex CLI; install it first:\n" +
        "[jev]   https://developers.openai.com/codex/cli\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  let close = () => {};
  let routing = false;
  const statusId = `codex-${process.pid}`;
  process.env.JEV_CODEX_STATUS_ID = statusId;
  if (process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY) {
    const proxy = await startCodexProxy({ statusId });
    close = proxy.close;
    routing = true;
    args = codexArgs(`http://127.0.0.1:${proxy.port}`, args);
  } else {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting Codex without routing\n" +
        `[jev] add JEV_API_KEY=... to ${join(homedir(), ".jev-router.env")} and restart jev-codex\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  // Snapshot before the spawn: whatever appears after it is this run's rollout. Only worth
  // taking when the proxy is up, since an unrouted Codex session files no decisions to join.
  const before = routing ? rolloutIds() : null;
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env: process.env },
  );
  // Not awaited: Codex owns the terminal from here, and the launcher must not hold it up to
  // write a bookkeeping line. Failure is silent by design — see `claimSession`.
  if (before) claimSession(statusId, before);
  child.on("error", (err) => {
    close();
    process.stderr.write(`[jev] could not start Codex: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    close();
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
