// Settings of the rating engine (OpenSkill, Weng-Lin), in one place, so the
// recompute script, the comparison job, the tests and anyone recomputing the
// board from the published comparisons use the same numbers.
//
// Every value here is part of the published method: a recompute records the
// config it used (ranking_runs.config), so a board can be reproduced exactly.
//
// The scale is OpenSkill's default: a fresh rating is mu 25, sigma 25/3, and
// beta (the performance noise of one comparison) is 25/6. A mean gap of one
// beta makes the better site win a one-on-one about 62% of the time once both
// are settled; the tier seeds below are spaced one beta apart.

/** OpenSkill's defaults (openskill.js constants). */
export const MU = 25;
export const SIGMA = 25 / 3;
export const BETA = 25 / 6;
// Added to sigma (in quadrature) before each update, so ratings never freeze.
export const TAU = 25 / 300;

/**
 * Starting mean per AI tier (owner decision 2026-11-10: the grade sets the
 * starting rating, tiers evenly spaced). B is the neutral 25; one tier is
 * 4 points, about one beta.
 */
export const TIER_MU = { S: 33, A: 29, B: 25, C: 21, D: 17 };

/**
 * Typical quality score per tier, measured on the 711 graded sites of the
 * June 2026 grade export (weighted mean of the five AI axes, as
 * pipeline/rubric.mjs qualityScore computes it): S 4.78, A 4.46, B 3.61,
 * C 2.70, D 1.54, each with a spread of about 0.3. The quality score only
 * nudges a site within its tier, relative to what that tier usually scores.
 */
export const TIER_QUALITY_CENTER = { S: 4.8, A: 4.45, B: 3.6, C: 2.7, D: 1.55 };
/** Mean points per quality point away from the tier's centre. */
export const QUALITY_NUDGE_PER_POINT = 2;
/** The nudge never exceeds this, so tiers never overlap (gap 4, nudge at most 1.5 each way). */
export const QUALITY_NUDGE_MAX = 1.5;

/** Sigma of a site seeded from a current grade (rubric v2 by the primary model). */
export const SEED_SIGMA = 4;
/** Sigma of a site seeded from an older grade (rubric v1, or the backup model). */
export const SEED_SIGMA_OLD_GRADE = 4.5;
/** Sigma of a site with no grade, and after a redesign ("unsure"): OpenSkill's fresh sigma. */
export const SIGMA_UNSURE = SIGMA;

/** The model whose grades count as current. */
export const PRIMARY_GRADE_MODEL = "gemini-3.5-flash-lite";
export const CURRENT_RUBRIC_VERSION = 2;

/**
 * Merged view: human votes count fully, AI comparisons at this weight (owner
 * decision 2026-11-10: AI weighted lower). See RANKING.md for why.
 */
export const AI_WEIGHT_MERGED = 0.5;
/** A human "Superstar" vote counts as two votes, as it does in the current ELO. */
export const STARRED_WEIGHT = 2;

/**
 * Confidence labels by sigma. "Enough evidence" means sigma at most
 * CONFIDENT_SIGMA: a 95% range of +-7 points, under two tiers either way.
 * Plackett-Luce shrinks sigma slowly: a site seeded at sigma 4 reaches 3.5
 * after about 9 comparisons and 2.5 after about 50; an unsure site (8.33)
 * needs about 30 to reach 3.5.
 */
export const SETTLED_SIGMA = 2.5;
export const CONFIDENT_SIGMA = 3.5;
export const PROVISIONAL_SIGMA = 5;
/** Two neighbours on the board read as tied when the higher one's chance to beat the lower is below this. */
export const TIE_WIN_PROBABILITY = 0.55;

/** Matchmaking: 1 in RANDOM_EVERY pairs is random from anywhere (owner: 1 in 5). */
export const RANDOM_EVERY = 5;
/** 1 in REPEAT_EVERY pairs re-asks an earlier pair in the other order, to measure consistency and position bias. */
export const REPEAT_EVERY = 20;
/** Close matches are drawn from this many neighbours by mean on each side. */
export const NEIGHBOURS = 12;
/** A pair compared within this many days is not drawn again as a close or random match. */
export const PAIR_COOLDOWN_DAYS = 30;
/** No site appears in more than this many of one day's comparisons. */
export const MAX_PER_SITE_PER_DAY = 3;
/** A floor on the draw weight (sigma to the fourth), so settled sites are compared less but still now and then. */
export const MIN_DRAW_WEIGHT = 0.5;

/** Sites per batched request (the owner's placement idea: several sites ranked in one request). */
export const BATCH_SIZE = 5;

/** Daily comparison budget on 3.5 for the new job (owner: 100 one-on-one, 100 batched). */
export const DEFAULT_DAILY_BUDGET = { one_on_one: 100, batched: 100 };
export const COMPARISON_MODEL = "gemini-3.5-flash-lite";
export const PROMPT_VERSION_ONE_ON_ONE = "compare-v1";
export const PROMPT_VERSION_BATCHED = "batch-v1";
/** What imported AI votes from the ELO judge (pipeline/judge.mjs pairwise) are tagged with. */
export const PROMPT_VERSION_LEGACY = "legacy-pairwise";

const flagOn = (v) => String(v ?? "").trim().toLowerCase() === "true";

function jsonEnv(env, name, fallback) {
  const raw = env[name];
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? { ...fallback, ...v } : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The settings in effect, from the defaults above and these variables:
 *   RANKING_V2              "true" turns on the new daily comparison job (off by default)
 *   RANKING_BATCHED_COUNTS  "true" counts batched comparisons in the AI and Merged views
 *                           (off by default: experiment only until they agree with one-on-one)
 *   RANKING_BUDGET          JSON, e.g. {"one_on_one": 100, "batched": 100}
 *   RANKING_AI_WEIGHT       the AI weight in the Merged view (default 0.5)
 */
export function rankingConfig(env = process.env) {
  const aiWeight = Number(env.RANKING_AI_WEIGHT);
  const budget = jsonEnv(env, "RANKING_BUDGET", DEFAULT_DAILY_BUDGET);
  return {
    enabled: flagOn(env.RANKING_V2),
    batchedCounts: flagOn(env.RANKING_BATCHED_COUNTS),
    aiWeight: Number.isFinite(aiWeight) && aiWeight >= 0 && aiWeight <= 1 ? aiWeight : AI_WEIGHT_MERGED,
    budget: {
      one_on_one: Math.max(0, Math.floor(Number(budget.one_on_one) || 0)),
      batched: Math.max(0, Math.floor(Number(budget.batched) || 0)),
    },
    model: COMPARISON_MODEL,
    batchSize: BATCH_SIZE,
  };
}

/** The engine constants, recorded with every recompute. */
export function engineSettings(config = rankingConfig()) {
  return {
    model: "openskill plackett-luce",
    mu: MU,
    sigma: SIGMA,
    beta: BETA,
    tau: TAU,
    tierMu: TIER_MU,
    tierQualityCenter: TIER_QUALITY_CENTER,
    qualityNudgePerPoint: QUALITY_NUDGE_PER_POINT,
    qualityNudgeMax: QUALITY_NUDGE_MAX,
    seedSigma: SEED_SIGMA,
    seedSigmaOldGrade: SEED_SIGMA_OLD_GRADE,
    sigmaUnsure: SIGMA_UNSURE,
    aiWeightMerged: config.aiWeight,
    starredWeight: STARRED_WEIGHT,
    batchedCounts: config.batchedCounts,
  };
}
