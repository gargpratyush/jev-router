import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createJevClient, describeMissingJev, resolveJevProvider } from "../src/jev-client.mjs";

const RETRY = { maxRetries: 1, backoffInitialMs: 1, backoffMaxMs: 1 };

async function fakeOpenRouter(responses) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ headers: req.headers, body: JSON.parse(body) });
      const { status, json } = responses[Math.min(requests.length - 1, responses.length - 1)];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/decisions`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function openRouterEnv(url) {
  return { OPENROUTER_API_KEY: "sk-or-test", JEV_OPENROUTER_URL: url };
}

test("resolveJevProvider prefers a TypeSafe key when both are present", () => {
  // Act
  const resolved = resolveJevProvider({ JEV_API_KEY: "ts", OPENROUTER_API_KEY: "or" });

  // Assert
  assert.deepEqual(resolved, { provider: "typesafe", apiKey: "ts" });
});

test("resolveJevProvider falls back to OpenRouter when only its key is present", () => {
  // Act
  const resolved = resolveJevProvider({ OPENROUTER_API_KEY: "or" });

  // Assert
  assert.deepEqual(resolved, { provider: "openrouter", apiKey: "or" });
});

test("resolveJevProvider honours an explicit JEV_PROVIDER over key precedence", () => {
  // Act
  const resolved = resolveJevProvider({ JEV_PROVIDER: "OpenRouter", JEV_API_KEY: "ts", OPENROUTER_API_KEY: "or" });

  // Assert
  assert.deepEqual(resolved, { provider: "openrouter", apiKey: "or" });
});

test("resolveJevProvider returns null when the requested provider has no key", () => {
  // Act
  const resolved = resolveJevProvider({ JEV_PROVIDER: "openrouter", JEV_API_KEY: "ts" });

  // Assert
  assert.equal(resolved, null);
  assert.match(describeMissingJev({ JEV_PROVIDER: "openrouter" }), /no OPENROUTER_API_KEY/);
});

test("resolveJevProvider rejects an unknown JEV_PROVIDER", () => {
  // Arrange
  const env = { JEV_PROVIDER: "bedrock", JEV_API_KEY: "ts" };

  // Act & Assert
  assert.equal(resolveJevProvider(env), null);
  assert.match(describeMissingJev(env), /JEV_PROVIDER=bedrock is not one of/);
});

test("resolveJevProvider returns null with no keys at all", () => {
  // Act & Assert
  assert.equal(resolveJevProvider({}), null);
  assert.match(describeMissingJev({}), /no JEV_API_KEY or OPENROUTER_API_KEY/);
});

test("createJevClient builds the TypeSafe SDK client for the typesafe provider", () => {
  // Act
  const client = createJevClient({ timeout: 100, retry: RETRY, env: { JEV_API_KEY: "ts" } });

  // Assert
  assert.ok(client instanceof TypeSafeClient);
});

test("createJevClient throws when nothing is configured", () => {
  // Act & Assert
  assert.throws(() => createJevClient({ timeout: 100, retry: RETRY, env: {} }), /no JEV_API_KEY/);
});

test("OpenRouter client pins the TypeSafe provider and returns the answers", async () => {
  // Arrange
  const answers = { model: { choice: "haiku", confidence: 0.9 } };
  const server = await fakeOpenRouter([{ status: 200, json: { answers } }]);
  const client = createJevClient({ timeout: 1000, retry: RETRY, env: openRouterEnv(server.url) });

  // Act
  const result = await client.systemOne({ state: { request: "hi" }, questions: {} });
  await server.close();

  // Assert
  assert.deepEqual(result.answers, answers);
  const [{ headers, body }] = server.requests;
  assert.equal(headers.authorization, "Bearer sk-or-test");
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.deepEqual(body.provider, { only: ["typesafe"], allow_fallbacks: false });
  assert.deepEqual(body.state, { request: "hi" });
});

test("OpenRouter client retries a 5xx and succeeds on the next attempt", async () => {
  // Arrange
  const server = await fakeOpenRouter([
    { status: 503, json: { error: "busy" } },
    { status: 200, json: { answers: {} } },
  ]);
  const client = createJevClient({ timeout: 1000, retry: RETRY, env: openRouterEnv(server.url) });

  // Act
  const result = await client.systemOne({ state: {}, questions: {} });
  await server.close();

  // Assert
  assert.deepEqual(result.answers, {});
  assert.equal(server.requests.length, 2);
});

test("OpenRouter client does not retry a 4xx", async () => {
  // Arrange
  const server = await fakeOpenRouter([{ status: 401, json: { error: "bad key" } }]);
  const client = createJevClient({ timeout: 1000, retry: RETRY, env: openRouterEnv(server.url) });

  // Act & Assert
  await assert.rejects(client.systemOne({ state: {}, questions: {} }), /HTTP 401/);
  await server.close();
  assert.equal(server.requests.length, 1);
});

test("OpenRouter client rejects a response without answers", async () => {
  // Arrange
  const server = await fakeOpenRouter([{ status: 200, json: { error: "nope" } }]);
  const client = createJevClient({ timeout: 1000, retry: RETRY, env: openRouterEnv(server.url) });

  // Act & Assert
  await assert.rejects(client.systemOne({ state: {}, questions: {} }), /no answers/);
  await server.close();
  assert.equal(server.requests.length, 1);
});

test("OpenRouter client stops when the caller aborts", async () => {
  // Arrange
  const server = await fakeOpenRouter([{ status: 200, json: { answers: {} } }]);
  const client = createJevClient({ timeout: 1000, retry: RETRY, env: openRouterEnv(server.url) });
  const abort = new AbortController();
  abort.abort();

  // Act & Assert
  await assert.rejects(client.systemOne({ state: {}, questions: {} }, { signal: abort.signal }));
  await server.close();
  assert.equal(server.requests.length, 0);
});
