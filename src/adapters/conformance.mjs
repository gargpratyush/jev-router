import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readStatus, STATUS_DIR } from "../lib/status.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

/**
 * Register the HTTP-level contract every harness adapter must satisfy.
 *
 * Required options:
 * - name: label used in emitted test titles.
 * - startProxy({ upstreamURL, route, statusId }): harness-specific proxy starter wrapper.
 * - routingPath/catalogPath: client-facing paths for turns and model discovery.
 * - sentinelModel/resolvedModel/resolvedTier/manualModel: expected model identities.
 * - catalogResponse/expectedCatalogModelIds: upstream catalog fixture and the exact ids
 *   expected in the route function after ingestion.
 * - makeRoutingRequest/makeToolContinuation/makeExplainRequest/makeManualRequest:
 *   functions receiving { model, prompt, statusId } and returning harness wire bodies.
 * - authHeaders: headers whose exact values must reach the stub upstream.
 *
 * Optional options:
 * - getForwardedModel(body): extracts the model from an upstream body (defaults to body.model).
 * - expectedFallbackModel: the exact model the adapter must forward when the router is
 *   unavailable on a cold start (the strong tier). Without it, the fallback is only checked
 *   for being a real model id rather than the sentinel or nothing.
 * - skip: map of invariant keys to a boolean or reason string. Keys are sentinel, catalog,
 *   status, explain, fallback, manual, manualStatus, and fidelity. Opt-outs are visible
 *   skipped tests, never silent omissions.
 */
