import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function runExample(file) {
  return spawnSync(process.execPath, [join(ROOT, "examples", "orchestrator", file), "--offline"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, JEV_API_KEY: "", TYPESAFE_API_KEY: "" },
  });
}

test("native orchestrator example runs offline and prints its routed tier", () => {
  const result = runExample("run-native.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Native pattern: tier=sonnet model=toy-balanced-v1/);
  assert.match(result.stdout, /Native pattern: tier=opus model=toy-strong-v1/);
});

test("proxy orchestrator example runs offline, points its child at the proxy, and shuts down", () => {
  const result = runExample("run-proxy.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Proxy pattern: pointed child at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /Toy child received base URL: http:\/\/127\.0\.0\.1:\d+/);
  assert.match(result.stdout, /Toy child upstream model: toy-balanced-v1/);
});
