import { db } from "@/lib/db";
import { rankingViewsEnabled } from "@/lib/leaderboard";
import { readSiteRow, readTierMeta, standingOf } from "@/lib/tiers-db.mjs";
import { isPublicTier, tierOf } from "@/lib/tiers.mjs";
import { pointFixes, unpackCheck } from "@/lib/check-points.mjs";

// What a page shows of tiers by ELO (lib/tiers.mjs), and only while
// RANKING_V2 is on: with it off every page renders exactly as before, with
// Gemini's letter and the plain ELO. The tier ratings are still kept in the
// background (lib/tiers-db.mjs), so switching the flag on shows them at once.

/** Tiers by ELO are shown (RANKING_V2, wrangler.jsonc vars). */
export const tiersShown = () => rankingViewsEnabled();

export type ProfileTier = {
  /** The letter shown in public (SSS to B-); null for a lower one, an ungraded site or a hidden grade. */
  shown: string | null;
  /** The site has a letter at all (graded, a portfolio, not hidden). */
  hasTier: boolean;
  elo: number;
  /** Real face-offs (people's votes and AI comparisons), each counted once. */
  votes: number;
  top: number | null;
  of: number | null;
  /** Its starting rank came from automated checks. */
  seeded: boolean;
  check: ReturnType<typeof unpackCheck>;
  fixes: { id: string; gain: number; text: string }[];
};

/**
 * A profile's tier by ELO, derived on read from its rating row and the daily
 * cutoffs (two reads by key), with the points breakdown stored with its grade.
 * Null while RANKING_V2 is off.
 */
export async function loadProfileTier(url: string, rawRubric: unknown, hideGrade: boolean): Promise<ProfileTier | null> {
  if (!tiersShown()) return null;
  let grade: Record<string, unknown> | null = null;
  try {
    grade = typeof rawRubric === "string" ? JSON.parse(rawRubric) : null;
  } catch {
    grade = null;
  }
  const graded = Boolean(tierOf(grade) || (grade && typeof grade.tier === "string" && grade.is_portfolio !== false && !("error" in grade)));
  const [row, meta] = await Promise.all([readSiteRow(db(), url), readTierMeta(db())]);
  const s = standingOf(row, meta);
  const hasTier = graded && !hideGrade && s.tier != null;
  const check = hideGrade ? null : unpackCheck((grade?.rank as { check?: unknown } | undefined)?.check);
  return {
    shown: hasTier && isPublicTier(s.tier) ? s.tier : null,
    hasTier,
    elo: s.elo,
    votes: s.votes,
    top: s.top,
    of: s.of,
    seeded: s.seeded,
    check,
    fixes: check ? pointFixes(check) : [],
  };
}
