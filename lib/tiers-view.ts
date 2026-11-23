import { db } from "@/lib/db";
import { rankingViewsEnabled } from "@/lib/leaderboard";
import { readSiteRow, readTierMeta, standingOf } from "@/lib/tiers-db.mjs";
import { isPublicTier, tierOf } from "@/lib/tiers.mjs";
import { pointFixes, unpackCheck } from "@/lib/check-points.mjs";
import { checkSources, pointsOf } from "@/lib/tiers-store.mjs";

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
  /** Face-offs, weighted (an AI one counts a quarter), and whether that settles the rank (lib/tiers.mjs SETTLED_FACEOFFS). */
  faceoffs: number;
  settled: boolean;
  top: number | null;
  of: number | null;
  /** Its starting rank came from automated checks. */
  seeded: boolean;
  check: ReturnType<typeof unpackCheck>;
  /** The breakdown was made now from the saved checks (true), or is the one stored when the rank was set (false). */
  checkIsCurrent: boolean;
  /**
   * The points total the starting rank was set from (the breakdown stored with the rank at the last
   * rebuild), when it differs from the current one; null when they agree or there is none.
   */
  startingPoints: number | null;
  fixes: { id: string; gain: number; text: string }[];
};

/**
 * A profile's tier by ELO, derived on read from its rating row and the daily
 * cutoffs (two reads by key), with its points breakdown made on read from its
 * saved check data (two more reads by key), so the breakdown, the fixes and
 * the report card always read the same facts.
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
  const stored = hideGrade ? null : unpackCheck((grade?.rank as { check?: unknown } | undefined)?.check);
  const [row, meta, sources] = await Promise.all([
    readSiteRow(db(), url),
    readTierMeta(db()),
    // Only for a grade with a breakdown: its points as they are now, never a breakdown it never had.
    stored ? checkSources(db(), { only: url }).then((m) => m.get(url) ?? {}).catch(() => null) : null,
  ]);
  const s = standingOf(row, meta);
  const hasTier = graded && !hideGrade && s.tier != null;
  // The breakdown and the fixes from the saved checks and the newest measured facts (lib/fresh-facts.mjs), as the
  // report card reads them; the one stored with the rank at the last rebuild when they can't be read.
  const current = stored && sources ? pointsOf(grade, sources, meta?.medians ?? null) : null;
  const check = current ?? stored;
  // The rank moves only at a full rebuild: say what it was set from when today's total is different.
  const startingPoints = current && stored && Math.round(current.total) !== Math.round(stored.total) ? stored.total : null;
  return {
    checkIsCurrent: Boolean(current),
    startingPoints,
    shown: hasTier && isPublicTier(s.tier) ? s.tier : null,
    hasTier,
    elo: s.elo,
    votes: s.votes,
    faceoffs: s.faceoffs,
    settled: s.settled,
    top: s.top,
    of: s.of,
    seeded: s.seeded,
    check,
    fixes: check ? pointFixes(check) : [],
  };
}
