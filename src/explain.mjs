import { tierSpec } from "./config.mjs";

const WIDTH = 33;
const row = (text = "") => `│ ${text.slice(0, WIDTH - 2).padEnd(WIDTH - 2)} │`;
const metric = (value) => (Number.isFinite(value) ? value.toFixed(2) : "n/a");
const wrapped = (label, value) => {
  const words = `${label}${value}`.replace(/\s+/g, " ").trim().split(" ");
  const lines = [];
  for (const word of words) {
    if (!lines.length || `${lines.at(-1)} ${word}`.length > WIDTH - 2) lines.push(word);
    else lines[lines.length - 1] += ` ${word}`;
  }
  return lines.map(row);
};

const decision = (reason = "") => {
  if (reason.includes("override")) return "prompt override";
  if (reason.includes("jev-unavailable")) return "Jev unavailable; held";
  if (reason.includes("low-confidence-no-downgrade")) return "low confidence; held";
  if (reason.includes("low-confidence-capped")) return "low confidence; capped";
  if (reason.includes("cache-rebuild")) return "cache rebuild avoided";
  if (reason.includes("unavailable")) return "nearest available tier";
  return "Jev recommendation";
};

export function formatExplanation(status) {
  if (!status) return "Jev Router: no routing decision has been recorded for this session.";
  if (status.manual) return "Jev Router: routing is paused because you selected a model manually.";

  const m = status.metrics ?? {};
  const request = status.jev?.request?.state;
  const recommendation =
    status.jev?.response?.answers?.tier?.choice ??
    status.jev?.response?.answers?.model_tier?.choice ??
    status.tier ??
    "unknown";
  const recSpec = tierSpec(recommendation);
  const recEffort = typeof recSpec?.effort === "string" ? ` (${recSpec.effort.toUpperCase()})` : "";
  const servedModel = status.servedModel || status.model || status.tier || "unknown";
  const servedEffort = typeof status.effort === "string" ? ` (${status.effort.toUpperCase()})` : "";
  const toolsUsedText = status.toolsUsed?.length ? status.toolsUsed.join(", ") : "none";
  const toolsCount = status.toolsOffered?.length ?? 0;

  return [
    `┌${"─".repeat(WIDTH)}┐`,
    row("Jev Router"),
    row(),
    row("Jev request"),
    ...wrapped("Prompt: ", status.prompt ?? "not recorded"),
    row(`Current tier: ${(request?.session?.current_model ?? "unknown").toUpperCase()}`),
    row(`Context tokens: ${request?.session?.context_tokens ?? "unknown"}`),
    row(`Tools offered: ${toolsCount} tools`),
    row(),
    row("Jev response"),
    row(`Task complexity     ${metric(m.taskComplexity)}`),
    row(`Reasoning required  ${metric(m.reasoningRequired)}`),
    row(`Tool complexity     ${metric(m.toolComplexity)}`),
    row(`Context size        ${metric(m.contextSize)}`),
    row(),
    row(`Recommended tier: ${recommendation.toUpperCase()}${recEffort}`),
    row(`Selected model: ${servedModel.toUpperCase()}${servedEffort}`),
    ...wrapped("Tools used: ", toolsUsedText),
    row(),
    row(`Confidence: ${status.confidence == null ? "n/a" : `${Math.round(status.confidence * 100)}%`}`),
    row(`Decision: ${decision(status.reason)}`),
    `└${"─".repeat(WIDTH)}┘`,
  ].join("\n");
}

export function formatHistory(status) {
  const history = status?.history || (status ? [status] : []);
  if (!history.length) return "Jev Router: no history recorded for this session.";

  const lines = [
    "╔══════╦══════════════════════════════════════════╦═══════════════════════════════════╦═════════════════════╦════════════╗",
    "║ Turn ║ Task / Prompt                            ║ Tier: Model [Effort]              ║ Tools Used          ║ Confidence ║",
    "╠══════╬══════════════════════════════════════════╬═══════════════════════════════════╬═════════════════════╬════════════╣",
  ];

  history.forEach((h, idx) => {
    const turnNum = String(idx + 1).padEnd(4);
    const promptText = (h.prompt || "").replace(/\s+/g, " ").slice(0, 40).padEnd(40);
    const tierName = h.tier || "unknown";
    const modelName = h.servedModel || h.model || tierName;
    const effortStr = typeof h.effort === "string" ? ` [${h.effort}]` : "";
    const modelText = `${tierName}: ${modelName}${effortStr}`.slice(0, 33).padEnd(33);
    const toolsText = (h.toolsUsed?.length ? h.toolsUsed.join(", ") : "none").slice(0, 19).padEnd(19);
    const confText = (h.confidence != null ? `${Math.round(h.confidence * 100)}%` : "n/a").padStart(10);
    lines.push(`║ ${turnNum} ║ ${promptText} ║ ${modelText} ║ ${toolsText} ║ ${confText} ║`);
  });

  lines.push("╚══════╩══════════════════════════════════════════╩═══════════════════════════════════╩═════════════════════╩════════════╝");
  return lines.join("\n");
}
