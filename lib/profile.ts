import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { AI_CRITERIA } from "@/pipeline/rubric.mjs";
import { ownerState } from "@/lib/games/claims.mjs";
import { tierOf, isPublicTier } from "@/lib/tiers.mjs";
import { cachedLibraryState, entryIn } from "@/lib/tiers-store.mjs";
import { unpackCheck } from "@/lib/check-points.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { HIDDEN_WHERE } from "@/lib/hidden.mjs";
import { seen, seenId } from "@/lib/discovery/sites.mjs";
import { legacyAddress, profilePath, requestedSlug, slugKey } from "@/lib/profile-url.mjs";
import { cache } from "react";
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

/** /p/<host><path> (lib/profile-url.mjs). */
export { profilePath };

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
  /** The health check hides the site (down, dead, parked; lib/hidden.mjs): its profile isn't indexed. */
  hidden: boolean;
  /** The person's profiles their site links to (app/api/inspect, cached a week), when known. */
  socials: { github: string | null; linkedin: string | null; x: string | null };
};

/** The page check's cache key (app/api/inspect/route.ts, lib/cache.ts). */
const inspectKey = (url: string) => `inspect:${url}`;

/** An https link on one of these hosts, or null: scraped links are never trusted as they are. */
function socialLink(raw: unknown, hosts: RegExp): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && hosts.test(u.hostname) && u.pathname.length > 1 ? u.href : null;
  } catch {
    return null;
  }
}

const listedBy = new Map((feed as Feed[]).map((p) => [p.url, p]));

/** The list by site key: what a readable profile address (/p/<host><path>) is looked up by. */
const listedByKey = new Map(
  (feed as Feed[]).flatMap((p) => {
    try {
      return [[siteKeyOf(p.url), p.url] as const];
    } catch {
      return [];
    }
  })
);

/**
 * The stored address behind a site key (lib/profile-url.mjs slugKey): a listed
 * portfolio's, else the newest grade job's for that site, else the discovery
 * seen-set's while it keeps the address. Null when PortfolioRank doesn't know it.
 */
export async function profileUrlFor(key: string): Promise<string | null> {
  const listed = listedByKey.get(key);
  if (listed) return listed;
  await ensureSchema();
  const client = db();
  const job = await client.execute({ sql: "SELECT url FROM grade_jobs WHERE site_key = ? ORDER BY created_at DESC LIMIT 1", args: [key] });
  if (job.rows[0]?.url) return String(job.rows[0].url);
  const found = await client.execute({ sql: "SELECT url FROM discovery_sites WHERE id = ? AND url IS NOT NULL", args: [seenId(`https://${key}`)] });
  return found.rows[0]?.url ? String(found.rows[0].url) : null;
}

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
    listed ? client.execute({ sql: `SELECT ai_rubric, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, args: [url] }).then((r) => r.rows[0]) : null,
    client.execute({ sql: "SELECT id, status, reason, result FROM grade_jobs WHERE site_key = ? ORDER BY created_at DESC LIMIT 1", args: [siteKey] }).then((r) => r.rows[0]),
    listed ? null : seen(client, url),
    client.execute({ sql: "SELECT k, v, at FROM cache WHERE k IN (?, ?, ?, ?, ?)", args: [quickKey(siteKey), shareKey(url), psiKey("mobile", url), psiKey("desktop", url), inspectKey(url)] }).then((r) => r.rows),
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
  const inspected = read<{ githubUrl?: unknown; linkedinUrl?: unknown; xUrl?: unknown }>(inspectKey(url));

  const jobResult = jobRow?.status === "done" && jobRow.result ? String(jobRow.result) : null;
  const report = owner.hideGrade ? null : reportCard(rubricRow?.ai_rubric ?? jobResult);
  let standing = standingOf(rubricRow?.ai_rubric);
  if (!standing) {
    const e = entryIn(await cachedLibraryState(client), url);
    standing = { tier: null, elo: e.elo, faceoffs: e.faceoffs, votes: e.votes, top: null, of: null, provisional: true, seeded: false, check: null };
  }
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
    hidden: Number(rubricRow?.hidden ?? 0) === 1,
    socials: {
      github: socialLink(inspected?.githubUrl, /^(www\.)?github\.com$/i),
      linkedin: socialLink(inspected?.linkedinUrl, /^([a-z]{2,3}\.|www\.)?linkedin\.com$/i),
      x: socialLink(inspected?.xUrl, /^(www\.)?(x|twitter)\.com$/i),
    },
  };
}

/**
 * What a request for /p/<path> gets (`path`: the route's segments joined with
 * "/", still percent-encoded): the profile; a permanent redirect to its one
 * address (an old encoded address, or www, a scheme, another case); or null
 * for a site PortfolioRank doesn't know. Once per request (a string, so
 * React's cache matches it), shared by the page and its metadata.
 */
export const routeProfile = cache(async (path: string): Promise<{ to: string } | { p: Profile } | null> => {
  const slug = requestedSlug(path);
  const legacy = legacyAddress(slug);
  if (legacy) return { to: profilePath(legacy) };
  const key = slugKey(slug);
  const url = key ? await profileUrlFor(key) : null;
  const p = url ? await loadProfile(url) : null;
  if (!p) return null;
  return requestedSlug(p.path.slice("/p/".length)) === slug ? { p } : { to: p.path };
});
