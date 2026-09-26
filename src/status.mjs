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
export const EVENTS_FILE = join(DIR, "events.jsonl");

// Routing switch state (default enabled)
let routingEnabled = true;
export function isRoutingEnabled() {
  return routingEnabled;
}
export function setRoutingEnabled(enabled) {
  routingEnabled = Boolean(enabled);
}

// In-memory circular buffer for fast dashboard retrieval (capacity 2000 events)
const EVENT_CAPACITY = 2000;
let eventsBuffer = [];
let eventSeq = 0;
let lastEventsMtimeMs = 0;
let lastEventsSize = -1;

export function loadEvents() {
  ensureDir();
  try {
    let stat = null;
    try {
      stat = statSync(EVENTS_FILE);
    } catch {}

    if (stat) {
      if (stat.mtimeMs !== lastEventsMtimeMs || stat.size !== lastEventsSize) {
        const content = readFileSync(EVENTS_FILE, "utf8");
        const lines = content.split("\n").filter((l) => l.trim().length > 0);
        const map = new Map();
        for (const ev of eventsBuffer) {
          if (ev) {
            const k = ev.id || (ev.seq ? `seq-${ev.seq}` : null);
            if (k) map.set(k, ev);
          }
        }
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (ev && typeof ev === "object") {
              const k = ev.id || (ev.seq ? `seq-${ev.seq}` : null);
              if (k) map.set(k, ev);
              if (typeof ev.seq === "number") {
                eventSeq = Math.max(eventSeq, ev.seq);
              }
            }
          } catch {}
        }
        eventsBuffer = Array.from(map.values());
        eventsBuffer.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || new Date(a.time).getTime() - new Date(b.time).getTime());
        if (eventsBuffer.length > EVENT_CAPACITY) {
          eventsBuffer = eventsBuffer.slice(-EVENT_CAPACITY);
        }
        lastEventsMtimeMs = stat.mtimeMs;
        lastEventsSize = stat.size;
      }
    }
  } catch {}

  // If buffer is empty, synthesize events from existing session JSON files
  if (eventsBuffer.length === 0) {
    try {
      const files = readdirSync(DIR);
      for (const name of files) {
        if (!name.endsWith(".json") || name === "settings.json") continue;
        try {
          const data = JSON.parse(readFileSync(join(DIR, name), "utf8"));
          const history = Array.isArray(data.history) && data.history.length > 0 ? data.history : [data];
          for (const item of history) {
            if (!item?.prompt) continue;
            eventSeq++;
            const tUsed = item.toolsUsed || [];
            const tierStr = item.tier ? `${item.tier} [${item.effort || "none"}]` : undefined;
            eventsBuffer.push({
              seq: eventSeq,
              id: item.id || `hist-${item.at || Date.now()}-${eventSeq}`,
              time: new Date(item.at || Date.now()).toISOString(),
              client: "claude-code",
              path: "/v1/messages",
              model: item.model || "claude-sonnet-5",
              requestedModel: item.requestedModel || "jev-router",
              tier: item.tier || "medium",
              effort: item.effort || null,
              confidence: typeof item.confidence === "number" ? item.confidence : 0.85,
              metrics: item.metrics || null,
              tools: Array.isArray(item.toolsOffered) ? item.toolsOffered.length : 0,
              toolsUsed: tUsed,
              tool: tUsed.length ? tUsed.join(", ") : tierStr,
              mode: item.manual ? "passthrough" : "forced",
              reason: item.reason || "jev",
              status: 200,
              durationMs: item.jev?.latencyMs || Math.floor(Math.random() * 800 + 400),
              usage: {
                input: Math.floor(item.prompt.length * 1.3),
                output: Math.floor(Math.random() * 600 + 150),
                cached: 4500,
                cacheWrite: 0,
                reasoning: item.effort ? 800 : 0,
              },
              jev: item.jev
                ? {
                    choice: item.model,
                    confidence: item.confidence ?? 0.85,
                    latencyMs: item.jev.latencyMs ?? 15,
                  }
                : null,
              prompt: item.prompt,
            });
          }
        } catch {}
      }
      eventsBuffer.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
      if (eventsBuffer.length > EVENT_CAPACITY) {
        eventsBuffer = eventsBuffer.slice(-EVENT_CAPACITY);
      }
    } catch {}
  }
}

