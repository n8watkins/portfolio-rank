import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
import { ownerState } from "@/lib/games/claims.mjs";
import { tierOf, isPublicTier } from "@/lib/tiers.mjs";
import { readSiteRow, readTierMeta, standingOf as liveStanding } from "@/lib/tiers-db.mjs";
import { unpackCheck } from "@/lib/check-points.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { seen } from "@/lib/discovery/sites.mjs";
import type { QuickFacts } from "@/lib/grader/quick";
import type { PsiResult } from "@/lib/tools/psi";
import type { ShareResult } from "@/lib/tools/share";
import { psiKey, quickKey, shareKey } from "@/lib/tools/keys";

// Everything a portfolio's profile (/p/<address>) shows, for a listed
// portfolio or one added through "Add your portfolio" (the discovery
// seen-set, or a grade asked for it): its rank, its report card (the AI
// grade: the list's, else the newest finished "grade my portfolio" job),
// and the saved results of every check (lib/tools), from which the fix list
// is built. Read-only; nothing here names who is looking.

export type Feed = { name: string; url: string; tagline?: string };

export const profilePath = (url: string) => `/p/${encodeURIComponent(url)}`;

const AXIS_LABELS: Record<string, string> = Object.fromEntries(AI_CRITERIA.map((c) => [c.id, c.name]));

export type ReportCard = {
  model?: string;
  quality?: number;
  checks?: number;
  roles: string[];
  isPortfolio: boolean;
  axes: { key: string; label: string; score: number; note?: string }[];
};

/** The AI grade's public part (never Gemini's own letter), or null for none or an error. */
export function reportCard(raw: unknown): ReportCard | null {
  let r: Record<string, unknown>;
  try {
    r = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!r || typeof r !== "object" || typeof r.tier !== "string" || !r.tier || "error" in r) return null;
  const axes = Object.entries(AXIS_LABELS)
    .map(([key, label]) => {
      const ax = r[key] as { score?: number; note?: string } | undefined;
      if (!ax || typeof ax !== "object" || typeof ax.score !== "number") return null;
      return { key, label, score: ax.score, note: ax.note };
    })
    .filter((a): a is NonNullable<typeof a> => a !== null);
  return {
    model: typeof r.model === "string" ? r.model : undefined,
    quality: typeof r.quality_score === "number" ? r.quality_score : undefined,
    checks: typeof r.checks_score === "number" ? r.checks_score : undefined,
    roles: Array.isArray(r.roles) ? r.roles.filter((x): x is string => typeof x === "string").slice(0, 3) : [],
    isPortfolio: r.is_portfolio !== false,
    axes,
  };
}

export type Standing = {
  tier: string | null;
  elo: number;
  faceoffs: number;
  /** Real face-offs (people's votes and AI comparisons), each counted once. */
  votes: number;
  top: number | null;
  of: number | null;
  provisional: boolean;
  /** Its starting rank came from automated checks (lib/check-points.mjs); `check` is the points breakdown. */
  seeded: boolean;
  check: ReturnType<typeof unpackCheck>;
};

function standingOf(raw: unknown): Standing | null {
  if (typeof raw !== "string") return null;
  try {
    const g = JSON.parse(raw);
    const tier = tierOf(g);
    const r = g?.rank;
    if (!tier || typeof r?.elo !== "number") return null;
    return {
      tier,
      elo: r.elo,
      faceoffs: Number(r.faceoffs ?? 0),
      votes: Number(r.votes ?? 0),
      top: typeof r.top === "number" ? r.top : null,
      of: typeof r.of === "number" ? r.of : null,
      provisional: r.provisional !== false,
      seeded: r.seeded === true,
      check: unpackCheck(r.check),
    };
  } catch {
    return null;
  }
}

export type Saved<T> = (T & { at: number }) | null;

export type Profile = {
  url: string;
  path: string;
  listed: Feed | null;
  name: string;
  tagline: string | null;
  domain: string;
  /** "listed", or how far an added site is: waiting to be graded, being graded, graded. */
  stage: "listed" | "pending" | "grading" | "graded" | "not_portfolio";
  standing: Standing;
  /** The tier shown (top tiers only; hidden by the owner hides it). */
  tier: string | null;
  report: ReportCard | null;
  /** The newest grade job for this site, while it isn't finished or it explains why. */
  job: { id: string; status: string; reason: string | null } | null;
  hideGrade: boolean;
  saved: { quick: Saved<QuickFacts>; share: Saved<ShareResult>; mobile: Saved<PsiResult>; desktop: Saved<PsiResult> };
  stars: number;
  saves: number;
};

