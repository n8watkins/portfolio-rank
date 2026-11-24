import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { geminiAnswered, keptOutputs, versionOf } from "@/pipeline/rubric.mjs";
import { ownerState } from "@/lib/games/claims.mjs";
import { BASE_ELO } from "@/lib/elo";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { seen } from "@/lib/discovery/sites.mjs";
import { GONE_WHERE, HIDDEN_WHERE } from "@/lib/hidden.mjs";
import { indexable, profilePageLd, socialsFrom, type SeoFacts } from "@/lib/profile-seo";
import { breadcrumbList, graph } from "@/lib/json-ld";
import { SITE, SITE_URL } from "@/lib/site";
import { cache } from "react";
import type { QuickFacts } from "@/lib/grader/quick";
import type { PsiResult } from "@/lib/tools/psi";
import type { ShareResult } from "@/lib/tools/share";
import { psiKey, quickKey, shareKey } from "@/lib/tools/keys";
import { freshGrade } from "@/lib/fresh-facts.mjs";
import { visitAddress } from "@/lib/visit-address.mjs";
import { inLibrary } from "@/lib/tiers-store.mjs";

// Everything a portfolio's profile (/p/<address>) shows, for a listed
// portfolio or one added through "Add your portfolio" (the discovery
// seen-set, or a grade asked for it): its rank, its report card (the AI
// grade: the list's, else the newest finished "grade my portfolio" job),
// and the saved results of every check (lib/tools), from which the fix list
// is built. Read-only; nothing here names who is looking.

export type Feed = { name: string; url: string; tagline?: string };

export const profilePath = (url: string) => `/p/${encodeURIComponent(url)}`;

/**
 * What a profile reads from Gemini's stored answer (owner, 2026-11-23: no
 * Gemini report card is shown): whether it is a portfolio, which decides
 * whether search engines may index the page, and the roles, which name the
 * page for search (lib/profile-seo.ts). The reason, and an older grade's
 * letter and dropped scores (the five-second test among them), stay in the
 * database and are never read here.
 */
export type ReportCard = {
  model?: string;
  checks?: number;
  roles: string[];
  isPortfolio: boolean;
  /** The rubric version the grade was made with (1 for the oldest grades). */
  rubricVersion: number;
  /** When Gemini answered (ISO), or null. */
  judgedAt: string | null;
};

/** What a profile reads from Gemini's answer (above), or null for none or an error. */
export function reportCard(raw: unknown): ReportCard | null {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!geminiAnswered(parsed)) return null;
  const r = keptOutputs(parsed) as Record<string, unknown>;
  return {
    model: typeof r.model === "string" ? r.model : undefined,
    checks: typeof r.checks_score === "number" ? r.checks_score : undefined,
    roles: Array.isArray(r.roles) ? r.roles.filter((x): x is string => typeof x === "string").slice(0, 3) : [],
    isPortfolio: r.is_portfolio !== false,
    rubricVersion: versionOf(r),
    judgedAt: typeof r.judged_at === "string" ? r.judged_at : null,
  };
}

/**
 * Where a portfolio stands in the face-offs: its ELO and how many votes it
 * has (the ratings table). Tier letters come with the tiers work (#189).
 */
export type Standing = { elo: number; faceoffs: number };

export type Saved<T> = (T & { at: number }) | null;

export type Profile = {
  url: string;
  /**
   * Where "Visit" goes: the listed address, or, while the health check has found the listed address failing
   * and the site answering at its own www or https form (health_marks.answers_at), that working address.
   */
  visitUrl: string;
  path: string;
  listed: Feed | null;
  name: string;
  tagline: string | null;
  domain: string;
  /** "listed", or how far an added site is: waiting to be graded, being graded, graded. */
  stage: "listed" | "pending" | "grading" | "graded" | "not_portfolio";
  standing: Standing;
  report: ReportCard | null;
  /** The newest grade job for this site, while it isn't finished or it explains why. */
  job: { id: string; status: string; reason: string | null } | null;
  hideGrade: boolean;
  /**
   * A listed site that is not working (lib/hidden.mjs GONE_WHERE): its public page answers not found
   * (app/p/[slug]), while its owner's tools (claim, verify, owner actions) still find it.
   */
  gone: boolean;
  saved: { quick: Saved<QuickFacts>; share: Saved<ShareResult>; mobile: Saved<PsiResult>; desktop: Saved<PsiResult> };
  stars: number;
  saves: number;
};

const listedBy = new Map((feed as Feed[]).map((p) => [p.url, p]));

