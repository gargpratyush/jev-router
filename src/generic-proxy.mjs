import http from "node:http";
import https from "node:https";
import { writeFileSync } from "node:fs";
import { askJev } from "./lib/router.mjs";
import { routeTurn, upgradeToFit } from "./lib/route-turn.mjs";
import { log } from "./lib/log.mjs";
import { defaultStore } from "./lib/status.mjs";
import { validateAdapter } from "./adapters/index.mjs";

const debug = (line) => process.env.JEV_DEBUG && log(line);

// The reserved explanation marker: the Claude skill's tag anywhere, or the Codex skill name
// as the first word. A prompt that merely mentions the skill name is still routed.
const isExplainPrompt = (prompt) =>
  !!prompt && (prompt.includes("<jev-explain>") || /^\$jev-explain\b/i.test(prompt));

/**
 * Generic proxy that accepts a harness adapter.
 *
 * Each harness (Claude, Codex, Agent Orchestrator, etc.) has a different wire protocol
 * for requests and responses. This proxy owns the routing pipeline once and delegates the
 * protocol details to an adapter; proxy.mjs and codex-proxy.mjs are the two bundled ones.
 *
 * The adapter must provide:
 *
 *   - isRoutingRequest(req, body) → boolean: Is this a turn we should route?
 *   - conversationKey(body) → string: Stable identifier for deduping the conversation.
 *   - newTurnPrompt(body) → string | null: The user's prompt, or null for tool continuations.
 *   - normalizeRequest(body) → void (optional): Normalize every parsed request body.
 *   - getModels(catalog) → {id, tier, description}[]: Available models for this harness.
 *   - applyTier(body, tier, model) → body: Mutate the request for this tier.
 *   - getDefaultModel(tier) → string: Fallback model id for a tier.
 *   - decorateModelCatalog(catalog, catalogMap) → void (optional): Ingest/decorate a model catalog.
 *   - decorateResponse(res, response, routing) → void (optional): Inject harness-specific feedback.
 *   - isManualChoice(req, body) → boolean (optional): A real turn on a model the user picked.
 *   - contextTokens(body) → number (optional): Context estimate; defaults to a size heuristic.
 *   - requestTokens(body) → number (optional): Whole-request size, checked against each
 *     model's maxInputTokens; defaults to contextTokens.
 *   - upstreamErrorBody(message) → object (optional): The harness's error shape for a 502.
 *   - contextWindow: tokens in the harness's context (200000 for Anthropic, etc).
 *   - statusId (optional): A fixed id or (body, conversationKey) → id for status writes.
 *
 * upstreamURL may be a fixed string or a (req) → string resolver. `store` is where decisions
 * are recorded; it defaults to the shared $TMPDIR/jev-claude store that jev-explain reads.
 */