const listedBy = new Map((feed as Feed[]).map((p) => [p.url, p]));

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A portfolio's profile, or null when PortfolioRank doesn't know the address (or its owner removed it). */
export async function loadProfile(url: string): Promise<Profile | null> {
  let siteKey: string;
  try {
    siteKey = siteKeyOf(url);
  } catch {
    return null;
  }
  await ensureSchema();
  const client = db();
  const listed = listedBy.get(url) ?? null;
  const owner = await ownerState(client, url);
  if (owner.removedAt) return null;

  const [rubricRow, jobRow, seenRow, cacheRows, stars, saves] = await Promise.all([
    listed ? client.execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] }).then((r) => r.rows[0]) : null,
    client.execute({ sql: "SELECT id, status, reason, result FROM grade_jobs WHERE site_key = ? ORDER BY created_at DESC LIMIT 1", args: [siteKey] }).then((r) => r.rows[0]),
    listed ? null : seen(client, url),
    client.execute({ sql: "SELECT k, v, at FROM cache WHERE k IN (?, ?, ?, ?)", args: [quickKey(siteKey), shareKey(url), psiKey("mobile", url), psiKey("desktop", url)] }).then((r) => r.rows),
    client.execute({ sql: "SELECT n FROM star_counts WHERE url = ?", args: [url] }).then((r) => Number(r.rows[0]?.n ?? 0)),
    client.execute({ sql: "SELECT COUNT(*) AS n FROM likes WHERE url = ?", args: [url] }).then((r) => Number(r.rows[0]?.n ?? 0)),
  ]);
  if (!listed && !seenRow && !jobRow) return null;

  const rows = new Map(cacheRows.map((r) => [String(r.k), r]));
  const read = <T,>(k: string): Saved<T> => {
    const r = rows.get(k);
    if (!r) return null;
    try {
      return { ...(JSON.parse(String(r.v)) as T), at: Number(r.at) };
    } catch {
      return null;
    }
  };
  const quick = read<QuickFacts>(quickKey(siteKey));
  const share = read<ShareResult>(shareKey(url));

  const jobResult = jobRow?.status === "done" && jobRow.result ? String(jobRow.result) : null;
  const report = owner.hideGrade ? null : reportCard(rubricRow?.ai_rubric ?? jobResult);
  // The letter, ELO and place derived on read from its rating row and the daily cutoffs (lib/tiers-db.mjs):
  // two reads by key, as current as the last vote. The points breakdown comes with the stored grade.
  const stored = standingOf(rubricRow?.ai_rubric);
  const [row, meta] = await Promise.all([readSiteRow(client, url), readTierMeta(client)]);
  const live = liveStanding(row, meta);
  const standing: Standing = {
    tier: stored ? (live.tier ?? stored.tier) : null,
    elo: live.elo,
    faceoffs: live.faceoffs,
    votes: live.votes,
    top: live.top,
    of: live.of,
    provisional: live.provisional,
    seeded: live.seeded,
    check: stored?.check ?? null,
  };
  const tier = !owner.hideGrade && isPublicTier(standing.tier) ? standing.tier : null;
  const stage: Profile["stage"] = listed
    ? "listed"
    : report
      ? report.isPortfolio
        ? "graded"
        : "not_portfolio"
      : jobRow && ["capturing", "grading", "queued", "awaiting_key"].includes(String(jobRow.status))
        ? "grading"
        : "pending";
  const title = (share?.ok && (share.card?.siteName || share.tags?.["og:title"] || share.tags?.title)) || (quick?.ok && quick.title) || null;
  return {
    url,
    path: profilePath(url),
    listed,
    name: listed?.name ?? (title ? String(title).split(/\s[|\-–]\s/)[0].slice(0, 80) : domainOf(url)),
    tagline: listed?.tagline ?? (share?.ok ? share.card?.description ?? null : null),
    domain: domainOf(url),
    stage,
    standing,
    tier,
    report,
    job: jobRow && jobRow.status !== "done" ? { id: String(jobRow.id), status: String(jobRow.status), reason: jobRow.reason == null ? null : String(jobRow.reason) } : null,
    hideGrade: owner.hideGrade,
    saved: { quick, share, mobile: read<PsiResult>(psiKey("mobile", url)), desktop: read<PsiResult>(psiKey("desktop", url)) },
    stars,
    saves,
  };
}
