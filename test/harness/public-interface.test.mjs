import test from "node:test";
import assert from "node:assert/strict";
import { defineAdapter, genericProxy, validateAdapter } from "jev-router";

const requiredAdapter = () => ({
  contextWindow: 100_000,
  isRoutingRequest() {},
  conversationKey() {},
  newTurnPrompt() {},
  getModels() {},
  getDefaultModel() {},
  applyTier() {},
});

test("defineAdapter validates and returns the same adapter", () => {
  const adapter = requiredAdapter();
  assert.equal(defineAdapter(adapter), adapter);
  assert.equal(validateAdapter(adapter), adapter);
});

test("validateAdapter reports every malformed hook at once", () => {
  const malformed = {
    isManualChoice: true,
    normalizeRequest: null,
    decorateModelCatalog: {},
    decorateResponse: "stream",
    statusId: 42,
    contextWindow: Infinity,
  };
  const names = [
    "isRoutingRequest",
    "conversationKey",
    "newTurnPrompt",
    "getModels",
    "getDefaultModel",
    "applyTier",
    "isManualChoice",
    "normalizeRequest",
    "decorateModelCatalog",
    "decorateResponse",
    "statusId",
    "contextWindow",
  ];

  assert.throws(() => validateAdapter(malformed), (error) => {
    for (const name of names) assert.match(error.message, new RegExp(`\\b${name}\\b`));
    return true;
  });
});

test("genericProxy rejects a malformed adapter before listening", async () => {
  await assert.rejects(genericProxy({ adapter: {} }), /Invalid adapter:[\s\S]*isRoutingRequest/);
});