export async function genericProxy({
  adapter,
  upstreamURL,
  route = askJev,
  catalog = new Map(),
  store = defaultStore,
} = {}) {
  validateAdapter(adapter);

  // Tier routed for each conversation's turn in flight, reused by its follow-ups.
  const conversations = new Map();
  const stateFor = (key) => {
    let s = conversations.get(key);
    if (!s) {
      if (conversations.size > 50) conversations.delete(conversations.keys().next().value);
      conversations.set(key, (s = { tier: null, model: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Probes (HEAD requests for Claude, others) should pass through.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      let routing = null; // For response decoration

      try {
        const body = JSON.parse(out.toString());

        if (process.env.JEV_DUMP) {
          writeFileSync(`${process.env.JEV_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
        }

        adapter.normalizeRequest?.(body);

        if (adapter.isRoutingRequest?.(req, body)) {
          const key = adapter.conversationKey?.(body);
          const state = stateFor(key);
          const current = state.tier ?? "opus";
          const prompt = adapter.newTurnPrompt?.(body);
          const explaining = isExplainPrompt(prompt);

          if (prompt && !explaining) {
            const models = adapter.getModels?.(catalog) ?? [];
            const currentModel = state.model ?? adapter.getDefaultModel?.(current);
            const contextTokens = adapter.contextTokens
              ? adapter.contextTokens(body)
              : Math.round(JSON.stringify(body.messages ?? body.input ?? "").length / 4);
            const requestTokens = adapter.requestTokens?.(body) ?? contextTokens;
            const statusKey =
              typeof adapter.statusId === "function"
                ? adapter.statusId(body, key)
                : adapter.statusId || "";
            let jev;
            const decision = await routeTurn({
              prompt,
              current,
              currentModel,
              models,
              contextTokens,
              requestTokens,
              contextWindow: adapter.contextWindow,
              statusId: statusKey,
              getDefaultModel: (tier) => adapter.getDefaultModel?.(tier),
              route: async (input) => (jev = await route(input)),
              store,
            });
            state.tier = decision.tier;
            state.model = decision.model;
            routing = {
              prompt,
              model: decision.model,
              confidence: decision.confidence,
              metrics: decision.metrics,
              reason: decision.reason,
              jev: decision.jev,
              at: decision.at,
            };
            debug(
              `${key} ${jev ? `${jev.ms}ms p=${jev.confidence.toFixed(2)}` : "no-jev"} ` +
                `${current} -> ${decision.tier} (${decision.reason}) ctx~${contextTokens} req~${requestTokens} | ${prompt.slice(0, 60)}`,
            );

          }
          // An explain turn writes nothing: the decision it explains must still be on disk.

          // A turn in flight can outgrow its model: one large tool result is enough. Move it
          // to the cheapest model that fits rather than let the API reject it as too long.
          if (!prompt && state.model && adapter.requestTokens) {
            const moved = upgradeToFit({
              models: adapter.getModels?.(catalog) ?? [],
              tier: state.tier ?? current,
              model: state.model,
              requestTokens: adapter.requestTokens(body),
            });
            if (moved) {
              debug(`${key} outgrew ${state.model}; continuing on ${moved.model}`);
              state.tier = moved.tier;
              state.model = moved.model;
            }
          }

          // The sentinel is not a real model, so every routed request must be rewritten.
          const tier = state.tier ?? current;
          const model = state.model ?? adapter.getDefaultModel?.(tier);
          adapter.applyTier?.(body, tier, model);
        } else {
          // Not a routing request — check if it's an explicit model choice (manual).
          if (adapter.isManualChoice?.(req, body)) {
            const key = adapter.conversationKey?.(body);
            const statusKey =
              typeof adapter.statusId === "function"
                ? adapter.statusId(body, key)
                : adapter.statusId || "";
            store.writeStatus(statusKey, { manual: true, at: Date.now() });
          }
        }

        out = Buffer.from(JSON.stringify(body));
      } catch (err) {
        debug(`generic-proxy: could not process body: ${err.message}`);
      }

      // Proxy the request upstream.
      const resolvedUpstreamURL =
        typeof upstreamURL === "function" ? upstreamURL(req) : upstreamURL;
      const target = new URL(resolvedUpstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      const isModels = req.method === "GET" && /\/models(?:\?|$)/.test(req.url ?? "");
      if (isModels) delete headers["accept-encoding"];
      // Under JEV_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.JEV_DEBUG) delete headers["accept-encoding"];

      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (response) => {
          // Report the model the API itself says it used, so routing can be confirmed from
          // the wire rather than trusted from our own decision log.
          if (process.env.JEV_DEBUG) {
            let seen = false;
            response.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${response.statusCode} served by ${m[1]}`);
            });
          }
          // Special handling for model catalog endpoints.
          if (isModels && adapter.decorateModelCatalog) {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              try {
                const data = Buffer.concat(chunks);
                const modelCatalog = JSON.parse(data.toString());
                adapter.decorateModelCatalog?.(modelCatalog, catalog);
                const newData = Buffer.from(JSON.stringify(modelCatalog));
                const newHeaders = { ...response.headers };
                delete newHeaders["content-length"];
                res.writeHead(response.statusCode, newHeaders);
                res.end(newData);
              } catch (err) {
                debug(`could not decorate model catalog: ${err.message}`);
                res.writeHead(response.statusCode, response.headers);
                res.end(Buffer.concat(chunks));
              }
            });
            return;
          }

          // Allow the adapter to decorate the response (e.g., SSE injection for Codex).
          if (routing && response.statusCode >= 200 && response.statusCode < 300 && adapter.decorateResponse) {
            adapter.decorateResponse?.(res, response, routing);
          } else {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        },
      );

      upstream.on("error", (err) => {
        debug(`upstream error: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        const errorBody = adapter.upstreamErrorBody?.(err.message) ?? {
          error: { message: err.message, type: "proxy_error" },
        };
        res.end(JSON.stringify(errorBody));
      });

      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
