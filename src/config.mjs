// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * 6-Tier Model and Reasoning Effort Routing Matrix:
 * - chat: haiku 4.5 (thinking: false, effort: null)
 * - small: sonnet 5 (thinking: adaptive, effort: "low")
 * - utility: sonnet 5 (thinking: adaptive, effort: "medium")
 * - medium: sonnet 5 (thinking: adaptive, effort: "high")
 * - plan: opus 5.5 (thinking: adaptive, effort: "high")
 * - heavy: opus 5.5 (thinking: adaptive, effort: "xhigh")
 */
export const TIERS = [
  {
    name: "chat",
    id: "claude-haiku-4-5-20251001",
    family: "haiku",
    thinking: false,
    effort: null,
    modelName: "haiku 4.5",
    taskName: "chat",
    description: "Short conversational replies, greetings, acknowledgements, general chat without coding",
  },
  {
    name: "small",
    id: "claude-sonnet-5",
    family: "sonnet",
    thinking: true,
    effort: "low",
    modelName: "sonnet 5 low",
    taskName: "small task",
    description: "Small tasks: a small well-scoped change in one file, a quick 1-5 line fix, simple script run, rename, typo fix",
  },
  {
    name: "utility",
    id: "claude-sonnet-5",
    family: "sonnet",
    thinking: true,
    effort: "medium",
    modelName: "sonnet 5 medium",
    taskName: "utility",
    description: "Utility tasks: summaries, lookups, searching docs, explaining code or architecture, small mechanical checks, listing APIs",
  },
  {
    name: "medium",
    id: "claude-sonnet-5",
    family: "sonnet",
    thinking: true,
    effort: "high",
    modelName: "sonnet 5 high",
    taskName: "medium task",
    description: "Medium tasks: typical feature implementation, multi-step debugging across a few files, tool loops, standard engineering",
  },
  {
    name: "plan",
    id: "claude-opus-5-5",
    family: "opus",
    thinking: true,
    effort: "high",
    modelName: "opus 5.5 high",
    taskName: "plan",
    description: "Architecture, system design, multi-file planning, roadmap, specifications, deep reasoning before code",
  },
  {
    name: "heavy",
    id: "claude-opus-5-5",
    family: "opus",
    thinking: true,
    effort: "xhigh",
    modelName: "opus 5.5 xhigh",
    taskName: "heavy task",
    description: "Large complex refactoring, hard concurrency/race bugs, unknown root-cause debugging, high blast radius changes",
  },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

// Legacy tier aliases mapping for backwards compatibility
export const LEGACY_MAP = {
  haiku: "chat",
  sonnet: "medium",
  opus: "plan",
  fable: "heavy",
};

export const ALL_TIER_NAMES = [...TIER_NAMES, "haiku", "sonnet", "opus", "fable"];

export const normalizeTier = (name) => {
  if (!name) return null;
  return LEGACY_MAP[name] ?? (TIER_NAMES.includes(name) ? name : null);
};

export const rankOf = (name) => {
  if (!name) return -1;
  if (name === "fable") return 5;
  if (name === "opus") return 4;
  if (name === "sonnet") return 3;
  if (name === "haiku") return 0;
  const idx = TIER_NAMES.indexOf(name);
  if (idx !== -1) return idx;
  const norm = normalizeTier(name);
  return norm ? TIER_NAMES.indexOf(norm) : -1;
};

export const idOf = (name) => {
  if (!name) return undefined;
  if (name === "haiku") return "claude-haiku-4-5-20251001";
  if (name === "sonnet") return "claude-sonnet-5";
  if (name === "opus") return "claude-opus-5";
  if (name === "fable") return "claude-fable-5-1";
  const tier = TIERS.find((t) => t.name === name);
  if (tier) return tier.id;
  const norm = normalizeTier(name);
  if (norm && norm !== name) return TIERS.find((t) => t.name === norm)?.id;
  return undefined;
};

export const tierSpec = (name) => {
  if (!name) return undefined;
  if (name === "opus") return { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true };
  if (name === "sonnet") return { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true };
  if (name === "fable") return { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true };
  if (name === "haiku") return { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false };
  const tier = TIERS.find((t) => t.name === name);
  if (tier) return tier;
  const norm = normalizeTier(name);
  if (norm && norm !== name) return TIERS.find((t) => t.name === norm);
  return undefined;
};

export const AUTO_MODEL = "jev-router";

export const isAuto = (model) => model === AUTO_MODEL;

export const tierOf = (model) => {
  if (typeof model !== "string") return null;
  if (TIER_NAMES.includes(model)) return model;
  if (/haiku/i.test(model)) return "haiku";
  if (/fable/i.test(model)) return "fable";
  if (/opus/i.test(model)) return "opus";
  if (/sonnet/i.test(model)) return "sonnet";
  return null;
};

export const availableTiers = () =>
  [...TIER_NAMES, "haiku", "sonnet", "opus", ...(process.env.JEV_ALLOW_FABLE === "1" ? ["fable"] : ["fable"])];

export const THRESHOLDS = {
  minConfidence: 0.3,
  uncertainCeiling: "medium",
  downgradeMaxContextTokens: 20000,
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

export const CONTEXT_WINDOW_TOKENS = 200000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

export const OVERRIDE_PATTERNS = [
  {
    tier: "heavy",
    re: /\b(?:use|switch to|with|on)\s+(?:heavy(?:\s+task)?|opus\s+xhigh|xhigh|complex|hard\s+debug)\b/i,
  },
  {
    tier: "plan",
    re: /\b(?:use|switch to|with|on)\s+(?:plan|architecture|design|spec|roadmap|opus\s+high)\b/i,
  },
  {
    tier: "opus",
    re: /\b(?:use|switch to|with|on)\s+(?:opus|strong|sol)\b/i,
  },
  {
    tier: "medium",
    re: /\b(?:use|switch to|with|on)\s+(?:medium(?:\s+task)?|sonnet\s+high)\b/i,
  },
  {
    tier: "sonnet",
    re: /\b(?:use|switch to|with|on)\s+(?:sonnet|balanced|terra)\b/i,
  },
  {
    tier: "utility",
    re: /\b(?:use|switch to|with|on)\s+(?:utility|util|docs|lookup|summary|summarize|sonnet\s+medium)\b/i,
  },
  {
    tier: "small",
    re: /\b(?:use|switch to|with|on)\s+(?:small(?:\s+task)?|quick|minor|typo|low|sonnet\s+low)\b/i,
  },
  {
    tier: "haiku",
    re: /\b(?:use|switch to|with|on)\s+(?:haiku|luna)\b/i,
  },
  {
    tier: "chat",
    re: /\b(?:use|switch to|with|on)\s+(?:chat|fast)\b/i,
  },
];

export const QUESTIONS = {
  task_complexity: score(
    "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
    COMPLEXITY_SCALE,
  ),
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
  tool_complexity: score(
    "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
    COMPLEXITY_SCALE,
  ),
};

export const questionForTiers = () =>
  choice(
    [
      "Route this coding or conversational request to the exact task tier and effort level required.",
      "Judge required reasoning and task scope, not requested reply length.",
    ],
    Object.fromEntries(
      TIERS.map((t) => [
        t.name,
        {
          task: `${t.taskName} / ${t.modelName}`,
          scope: t.description,
        },
      ]),
    ),
  );

export const questionForModels = () => questionForTiers();

export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") &&
  (chosenTier === finalTier || normalizeTier(chosenTier) === normalizeTier(finalTier));
