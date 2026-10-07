/**
 * The harness-agnostic routing core.
 *
 * Nothing in this directory knows what a Claude Code request or a Codex request looks like.
 * It answers one question — given a prompt, a context size, and the models an account can
 * reach, which model should this turn go to — and records the answer so the CLI can explain
 * it afterwards. Wire protocol, model-picker injection, and decision surfacing all belong to
 * a harness adapter outside this directory.
 *
 * The adapter contract is public in `src/adapters/` (`genericProxy`, `defineAdapter`, and
 * the conformance suite; see docs/adapters.md). The two bundled harnesses implement it at
 * the top of `src/`: `proxy.mjs` and `settings.mjs` for Claude Code, `codex-proxy.mjs` and
 * `codex-cli.mjs` for Codex. Everything a harness routes with comes from here.
 *
 * This file is internal. The package exports map exposes only `src/adapters/`, so outside
 * consumers reach the core through that entry point (`routeTurn` is re-exported there).
 */

// Tier table, thresholds, the Jev question rubric, and the sentinel model id.
export * from "./config.mjs";

// The policy ladder: confidence floors, the no-downgrade rule, and override detection.
export * from "./policy.mjs";

// The Jev call itself, including timeout, deadline, and retry handling.
export * from "./router.mjs";

// One complete per-turn decision for native callers and HTTP proxy adapters alike.
export * from "./route-turn.mjs";

// Per-session decision records, read back by `jev-explain` and the status line.
export * from "./status.mjs";

// Human-readable rendering of a recorded decision.
export * from "./explain.mjs";

// File-backed logging that never writes to stderr while a TUI owns the terminal.
export * from "./log.mjs";
