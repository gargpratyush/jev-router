# Writing a harness adapter

An adapter translates one coding CLI's HTTP protocol into Jev Router's shared routing pipeline. The public runtime is `jev-router`; the reusable HTTP conformance suite is `jev-router/conformance`. The package is ESM-only and requires Node.js 20.12 or newer.

## Two integration patterns: proxy and native

Jev Router supports two ways to put the same per-turn decision into a harness:

- **Proxy pattern:** use `genericProxy` when the harness is an existing CLI or application you do not control, but it accepts a custom API base URL. An adapter recognizes routed requests, and the proxy rewrites the sentinel to a real model before forwarding upstream. See [`examples/orchestrator/run-proxy.mjs`](../examples/orchestrator/run-proxy.mjs).
- **Native pattern:** use `routeTurn` when you control the agent loop, orchestrator, or tool and it already owns the provider call. Pass the prompt, current tier and exact model, available model catalog, context estimate, context window, and a tier-to-default-model resolver. The result contains the chosen `tier`, exact `model`, policy `reason`, confidence, metrics, retained Jev exchange, and timestamp. See [`examples/orchestrator/run-native.mjs`](../examples/orchestrator/run-native.mjs).

Choose native routing when the model-selection point is inside code you own. It avoids a local HTTP hop and lets that code call its provider SDK with the returned exact model ID. Choose the proxy when changing the harness is impractical and its HTTP protocol can be expressed through the adapter contract below.

`routeTurn({ prompt, current, currentModel, models, contextTokens, contextWindow, statusId, getDefaultModel, route })` performs the shared decision only: it filters disabled tiers, calls the injected `route` function (or the core router by default), maps the returned model ID to a tier, applies the policy ladder, resolves the exact model, and records the decision when `statusId` is non-empty. It deliberately does **not** rewrite a request body, manage conversation state, ingest a provider catalog, or decorate a response. Those are harness responsibilities; `genericProxy` and its adapter hooks provide them for the proxy pattern.

The native caller must update its own current tier/model after each decision, estimate context consistently, keep its catalog and default-model mapping accurate, call its provider, and decide how status IDs map to its sessions. The proxy does those protocol and lifecycle jobs around the same `routeTurn` decision.

## The request pipeline

`genericProxy({ adapter, upstreamURL, route, catalog, store })` validates the adapter once, starts a loopback HTTP server, and then handles each request in this order:

