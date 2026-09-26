import { homedir } from "node:os";
import { join } from "node:path";
import { TIERS, tierSpec } from "../src/config.mjs";

for (const file of [
  join(process.cwd(), ".env"),
  join(homedir(), ".jev-router.env"),
  join(homedir(), ".jev-claude.env"),
  "D:/learn/gemini-mcp/gemini-blogdee-subdomain/credentials/typesafe-credential.txt",
]) {
  try {
    process.loadEnvFile(file);
  } catch {}
}

if (!process.env.JEV_API_KEY && !process.env.TYPESAFE_API_KEY) {
  try {
    const fs = await import("node:fs");
    const key = fs.readFileSync("D:/learn/gemini-mcp/gemini-blogdee-subdomain/credentials/typesafe-credential.txt", "utf8").trim();
    if (key) process.env.TYPESAFE_API_KEY = key;
  } catch {}
}

const { askJev } = await import("../src/router.mjs");

const testCases = [
  { tier: "chat", task: "Chat", prompt: "Hello, how are you today?" },
  { tier: "small", task: "Small task", prompt: "Fix the typo 'recieve' in README.md line 24" },
  { tier: "utility", task: "Utility", prompt: "List all database tables in the ecms schema and explain their relationships" },
  { tier: "medium", task: "Medium task", prompt: "Implement user session expiration handling with JWT and add unit tests" },
  { tier: "plan", task: "Plan", prompt: "Design an architectural plan and roadmap to migrate from monolithic REST to event-driven GraphQL microservices" },
  { tier: "heavy", task: "Heavy task", prompt: "Diagnose and fix a subtle distributed race condition deadlock across multi-region worker queues" },
];

console.log("Testing 6-Tier Live Jev Routing Matrix:\n");

for (const tc of testCases) {
  const ans = await askJev({ prompt: tc.prompt, current: "medium", contextTokens: 0, models: TIERS });
  if (!ans) {
    console.log(`[FAIL] ${tc.task}: Jev call returned null`);
    continue;
  }
  const spec = tierSpec(ans.choice);
  const pass = ans.choice === tc.tier ? "✓ PASS" : "✗ MISMATCH";
  const effortStr = spec?.effort ? `effort: ${spec.effort}` : "no effort";
  console.log(`${pass} | Expected: ${tc.tier.padEnd(7)} | Routed: ${ans.choice.padEnd(7)} (${(ans.confidence * 100).toFixed(0)}%) | Model: ${spec.id} (${effortStr}) | ${ans.ms}ms`);
}