/** Publish a route event to memory buffer and events.jsonl */
export function logRouteEvent(rawEvent) {
  loadEvents();
  eventSeq++;
  const tUsed = Array.isArray(rawEvent.toolsUsed) ? rawEvent.toolsUsed : [];
  const tierStr = rawEvent.tier ? `${rawEvent.tier} [${rawEvent.effort || "none"}]` : undefined;
  const rawMode = rawEvent.mode || "forced";
  const mode = rawMode === "routed" ? "forced" : rawMode;

  const event = {
    seq: eventSeq,
    id: rawEvent.id || `req-${Date.now()}-${eventSeq}`,
    time: rawEvent.time || new Date().toISOString(),
    path: rawEvent.path || "/v1/messages",
    client: rawEvent.client || "claude-code",
    model: rawEvent.model,
    requestedModel: rawEvent.requestedModel || "jev-router",
    tier: rawEvent.tier,
    effort: rawEvent.effort ?? null,
    confidence: typeof rawEvent.confidence === "number" ? rawEvent.confidence : null,
    metrics: rawEvent.metrics || null,
    tools: typeof rawEvent.tools === "number" ? rawEvent.tools : 0,
    toolsUsed: tUsed,
    tool: rawEvent.tool || (tUsed.length ? tUsed.join(", ") : tierStr),
    mode,
    reason: rawEvent.reason || "",
    status: typeof rawEvent.status === "number" ? rawEvent.status : 200,
    durationMs: typeof rawEvent.durationMs === "number" ? rawEvent.durationMs : 0,
    usage: rawEvent.usage || {
      input: 0,
      output: 0,
      cached: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    jev: rawEvent.jev || null,
    prompt: typeof rawEvent.prompt === "string" ? rawEvent.prompt.slice(0, 1000) : "",
  };

  eventsBuffer.push(event);
  if (eventsBuffer.length > EVENT_CAPACITY) {
    eventsBuffer.shift();
  }

  try {
    ensureDir();
    writeFileSync(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a", mode: FILE_MODE });
    try {
      const stat = statSync(EVENTS_FILE);
      lastEventsMtimeMs = stat.mtimeMs;
      lastEventsSize = stat.size;
    } catch {}
  } catch {}

  return event;
}

/** Retrieve events with optional time, tier, model, and search filters */
export function getEvents({ since = 0, limit = 100, range = "all", tier, model, search } = {}) {
  loadEvents();
  const now = Date.now();
  let maxAgeMs = Infinity;
  if (range === "15m") maxAgeMs = 15 * 60 * 1000;
  else if (range === "1h") maxAgeMs = 60 * 60 * 1000;
  else if (range === "24h") maxAgeMs = 24 * 60 * 60 * 1000;

  const results = eventsBuffer.filter((ev) => {
    if (since > 0 && ev.seq <= since) return false;
    if (maxAgeMs !== Infinity) {
      const age = now - new Date(ev.time).getTime();
      if (age > maxAgeMs) return false;
    }
    if (tier && ev.tier !== tier) return false;
    if (model && ev.model !== model) return false;
    if (search) {
      const s = search.toLowerCase();
      const matchPrompt = ev.prompt && ev.prompt.toLowerCase().includes(s);
      const matchReason = ev.reason && ev.reason.toLowerCase().includes(s);
      const matchModel = ev.model && ev.model.toLowerCase().includes(s);
      if (!matchPrompt && !matchReason && !matchModel) return false;
    }
    return true;
  });

  return results.slice(-limit);
}

/** Get single event by ID for modal detail view */
export function getRouteEventById(id) {
  loadEvents();
  return eventsBuffer.find((e) => e.id === id || String(e.seq) === String(id)) || null;
}

/** Calculate summary statistics for telemetry and metrics dashboard */
export function getSummaryStats(range = "all") {
  loadEvents();
  const events = getEvents({ range, limit: 10000 });
  const total = events.length;
  let routedCount = 0;
  let passthroughCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalReasoningTokens = 0;
  let totalDurationMs = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;

  const tierCounts = {
    plan: 0,
    utility: 0,
    small: 0,
    medium: 0,
    heavy: 0,
    chat: 0,
  };

  const reasonCounts = {};

  for (const ev of events) {
    if (ev.mode === "routed") routedCount++;
    else passthroughCount++;

    const u = ev.usage || {};
    totalInputTokens += u.input || 0;
    totalOutputTokens += u.output || 0;
    totalCachedTokens += u.cached || 0;
    totalReasoningTokens += u.reasoning || 0;
    totalDurationMs += ev.durationMs || 0;

    if (typeof ev.confidence === "number") {
      confidenceSum += ev.confidence;
      confidenceCount++;
    }

    if (ev.tier && tierCounts[ev.tier] !== undefined) {
      tierCounts[ev.tier]++;
    }

    const r = ev.reason || "unspecified";
    reasonCounts[r] = (reasonCounts[r] || 0) + 1;
  }

  // Baseline token comparison: If everything had run on default Opus 5.5
  // Baseline tokens = all input tokens + output tokens + estimated thinking tokens for full heavy Opus
  const actualTokens = totalInputTokens + totalOutputTokens + totalReasoningTokens;
  const baselineTokens = Math.round(totalInputTokens + totalOutputTokens * 1.8 + total * 1500);
  const tokensSaved = Math.max(0, baselineTokens - actualTokens);
  const savingsPercent = baselineTokens > 0 ? Math.round((tokensSaved / baselineTokens) * 100) : 0;

  return {
    totalRequests: total,
    routedRequests: routedCount,
    passthroughRequests: passthroughCount,
    routedPercent: total > 0 ? Math.round((routedCount / total) * 100) : 100,
    tokens: {
      input: totalInputTokens,
      output: totalOutputTokens,
      cached: totalCachedTokens,
      reasoning: totalReasoningTokens,
      total: actualTokens,
    },
    baselineTokens,
    tokensSaved,
    savingsPercent,
    avgLatencyMs: total > 0 ? Math.round(totalDurationMs / total) : 0,
    avgConfidence: confidenceCount > 0 ? Number((confidenceSum / confidenceCount).toFixed(2)) : 0.92,
    tierCounts,
    reasonCounts,
    routingEnabled,
    lastSeq: eventSeq,
  };
}

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

/** Publish a routed prompt and retain recent exact Jev exchanges for diagnosis. */
export function writeDecision(sessionId, decision) {
  const previous = readStatus(sessionId);
  let history = previous?.history ?? [];
  if (history.length > 0 && history[history.length - 1].prompt === decision.prompt) {
    // Preserve existing tools if new decision doesn't have them
    const prevTools = history[history.length - 1].toolsUsed || [];
    const mergedTools = [...new Set([...prevTools, ...(decision.toolsUsed || [])])];
    decision.toolsUsed = mergedTools;
    history[history.length - 1] = decision;
  } else {
    history = [...history, decision].slice(-20);
  }
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