export { visitAddress };

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
  // Fresh, never the minute cache: this render is kept at the edge for a day.
  const owner = await ownerState(client, url, { fresh: true });
  if (owner.removedAt) return null;

  const [rubricRow, jobRow, seenRow, cacheRows, stars, saves, rating] = await Promise.all([
    listed
      ? client
          .execute({
            // answers_at: where the site answers while its listed address does not (pipeline/health.mjs sameSiteAddress).
            sql: `SELECT ai_rubric, facts, (${GONE_WHERE}) AS gone, (SELECT m.answers_at FROM health_marks m WHERE m.url = portfolios.url) AS answers_at FROM portfolios WHERE url = ?`,
            args: [url],
          })
          .then((r) => r.rows[0])
      : null,
    client.execute({ sql: "SELECT id, status, reason, result FROM grade_jobs WHERE site_key = ? ORDER BY created_at DESC LIMIT 1", args: [siteKey] }).then((r) => r.rows[0]),
    listed ? null : seen(client, url),
    client.execute({ sql: "SELECT k, v, at FROM cache WHERE k IN (?, ?, ?, ?)", args: [quickKey(siteKey), shareKey(url), psiKey("mobile", url), psiKey("desktop", url)] }).then((r) => r.rows),
    client.execute({ sql: "SELECT n FROM star_counts WHERE url = ?", args: [url] }).then((r) => Number(r.rows[0]?.n ?? 0)),
    client.execute({ sql: "SELECT COUNT(*) AS n FROM likes WHERE url = ?", args: [url] }).then((r) => Number(r.rows[0]?.n ?? 0)),
    listed ? client.execute({ sql: "SELECT elo, votes FROM ratings WHERE url = ?", args: [url] }).then((r) => r.rows[0]) : null,
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
  // A listed site's code checks from its newest measured facts (lib/fresh-facts.mjs).
  const report = owner.hideGrade ? null : reportCard(rubricRow?.ai_rubric != null ? freshGrade(rubricRow.ai_rubric, rubricRow.facts) : jobResult);
  const standing: Standing = rating ? { elo: Number(rating.elo), faceoffs: Number(rating.votes) } : { elo: BASE_ELO, faceoffs: 0 };
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
    visitUrl: visitAddress(url, rubricRow?.answers_at),
    path: profilePath(url),
    listed,
    name: listed?.name ?? (title ? String(title).split(/\s[|\-–]\s/)[0].slice(0, 80) : domainOf(url)),
    tagline: listed?.tagline ?? (share?.ok ? share.card?.description ?? null : null),
    domain: domainOf(url),
    stage,
    standing,
    report,
    job: jobRow && jobRow.status !== "done" ? { id: String(jobRow.id), status: String(jobRow.status), reason: jobRow.reason == null ? null : String(jobRow.reason) } : null,
    hideGrade: owner.hideGrade,
    gone: Boolean(listed) && Number(rubricRow?.gone ?? 0) === 1,
    saved: { quick, share, mobile: read<PsiResult>(psiKey("mobile", url)), desktop: read<PsiResult>(psiKey("desktop", url)) },
    stars,
    saves,
  };
}

/**
 * A profile's JSON-LD: the ProfilePage about the person and its breadcrumb
 * trail (PortfolioRank > Browse > name), for an indexable profile only.
 */
export function profileJsonLd(f: SeoFacts, { canonical, title }: { canonical: string; title: string }) {
  if (!indexable(f)) return null;
  return graph([
    profilePageLd(f, { canonical, title, siteUrl: SITE_URL, siteName: SITE.name }),
    breadcrumbList([
      { name: SITE.name, url: SITE_URL },
      { name: "Browse", url: `${SITE_URL}/browse` },
      { name: f.name, url: canonical },
    ]),
  ]);
}

/**
 * What search engines read about a site beyond what its profile shows
 * (lib/profile-seo.ts): the list's AI grade (null when the owner hid it),
 * whether the health check hides the site, and the social links its page
 * check found. One batch of reads, once per request (the page and its
 * metadata share it).
 */
export const loadSeoExtras = cache(async (url: string): Promise<Pick<SeoFacts, "report" | "hidden" | "inLibrary" | "socials">> => {
  await ensureSchema();
  const client = db();
  const [row, inspect, owner, listed] = await Promise.all([
    client.execute({ sql: `SELECT ai_rubric, facts, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, args: [url] }).then((r) => r.rows[0]),
    client.execute({ sql: "SELECT v FROM cache WHERE k = ?", args: [`inspect:${url}`] }).then((r) => r.rows[0]),
    ownerState(client, url, { fresh: true }),
    inLibrary(client, url),
  ]);
  let inspected = null;
  try {
    inspected = inspect ? JSON.parse(String(inspect.v)) : null;
  } catch {}
  return {
    report: owner.hideGrade || row?.ai_rubric == null ? null : reportCard(freshGrade(row.ai_rubric, row.facts)),
    hidden: Number(row?.hidden ?? 0) === 1,
    inLibrary: listed,
    socials: socialsFrom(inspected),
  };
});
