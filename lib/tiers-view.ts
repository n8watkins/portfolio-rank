import { db } from "@/lib/db";
import { rankingViewsEnabled } from "@/lib/leaderboard";
import { peekTierMeta, readSiteRow, readTierMeta, standingOf } from "@/lib/tiers-db.mjs";
import { isPublicTier } from "@/lib/tiers.mjs";
import { pointFixes, unpackCheck } from "@/lib/check-points.mjs";
import { checkSources, pointsOf } from "@/lib/tiers-store.mjs";

// What a page shows of tiers by ELO (lib/tiers.mjs), and only while
// RANKING_V2 is on: with it off the letters and the ranked board stay
// hidden. The tier ratings are still kept in the background
// (lib/tiers-db.mjs), so switching the flag on shows them at once.
//
// The Code checks score (lib/check-points.mjs, 100 points) is shown either
// way (loadCodeChecks): it is the one number a site's checks have, on the
// profile, its report card and the printable report.

/** Tiers by ELO are shown (RANKING_V2, wrangler.jsonc vars). */
export const tiersShown = () => rankingViewsEnabled();

type Check = NonNullable<ReturnType<typeof unpackCheck>>;

export type CodeChecks = {
  /** The Code checks score: { total, items }, made on read from the saved checks and the newest measured facts. */
  check: Check;
  /** The quickest points to gain ("+5 if you add a share image"), measured items only. */
  fixes: { id: string; gain: number; text: string }[];
};

export type ProfileTier = {
  /** The letter shown in public (SSS to B-); null for a lower one, a site with no Tier or a hidden grade. */
  shown: string | null;
  /** The site has a Tier at all (a library member, graded by Gemini or measured by code, not hidden). */
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
  check: Check | null;
  /** The breakdown was made now from the saved checks (true), or is the one stored when the rank was set (false). */
  checkIsCurrent: boolean;
  /**
   * The points total the starting rank was set from (the rank's stored points), when it differs from the
   * current one; null when they agree or there is none.
   */
  startingPoints: number | null;
  fixes: { id: string; gain: number; text: string }[];
};

const parseGrade = (raw: unknown): Record<string, unknown> | null => {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw);
    return g && typeof g === "object" ? g : null;
  } catch {
    return null;
  }
};

/**
 * A site's Code checks score with its items and quickest fixes, made on read
 * from its saved check data and its newest measured facts (Gemini grade or
 * not), with the library's medians for what is not measured (two reads by
 * key, the tier meta and the site's checks). Null when nothing was measured
 * (no capture, no Lighthouse, no polish check) or the owner hid the grade.
 */
export async function loadCodeChecks(url: string, rawRubric: unknown, hideGrade: boolean, meta?: unknown): Promise<CodeChecks | null> {
  if (hideGrade) return null;
  const [m, sources] = await Promise.all([
    meta === undefined ? peekTierMeta(db()) : meta,
    checkSources(db(), { only: url })
      .then((s) => s.get(url) ?? null)
      .catch(() => null),
  ]);
  if (!sources) return null;
  const check = pointsOf(parseGrade(rawRubric), sources, (m as { medians?: unknown } | null)?.medians ?? null) as Check;
  if (!check.items.some((i) => i.measured)) return null;
  return { check, fixes: pointFixes(check) };
}

/**
 * A profile's tier by ELO, derived on read from its rating row and the daily
 * cutoffs (two reads by key), with its Code checks score made on read
 * (loadCodeChecks), so the breakdown, the fixes and the report card always
 * read the same facts. A site has a Tier from its first measure, before any
 * Gemini grade (owner, 2026-11-22). Null while RANKING_V2 is off.
 */
export async function loadProfileTier(url: string, rawRubric: unknown, hideGrade: boolean): Promise<ProfileTier | null> {
  if (!tiersShown()) return null;
  const grade = parseGrade(rawRubric);
  const [row, meta] = await Promise.all([readSiteRow(db(), url), readTierMeta(db())]);
  const s = standingOf(row, meta);
  const hasTier = !hideGrade && row.member === 1 && s.tier != null;
  const current = await loadCodeChecks(url, grade, hideGrade, meta);
  // The breakdown stored with the rank at the last rebuild, when today's can't be read.
  const stored = hideGrade ? null : unpackCheck((grade?.rank as { check?: unknown } | undefined)?.check);
  const check = current?.check ?? stored;
  // The rank moves only at a full rebuild: say what it was set from when today's total is different.
  const startedAt = row.seeded === 1 ? row.points : null;
  const startingPoints = current && startedAt != null && Math.round(current.check.total) !== Math.round(startedAt) ? startedAt : null;
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
    fixes: current?.fixes ?? (check ? pointFixes(check) : []),
  };
}