export function runAdapterConformance({
  name,
  startProxy,
  routingPath,
  catalogPath,
  sentinelModel,
  resolvedModel,
  resolvedTier,
  manualModel,
  catalogResponse,
  expectedCatalogModelIds,
  makeRoutingRequest,
  makeToolContinuation,
  makeExplainRequest,
  makeManualRequest,
  authHeaders,
  getForwardedModel = (body) => body.model,
  expectedFallbackModel,
  skip = {},
}) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const statusIdFor = (invariant) => `conformance-${slug}-${invariant}-${process.pid}`;
  const decision = {
    choice: resolvedModel,
    confidence: 0.87,
    ms: 1,
    request: { conformance: true },
    response: { choice: resolvedModel },
  };

  const define = (key, title, fn) => {
    const optOut = skip[key];
    if (optOut) {
      test(`${name} adapter conformance: ${title}`, {
        skip: typeof optOut === "string" ? optOut : `${key} is inapplicable to ${name}`,
      }, fn);
      return;
    }
    test(`${name} adapter conformance: ${title}`, fn);
  };

  async function fixture(t, { statusId, route, response } = {}) {
    const seen = [];
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const entry = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: raw ? JSON.parse(raw) : null,
        };
        seen.push(entry);

        if (req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "")) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(catalogResponse));
          return;
        }

        const reply = response ?? {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        };
        res.writeHead(reply.statusCode, reply.headers);
        res.end(reply.body);
      });
    });
    await listen(upstream);

    const upstreamURL = `http://127.0.0.1:${upstream.address().port}`;
    const proxy = await startProxy({ upstreamURL, route, statusId });
    t.after(() => {
      proxy.close();
      upstream.close();
      if (statusId) {
        const safeId = statusId.replace(/[^\w-]/g, "");
        rmSync(join(STATUS_DIR, `${safeId}.json`), { force: true });
      }
    });
    return { baseURL: `http://127.0.0.1:${proxy.port}`, seen };
  }

  const request = async (baseURL, body, headers = authHeaders) => {
    const response = await fetch(`${baseURL}${routingPath}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    response.bodyText = await response.text();
    return response;
  };

  const loadCatalog = async (baseURL) => {
    const response = await fetch(`${baseURL}${catalogPath}`, { headers: authHeaders });
    await response.arrayBuffer();
    return response;
  };

  define("sentinel", "rewrites the sentinel on routed and follow-up turns", async (t) => {
    const statusId = statusIdFor("sentinel");
    const routeCalls = [];
    const { baseURL, seen } = await fixture(t, {
      statusId,
      route: async (input) => {
        routeCalls.push(input);
        return decision;
      },
    });
    await loadCatalog(baseURL);

    const prompt = "conformance first routed turn";
    await request(baseURL, makeRoutingRequest({ model: sentinelModel, prompt, statusId }));
    await request(baseURL, makeToolContinuation({ model: sentinelModel, prompt, statusId }));
    await request(baseURL, makeExplainRequest({ model: sentinelModel, prompt, statusId }));

    const turns = seen.filter(({ method, url }) => method === "POST" && url.includes(routingPath));
    assert.equal(routeCalls.length, 1, "only the genuinely new turn consults the router");
    assert.equal(turns.length, 3);
    assert.deepEqual(turns.map(({ body }) => getForwardedModel(body)), [
      resolvedModel,
      resolvedModel,
      resolvedModel,
    ]);
    assert.equal(
      turns.some(({ body }) => getForwardedModel(body) === sentinelModel),
      false,
      "the sentinel never reaches upstream",
    );
  });

  define("catalog", "ingests the upstream model catalog", async (t) => {
    const statusId = statusIdFor("catalog");
    const routeCalls = [];
    const { baseURL } = await fixture(t, {
      statusId,
      route: async (input) => {
        routeCalls.push(input);
        return decision;
      },
    });

    await loadCatalog(baseURL);
    await request(baseURL, makeRoutingRequest({
      model: sentinelModel,
      prompt: "catalog-backed route",
      statusId,
    }));

    assert.equal(routeCalls.length, 1);
    assert.deepEqual(
      routeCalls[0].models.map(({ id }) => id),
      expectedCatalogModelIds,
      "the route input must come from the fetched catalog, not cold-start defaults",
    );
  });

  define("status", "files the routed decision under the harness status id", async (t) => {
    const statusId = statusIdFor("status");
    const prompt = "status filing conformance prompt";
    const { baseURL } = await fixture(t, {
      statusId,
      route: async () => decision,
    });

    await loadCatalog(baseURL);
    await request(baseURL, makeRoutingRequest({ model: sentinelModel, prompt, statusId }));

    const status = readStatus(statusId);
    assert.ok(status, "the adapter status id must resolve to a written decision");
    assert.equal(status.tier, resolvedTier);
    assert.equal(status.model, resolvedModel);
    assert.equal(status.confidence, decision.confidence);
    assert.equal(status.prompt, prompt);
  });

  define("explain", "an explanation turn leaves the recorded decision untouched", async (t) => {
    const statusId = statusIdFor("explain");
    const prompt = "explain conformance prompt";
    const { baseURL } = await fixture(t, { statusId, route: async () => decision });

    await loadCatalog(baseURL);
    await request(baseURL, makeRoutingRequest({ model: sentinelModel, prompt, statusId }));
    const before = readStatus(statusId);
    await request(baseURL, makeExplainRequest({ model: sentinelModel, prompt, statusId }));

    assert.deepEqual(readStatus(statusId), before, "the decision being explained must survive");
  });

  define("fallback", "falls back to a real model when the router is unavailable", async (t) => {
    const statusId = statusIdFor("fallback");
    const { baseURL, seen } = await fixture(t, { statusId, route: async () => null });

    await loadCatalog(baseURL);
    await request(baseURL, makeRoutingRequest({ model: sentinelModel, prompt: "fallback prompt", statusId }));

    const turn = seen.find(({ method, url }) => method === "POST" && url.includes(routingPath));
    const forwarded = getForwardedModel(turn.body);
    assert.equal(typeof forwarded, "string");
    assert.ok(forwarded, "getDefaultModel must return a model id");
    assert.notEqual(forwarded, sentinelModel, "the sentinel never reaches upstream");
    if (expectedFallbackModel !== undefined) {
      assert.equal(forwarded, expectedFallbackModel, "the fallback must be a model the account's catalog lists");
    }
  });

  define("manual", "passes manual model choices through without routing", async (t) => {
    const statusId = statusIdFor("manual");
    let routeCalls = 0;
    const { baseURL, seen } = await fixture(t, {
      statusId,
      route: async () => {
        routeCalls++;
        return decision;
      },
    });

    await request(baseURL, makeManualRequest({ model: manualModel, statusId }));

    const turn = seen.find(({ method }) => method === "POST");
    assert.equal(routeCalls, 0);
    assert.equal(getForwardedModel(turn.body), manualModel);
  });

  define("manualStatus", "records a manual model choice as manual", async (t) => {
    const statusId = statusIdFor("manual-status");
    const { baseURL } = await fixture(t, { statusId, route: async () => decision });

    await request(baseURL, makeManualRequest({ model: manualModel, statusId }));

    assert.equal(readStatus(statusId)?.manual, true, "isManualChoice must mark a real manual turn");
  });

  define("fidelity", "preserves auth and upstream response metadata", async (t) => {
    const statusId = statusIdFor("fidelity");
    const { baseURL, seen } = await fixture(t, {
      statusId,
      route: async () => decision,
      response: {
        statusCode: 207,
        headers: {
          "content-type": "application/json",
          "x-conformance-upstream": "preserved",
        },
        body: JSON.stringify({ from: "upstream" }),
      },
    });

    await loadCatalog(baseURL);
    const response = await request(
      baseURL,
      makeRoutingRequest({
        model: sentinelModel,
        prompt: "auth and response fidelity conformance prompt",
        statusId,
      }),
    );

    const turn = seen.find(({ method }) => method === "POST");
    for (const [header, value] of Object.entries(authHeaders)) {
      assert.equal(turn.headers[header.toLowerCase()], value);
    }
    assert.equal(response.status, 207);
    assert.equal(response.headers.get("x-conformance-upstream"), "preserved");
    assert.equal(response.bodyText, JSON.stringify({ from: "upstream" }), "the upstream body must arrive intact");
  });
}
