#!/usr/bin/env node
import express from "express";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import {
  STATUS_DIR,
  getEvents,
  getSummaryStats,
  getRouteEventById,
  setRoutingEnabled,
  isRoutingEnabled,
} from "../src/status.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// CLI Argument & Help Handling
const args = process.argv.slice(2);
function printHelp() {
  console.log(`
Usage: jev-dashboard [options] [port]

Description:
  Standalone real-time Web UI dashboard for jev-router telemetry & Claude Code model routing.

Options:
  -p, --port <port>   Port to listen on (default: $JEV_DASHBOARD_PORT or $PORT or 8790)
  -h, --help          Show this help message

Environment Variables:
  JEV_DASHBOARD_PORT  Port number for web dashboard
  PORT                Fallback port number for web dashboard

Examples:
  jev-dashboard
  jev-dashboard 8790
  jev-dashboard -p 8790
  jev-dashboard --port 9000
  PORT=8800 jev-dashboard
`);
}

let portArg = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    printHelp();
    process.exit(0);
  }
  if (arg === "-p" || arg === "--port") {
    portArg = args[i + 1];
    i++;
  } else if (/^\d+$/.test(arg)) {
    portArg = arg;
  }
}

const PORT = parseInt(
  portArg || process.env.JEV_DASHBOARD_PORT || process.env.PORT || "8790",
  10
);

if (isNaN(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[jev-dashboard] Error: Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

const LOG_FILE = join(homedir(), ".jev-claude.log");
const HTML_FILE = join(__dirname, "..", "src", "dashboard.html");
const startedAt = new Date().toISOString();

const app = express();
app.use(express.json());

// CORS for local origins
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  next();
});

// 1. Events endpoint for real-time telemetry stream
app.get(["/events", "/dashboard/events"], (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const since = Number(req.query.since || 0);
  const events = getEvents({ since, limit: 500 });
  const stats = getSummaryStats("all");

  res.json({
    router: {
      client: "claude-code",
      upstream: "https://api.anthropic.com",
      jevModel: "claude-6-tier-matrix",
      jevProvider: "typesafe-ai",
      minConfidence: 0.3,
      routing: isRoutingEnabled(),
      startedAt,
      now: new Date().toISOString(),
      recorded: stats.lastSeq || events.length,
    },
    events,
  });
});

// 2. Toggle routing switch on/off (supports both /routing and /api/routing)
app.post(["/routing", "/api/routing"], (req, res) => {
  const enabled =
    req.query.enabled !== undefined
      ? req.query.enabled === "true"
      : req.body?.enabled !== undefined
        ? Boolean(req.body.enabled)
        : !isRoutingEnabled();
  setRoutingEnabled(enabled);
  res.json({ routing: isRoutingEnabled() });
});

// 3. Stats and search APIs
app.get("/api/stats", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getSummaryStats(req.query.range || "all"));
});

app.get("/api/logs", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { range = "all", tier, model, search, limit = 100 } = req.query;
  const events = getEvents({
    range,
    tier: tier && tier !== "all" ? tier : undefined,
    model: model && model !== "all" ? model : undefined,
    search: search ? String(search) : undefined,
    limit: Number(limit) || 100,
  });
  res.json(events);
});

app.get("/api/logs/:id", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const event = getRouteEventById(req.params.id);
  if (!event) return res.status(404).json({ error: "Log entry not found" });
  res.json(event);
});

// 4. Main Dashboard Web UI
app.get(["/", "/dashboard"], (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.sendFile(HTML_FILE);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[jev-dashboard] Express server listening on http://127.0.0.1:${PORT}`);
});
