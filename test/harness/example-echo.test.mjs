import { AUTO_MODEL, defineAdapter, genericProxy } from "jev-router";
import { runAdapterConformance } from "jev-router/conformance";

const DEFAULT_MODELS = {
  haiku: "echo-haiku-1",
  sonnet: "echo-sonnet-1",
  opus: "echo-opus-1",
  fable: "echo-fable-1",
};

const echoAdapter = defineAdapter({
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

const startEchoProxy = ({ upstreamURL, route }) =>
  genericProxy({ adapter: echoAdapter, upstreamURL, route });

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
