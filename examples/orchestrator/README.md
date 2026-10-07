# Orchestrator integration examples

These examples run the same two-prompt toy workload through Jev Router's two integration patterns. Both have an offline mode that uses deterministic routing and fake model IDs, requires no API key, and makes no external network request.

## Native pattern: your code owns the model call

[`run-native.mjs`](./run-native.mjs) calls `routeTurn` once per new user turn, prints the selected tier, exact model, and policy reason, then updates the orchestrator's own conversation state. The comment after the decision marks where a real loop would call its model SDK.

Run it from the repository root:

```sh
node examples/orchestrator/run-native.mjs --offline
```

Use this pattern when you control the agent loop or orchestrator and can pass `decision.model` directly to the provider SDK. Remove `--offline` to use the core Jev route function; provide the usual Jev API-key environment variable first.

## Proxy pattern: an existing CLI owns the request

[`run-proxy.mjs`](./run-proxy.mjs) defines a small adapter, starts `genericProxy`, and launches a child process with `TOY_BASE_URL` pointing at the loopback proxy. The child sends the toy workload through that URL just as a wrapper binary points an existing CLI at a custom base URL. Offline mode also starts a local echo upstream so the whole example is self-contained.

Run it from the repository root:

```sh
node examples/orchestrator/run-proxy.mjs --offline
```

Use this pattern when the harness already owns request construction and model calls, but lets a wrapper replace its API base URL. Without `--offline`, set `TOY_UPSTREAM_URL` to the controlled upstream endpoint that should receive the rewritten toy requests.

## Choosing between them

Choose native routing when your code already has the prompt, model catalog, context estimate, and conversation state at the point where it chooses a model. Choose the proxy when the harness is not yours to modify and its HTTP protocol can be represented by an adapter. The native path avoids a local HTTP hop; the proxy path additionally owns sentinel rewriting, catalog ingestion, conversation tracking, and response decoration.
