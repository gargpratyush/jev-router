#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import { AUTO_MODEL, defineAdapter, genericProxy } from "jev-router";

const offline = process.argv.includes("--offline");
const models = [
  { id: "toy-fast-v1", tier: "haiku", description: "Fast toy model" },
  { id: "toy-balanced-v1", tier: "sonnet", description: "Balanced toy model" },
  { id: "toy-strong-v1", tier: "opus", description: "Strong toy model" },
];
const defaults = Object.fromEntries(models.map(({ tier, id }) => [tier, id]));
const workload = [
  "Summarize the latest tool result.",
  "Plan a safe refactor across the parser and its tests.",
];

const adapter = defineAdapter({
  contextWindow: 32_000,
  isRoutingRequest: (req, body) => req.method === "POST" && body.model === AUTO_MODEL,
  conversationKey: (body) => body.conversation,
  newTurnPrompt: (body) => body.prompt,
  getModels: () => models,
  getDefaultModel: (tier) => defaults[tier],
  applyTier(body, _tier, model) {
    body.model = model;
  },
});

const offlineRoute = async ({ prompt }) => ({
  choice: prompt.startsWith("Plan") ? "toy-strong-v1" : "toy-balanced-v1",
  confidence: 0.96,
  metrics: null,
  request: { offline: true, prompt },
  response: { offline: true },
  ms: 0,
});

function startStubUpstream() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(Buffer.concat(chunks));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function runToyCli(baseURL) {
  const childProgram = `
    const baseURL = process.env.TOY_BASE_URL;
    const workload = JSON.parse(process.env.TOY_WORKLOAD);
    console.log("Toy child received base URL: " + baseURL);
    for (const prompt of workload) {
      const response = await fetch(baseURL + "/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "${AUTO_MODEL}", conversation: "toy-session", prompt }),
      });
      const body = await response.json();
      console.log("Toy child upstream model: " + body.model);
    }
  `;

  const child = spawn(process.execPath, ["--input-type=module", "-e", childProgram], {
    stdio: "inherit",
    env: { ...process.env, TOY_BASE_URL: baseURL, TOY_WORKLOAD: JSON.stringify(workload) },
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal || code !== 0) reject(new Error(`toy child failed (${signal ?? code})`));
      else resolve();
    });
  });
}

const stub = offline ? await startStubUpstream() : null;
const upstreamURL = stub?.url ?? process.env.TOY_UPSTREAM_URL;
if (!upstreamURL) throw new Error("Set TOY_UPSTREAM_URL or run with --offline");

const proxy = await genericProxy({
  adapter,
  upstreamURL,
  route: offline ? offlineRoute : undefined,
});
const baseURL = `http://127.0.0.1:${proxy.port}`;

try {
  console.log(`Proxy pattern: pointed child at ${baseURL}`);
  await runToyCli(baseURL);
} finally {
  proxy.close();
  await stub?.close();
}
