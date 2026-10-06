const number = (value) => (Number.isFinite(value) && value >= 0 ? value : undefined);

const sum = (requests, field) => {
  const values = requests.map((request) => request.usage?.[field]);
  return values.every(Number.isFinite) ? values.reduce((total, value) => total + value, 0) : undefined;
};

/**
 * Normalize the usage object emitted on a Responses API response. The raw object is retained
 * beside this view because ChatGPT's Codex backend is not a public wire contract.
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const inputTokens = number(raw.input_tokens);
  const cachedInputTokens = number(raw.input_tokens_details?.cached_tokens);
  const outputTokens = number(raw.output_tokens);
  const reasoningTokens = number(raw.output_tokens_details?.reasoning_tokens);
  const totalTokens = number(raw.total_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    // Cached input is a subset of input in the Responses API. Only derive this when both
    // values were supplied, rather than treating a missing cache field as zero.
    nonCachedInputTokens:
      inputTokens !== undefined && cachedInputTokens !== undefined
        ? inputTokens - cachedInputTokens
        : undefined,
    outputTokens,
    reasoningTokens,
    // This is authoritative and already accounts for the API's output-token semantics.
    totalTokens,
  };
}

export function usageFromResponse(payload) {
  const response = payload?.response ?? payload;
  const raw = response?.usage;
  const usage = normalizeUsage(raw);
  return usage && { raw, usage, model: response?.model };
}

export function aggregateUsage(requests = []) {
  const known = requests.filter((request) => request.usage);
  if (!known.length || known.length !== requests.length) return null;
  return {
    inputTokens: sum(known, "inputTokens"),
    cachedInputTokens: sum(known, "cachedInputTokens"),
    nonCachedInputTokens: sum(known, "nonCachedInputTokens"),
    outputTokens: sum(known, "outputTokens"),
    reasoningTokens: sum(known, "reasoningTokens"),
    // Do not add input/output/reasoning here: the upstream total is canonical.
    totalTokens: sum(known, "totalTokens"),
  };
}

const shown = (value) => (Number.isFinite(value) ? value.toLocaleString("en-US") : "unavailable");

export function formatUsage(usage, label = "[Jev usage]") {
  if (!usage) return `${label}\nUsage: unavailable`;
  return [
    label,
    `Input: ${shown(usage.inputTokens)}`,
    `Cached: ${shown(usage.cachedInputTokens)}`,
    `Non-cached: ${shown(usage.nonCachedInputTokens)}`,
    `Output: ${shown(usage.outputTokens)}`,
    ...(usage.reasoningTokens === undefined ? [] : [`Reasoning: ${shown(usage.reasoningTokens)}`]),
    `Total: ${shown(usage.totalTokens)}`,
  ].join("\n");
}

export function formatUsageReport(turns = []) {
  if (!turns.length) return "[Jev usage]\nNo completed turns with upstream usage have been recorded.";
  const latest = turns.at(-1);
  const cumulative = aggregateUsage(turns.flatMap((turn) => turn.requests ?? []));
  return [
    formatUsage(latest.aggregate, "[Jev usage — most recent turn]"),
    `Model: ${latest.model ?? "unavailable"}`,
    ...(latest.effort ? [`Effort: ${latest.effort}`] : []),
    "",
    formatUsage(cumulative, "[Jev usage — current session]"),
    "",
    "Turns:",
    ...turns.map((turn, index) => `${index + 1}. ${turn.model ?? "unavailable"} — ${shown(turn.aggregate?.totalTokens)}`),
  ].join("\n");
}