1. A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`, or that carries any other `Origin`, receives `403` and goes no further. This keeps web pages out, whether they arrive by DNS rebinding or a cross-site form post, so point a harness at the proxy by loopback address. A `HEAD` probe receives `200` immediately. No adapter hook runs for either.
2. The proxy buffers the request body and tries to parse JSON. If parsing succeeds, `normalizeRequest(body)` runs first when supplied.
3. `isRoutingRequest(req, body)` decides whether the request carries the router's sentinel model. A false result takes the manual-choice branch described below.
4. For a routed request, `conversationKey(body)` finds its routing state and `newTurnPrompt(body)` classifies it:
   - A new user prompt calls `getModels(catalog)` and `getDefaultModel(currentTier)`, then passes those values to `routeTurn`. The chosen tier and exact model are saved. `statusId` selects the status record, then `applyTier(body, tier, model)` must replace the sentinel before forwarding.
   - A tool continuation returns `null` from `newTurnPrompt`. It does not call the router again. `getDefaultModel(tier)` may supply a cold-start model, and `applyTier` rewrites the request with the conversation's saved model.
   - A reserved explanation prompt (one containing `<jev-explain>`, or starting with `$jev-explain`) is not sent to the router and writes no status, so the decision it explains stays on disk. `getDefaultModel` and `applyTier` still ensure that the sentinel is replaced.
5. For a non-routing request, `isManualChoice(req, body)` runs when supplied. If it returns true, `conversationKey` and `statusId` identify the manual-status record. The chosen model and body otherwise pass through unchanged.
6. The parsed body is re-serialized and proxied to `upstreamURL`, which may be a URL string or `(req) => url`. Request headers are retained except that `host` is changed and `content-length` is recalculated.
7. For a `GET` whose path ends in `/models` (optionally followed by a query), the upstream JSON response is buffered. If supplied, `decorateModelCatalog(modelCatalog, catalog)` can add a picker entry and populate the shared catalog before the JSON is returned to the client.
8. After a newly routed turn, a successful 2xx upstream response is handed to `decorateResponse(res, response, routing)` when supplied. That hook owns forwarding and ending the response. Every other response is piped through unchanged.

Malformed or empty JSON bodies skip the body hooks and are forwarded unchanged. If the upstream cannot be reached, the client receives a `502` whose JSON body comes from `upstreamErrorBody(message)` when supplied, else `{ error: { message, type: "proxy_error" } }`. Set `JEV_DEBUG=1` while developing to see parse, decoration, upstream, and routing failures that the proxy deliberately keeps away from a coding CLI's terminal UI.

The resulting call pattern is:

| Request | Hooks that can run |
| --- | --- |
| New routed user turn | `normalizeRequest`, `isRoutingRequest`, `conversationKey`, `newTurnPrompt`, `getModels`, `getDefaultModel`, `statusId`, `applyTier`, then possibly `decorateResponse` |
| Routed tool continuation | `normalizeRequest`, `isRoutingRequest`, `conversationKey`, `newTurnPrompt`, `getDefaultModel`, `applyTier` |
| Routed explanation turn | `normalizeRequest`, `isRoutingRequest`, `conversationKey`, `newTurnPrompt`, `getDefaultModel`, `applyTier` |
| Manual model choice | `normalizeRequest`, `isRoutingRequest`, `isManualChoice`, then `conversationKey` and `statusId` if it is manual |
| Model-catalog fetch | `decorateModelCatalog` on the upstream response; body hooks do not run for the usual bodyless `GET` |

## Adapter contract

The six required functions are the minimum needed to recognize routing requests, keep conversation state, select models, and remove the sentinel. `defineAdapter` and `genericProxy` both call `validateAdapter`; invalid definitions fail at startup with one error listing every bad hook.

| Hook | Requirement and exact signature | Contract and failure mode |
| --- | --- | --- |
| `isRoutingRequest` | Required: `(req, body) => boolean` | Return true only for this harness's turn endpoint carrying the sentinel. A false negative bypasses routing and can send the sentinel upstream; a false positive overrides a real manual model choice. |
| `conversationKey` | Required: `(body) => string` | Return a stable key for all requests in one conversation and a different key for sub-agents or separate sessions. An unstable or shared key loses routing state or leaks it between conversations. |
| `newTurnPrompt` | Required: `(body) => string \| null` | Return cleaned user text for one genuinely new turn; return `null` for tool continuations, auxiliary requests, or empty input. Returning old text routes repeatedly; returning `null` for a real turn reuses the previous/default model. |
| `getModels` | Required: `(catalog: Map<string, object>) => Array<{ id: string, tier: "haiku" \| "sonnet" \| "opus" \| "fable", description?: string }>` | Return the exact upstream model IDs the account can use. Invalid tiers are filtered by policy; an empty or stale list prevents an informed exact-model choice. |
| `getDefaultModel` | Required: `(tier) => string` | Map each shared tier to a real upstream model ID for cold starts and policy fallbacks. Prefer the account's catalog over static IDs: a fallback runs whenever the router is unavailable or unsure, and a static ID the account lacks is rejected upstream. Returning the sentinel, `undefined`, or an unavailable ID makes the forwarded request invalid. |
| `applyTier` | Required: `(body, tier, model) => void \| body` | Mutate `body` in place to use `model` and remove fields unsupported by that tier. The return value is ignored. Failure to mutate the body lets the sentinel reach upstream. |
| `isManualChoice` | Optional: `(req, body) => boolean` | Identify a real user turn on an explicit non-sentinel model, for manual status. Return false for the harness's own auxiliary calls (titles, summaries), tool continuations and explanation turns, or they overwrite the routed status. If omitted, manual requests still pass through but are not recorded. |
| `normalizeRequest` | Optional: `(body) => void` | Mutate every successfully parsed request before classification, for example to normalize schemas. If supplied with a non-function value, startup validation fails; if omitted, the body is untouched. |
| `decorateModelCatalog` | Optional: `(modelCatalog, catalog: Map<string, object>) => void` | Mutate the catalog response for the CLI and populate the map consumed by `getModels`. If omitted, catalog responses pass through and `getModels` must provide cold-start models itself. Throwing leaves the original catalog response intact and logs only in debug mode. |
| `decorateResponse` | Optional: `(res, response, routing) => void` | Inject harness-native routing feedback into a 2xx response. The hook must forward status, headers, body/stream, and end `res`. If omitted, the response is piped through. A broken hook can truncate or hang successful routed responses. |
| `contextTokens` | Optional: `(body) => number` | Estimate the conversation's context size in tokens, used by the policy's large-context guard. The default is a quarter of the JSON length of `body.messages` or `body.input`; an adapter with another body shape should supply its own. |
| `upstreamErrorBody` | Optional: `(message) => object` | The harness's own error shape for a `502` when the upstream is unreachable, so the CLI can render it. |
| `statusId` | Optional: `string \| (body, conversationKey) => string` | Select the status-file ID. The default is an empty string, which disables status-file writes. A function is useful when the ID is carried in each body. |
| `contextWindow` | Required: positive finite `number` | Passed to the route function as its context-window size. A missing or wrong value makes context pressure unreliable, so startup validation rejects it. |

`defineAdapter(adapter)` validates and returns the same object; it does not add defaults or change routing behavior. `validateAdapter(adapter)` does the same validation directly and also returns the same object on success. The root entry point additionally exports `AUTO_MODEL`, `TIER_NAMES`, and `isAuto` from the shared core so adapters do not duplicate the sentinel or tier vocabulary, and `createStatusStore` and `readStatus` for status records. Decisions go to a shared store under `$TMPDIR/jev-claude` (or `JEV_STATUS_DIR`) by default; a harness that must keep its records apart passes `store: createStatusStore({ dir })` to `genericProxy` or `routeTurn` and reads them back with `store.readStatus(id)`.

## Sentinel invariant

`AUTO_MODEL` is a picker sentinel, not a provider model. It tells the proxy that the user wants automatic routing. The upstream API does not know that ID and will reject it, so every request for which `isRoutingRequest` is true—including tool continuations and explanation turns—must reach `applyTier` and leave it with a real provider model. `getDefaultModel` must also never return the sentinel.

Manual choices are the inverse invariant: a real model chosen by the user must not be rewritten or sent through the router.

## Complete minimal adapter

This fictional Echo harness uses a JSON body with `model`, `conversation`, `kind`, and `prompt` fields. The following is a complete runtime adapter:

```js
import { AUTO_MODEL, defineAdapter, genericProxy } from "jev-router";

