import {
  ALL_TIER_NAMES,
  TIER_NAMES,
  THRESHOLDS,
  OVERRIDE_PATTERNS,
  rankOf,
  normalizeTier,
  tierSpec,
} from "./config.mjs";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * unless requested.
 */
function clampToAvailable(tier, available) {
  if (!available || !available.length) return tier;
  if (available.includes(tier)) return tier;
  const norm = normalizeTier(tier) ?? tier;
  if (available.includes(norm)) return norm;
  const match = available.find((a) => normalizeTier(a) === norm);
  if (match) return match;

  const rank = rankOf(norm);
  const up = ALL_TIER_NAMES.filter(
    (t) => rankOf(t) > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = ALL_TIER_NAMES.filter((t) => rankOf(t) < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model tier we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the tier already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available = TIER_NAMES, contextTokens = 0 }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why =
      final === tier || normalizeTier(final) === normalizeTier(tier) ? reason : `${reason}+unavailable`;
    return {
      tier: final,
      reason: final === current ? `${why}/no-change` : why,
      changed: final !== current,
    };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || (!TIER_NAMES.includes(jev.choice) && !ALL_TIER_NAMES.includes(jev.choice))) {
    return settle(current, "jev-unavailable");
  }

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceilingRank = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceilingRank) {
      const ceilingTier =
        available.find((a) => rankOf(a) === ceilingRank) ??
        TIER_NAMES[ceilingRank] ??
        THRESHOLDS.uncertainCeiling;
      return settle(ceilingTier, "low-confidence-capped");
    }
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}