const DEFAULT_MODELS = {
  haiku: "echo-haiku-1",
  sonnet: "echo-sonnet-1",
  opus: "echo-opus-1",
  fable: "echo-fable-1",
};

export const echoAdapter = defineAdapter({
  contextWindow: 64_000,
  statusId: (body) => body.conversation,

  isRoutingRequest: (req, body) => req.method === "POST" && body.model === AUTO_MODEL,
  isManualChoice: (req, body) => req.method === "POST" && body.model !== AUTO_MODEL,
  conversationKey: (body) => body.conversation,
  newTurnPrompt: (body) => body.kind === "turn" ? body.prompt : null,

  getModels: (catalog) => [...catalog.values()],
  getDefaultModel: (tier) => DEFAULT_MODELS[tier],
  applyTier(body, _tier, model) {
    body.model = model;
  },
  decorateModelCatalog(response, catalog) {
    for (const model of response.models ?? []) catalog.set(model.id, model);
  },
});

export const startEchoProxy = ({ upstreamURL, route }) =>
  genericProxy({ adapter: echoAdapter, upstreamURL, route });
```

Measured as nonblank code lines, the `defineAdapter({ ... })` definition is 16 lines. Its required tier map adds 6 lines, for 22 lines of adapter implementation; the import and two-line proxy starter make the complete runtime module 25 lines. The “roughly twenty lines” claim survives for a simple JSON harness, but 25—not 20—is the honest full-module count. A protocol that needs schema normalization, dynamic upstream selection, or streamed response decoration will be longer.

The executable version, including all conformance fixtures, is [`test/harness/example-echo.test.mjs`](../test/harness/example-echo.test.mjs).

## Run the conformance suite

Install `jev-router`, expose a starter for your adapter, and create a Node test such as this:

```js
import { AUTO_MODEL } from "jev-router";
import { runAdapterConformance } from "jev-router/conformance";
import { startEchoProxy } from "./echo-adapter.mjs";

const makeBody = (kind) => ({ model, prompt, statusId }) => ({
  model,
  prompt,
  kind,
  conversation: statusId,
});

runAdapterConformance({
  name: "Echo",
  startProxy: startEchoProxy,
  routingPath: "/echo/turns",
  catalogPath: "/echo/models?limit=100",
  sentinelModel: AUTO_MODEL,
  resolvedModel: "echo-opus-2",
  resolvedTier: "opus",
  manualModel: "echo-haiku-manual",
  catalogResponse: {
    models: [
      { id: "echo-sonnet-1", tier: "sonnet", description: "Echo Sonnet" },
      { id: "echo-opus-2", tier: "opus", description: "Echo Opus 2" },
    ],
  },
  expectedCatalogModelIds: ["echo-sonnet-1", "echo-opus-2"],
  makeRoutingRequest: makeBody("turn"),
  makeToolContinuation: makeBody("continuation"),
  makeExplainRequest: ({ model, statusId }) => ({
    model,
    kind: "turn",
    prompt: "$jev-explain",
    conversation: statusId,
  }),
  makeManualRequest: makeBody("turn"),
  authHeaders: { authorization: "Bearer echo-conformance-token" },
});
```

Run it with Node's test runner:

```sh
node --test echo-adapter.test.mjs
```

Do not use `skip` to make a prospective adapter green. A skipped invariant means the shared contract is not satisfied and should be treated as an explicit design finding.

The eight tests verify that routed, continuation, and explanation requests never forward the sentinel; a fetched catalog supplies the exact models given to the router; routed status is filed under the harness ID; an explanation turn leaves that status untouched; with the router unavailable, a real model is forwarded (exactly `expectedFallbackModel` when you supply it, which should be a catalog model); a manual model bypasses routing, passes through, and is recorded as manual; and configured auth headers plus the upstream status, a header, and the response body survive the proxy.

They deliberately do **not** verify:

- Real provider authentication, TLS, production URL selection, rate limits, retries, or availability.
- Every endpoint/path, request variant, model-catalog schema, model-to-tier mapping, or sub-agent conversation-key rule used by the real CLI.
- Prompt cleaning beyond the supplied fixtures, including system reminders, auxiliary calls, malformed bodies, and all tool-result forms.
- `normalizeRequest`, unsupported-field removal in `applyTier`, context-token estimation, or whether `contextWindow` matches every model.
- The catalog response as rendered by the real model picker; the suite checks only the exact models later passed to the route function.
- The UI that reads status records; it checks only that the right record is written, kept, or marked manual.
- Streaming/chunk boundaries, SSE/event syntax, or routing-feedback content. It checks the upstream status, one response header, and a non-streamed JSON body.
- Headers other than those listed in `authHeaders`, request-body fidelity beyond the forwarded model, HEAD probes, upstream errors, cancellation, concurrency, or long-lived state eviction.
- Real routing quality, latency, cost, policy thresholds, or the correctness and availability of the model IDs returned by the harness.

A production adapter therefore still needs protocol-specific unit tests and at least one end-to-end test against the real CLI and a controlled upstream account.
