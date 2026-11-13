import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { gamesEnabled } from "@/lib/games/server";
import { ownedJobs } from "@/lib/grader/server";
import { readJob } from "@/lib/grader/jobs.mjs";
import { publicJob } from "@/lib/grader/view.mjs";
import { withEloLetters } from "@/lib/tiers-letters.mjs";
import { readSiteRow, readTierMeta } from "@/lib/tiers-db.mjs";
import { placeGrade } from "@/lib/tiers-store.mjs";
import { MIN_FACEOFFS, familyOf } from "@/lib/tiers.mjs";
import { tiersShown } from "@/lib/tiers-view";
import { emailState } from "@/lib/grader/notify.mjs";
import { gradedPool } from "@/lib/grader/report.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { fixEffects, hiringGroups, placeIn, verdictOf } from "@/lib/grader/present.mjs";
import { listedSite, type Job } from "@/lib/me";
import { reportPath } from "@/lib/home";

// What the grade report page (app/grade/[id]) reads for one job: the public
// job (lib/grader/view.mjs, the same answer GET /api/grade/<id> gives), plus
// what the page shows around it: the listed portfolio it is about (if any),
// screenshots of the portfolios it points to, their place on the board, and
// the wording from lib/grader/present.mjs. Reports are unlisted: the id is
// the only key, and nothing here names the visitor.

type PoolSite = { url: string; name: string; mu: number; tier: string };
export type PageJob = Job & { mine: boolean; checks: (Job["checks"] & { title?: string }) | null };

export type ShownSite = { url: string; name: string; domain: string; tier: string; path: string; hero: string | null; rank: number | null; topPct: number | null };

export type GradePage = {
  job: PageJob;
  /** The page's own name: the list's name, the page title, else the domain. */
  name: string;
  hero: string | null;
  /** The phone screenshot (390 px wide), when the grade captured one. */
  mobile: string | null;
  /**
   * The result, from day one (owner, 2026-11-13): the tier and its own "top
   * N%" from the same ranking, so they never disagree, and the face-offs so
   * far, which say how settled it is (MIN_FACEOFFS: settled). A starting
   * tier from automated checks tops out at A: S is earned in face-offs.
   * Null for "not a portfolio" or no usable grade.
   */
  standing: { tier: string; topPct: number | null; faceoffs: number; starting: boolean } | null;
  /** The listed portfolio this grade is about, when it's on the list. */
  listed: { url: string; path: string } | null;
  /** GAMES_V2: claims and owner actions are open. */
  games: boolean;
  /** When this was read: what "re-grade available in N days" counts from. */
  at: number;
  /** The free checks in the hiring manager's three groups, for a job with no report (yet). */
  checks: ReturnType<typeof hiringGroups> | null;
  report: null | {
    verdict: string;
    groups: ReturnType<typeof hiringGroups>;
    fixes: { criterion: string; title: string; why: string; by: "ai" | "code"; effect: string | null }[];
    better: null | { site: ShownSite; label: string; yours: number; theirs: number; note: string };
    similar: ShownSite[];
  };
};

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Sites whose grade the page must not show: removed by their owner or with the grade hidden, or down. */
async function gradeHiddenUrls(): Promise<Set<string>> {
  const out = new Set(await hiddenUrls());
  try {
    const rows = (await db().execute("SELECT url FROM portfolio_owner WHERE removed_at IS NOT NULL OR hide_grade = 1")).rows;
    for (const r of rows) out.add(String(r.url));
  } catch {}
  return out;
}

/** The note the AI wrote for one axis of a listed portfolio's grade (one row by primary key). */
async function axisNote(url: string, criterion: string): Promise<string> {
  const r = (await db().execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [url] })).rows[0];
  try {
    const g = JSON.parse(String(r?.ai_rubric ?? "null"));
    const note = g?.[criterion]?.note;
    return typeof note === "string" ? note : "";
  } catch {
    return "";
  }
}

/** The page's data for one grade, or null when there is no such report. */
export async function gradePage(id: string): Promise<GradePage | null> {
  await ensureSchema();
  const client = db();
  const raw = await readJob(client, id);
  if (!raw) return null;
  const [owned, emails] = await Promise.all([ownedJobs(), emailState(client, id)]);
  const plain = publicJob(raw, { mine: owned.includes(id), emails }) as PageJob;
  // The report card's own line follows Gemini's letter; the letter shown is the tier by ELO while RANKING_V2 is on.
  const geminiTier = plain.report?.tier ?? "";
  const job = (tiersShown() ? await withEloLetters(client, plain, raw) : plain) as PageJob;
  const site = listedSite(String(raw.site_key));
  const title = job.checks?.ok && typeof job.checks.title === "string" ? job.checks.title.replace(/\s+/g, " ").trim() : "";
  const name = site?.name ?? (title && title.length <= 60 ? title : job.domain);
  let hero = job.shots?.hero ?? null;
  if (!hero && site) {
    const shots = await shotBases([site.url]);
    hero = shots.has(site.url) ? heroOf(shots.get(site.url)!) : null;
  }
  const freeChecks = job.checks?.ok ? hiringGroups((job.checks as { facts?: Parameters<typeof hiringGroups>[0] }).facts ?? []) : null;
  const standing = await standingFor(client, site?.url ?? null, raw.result);
  const base = { job, name, hero, mobile: job.shots?.mobile ?? null, standing, listed: site ? { url: site.url, path: reportPath(site.url) } : null, games: gamesEnabled(), at: Date.now(), checks: freeChecks?.length ? freeChecks : null };
  if (!job.report || !raw.result) return { ...base, report: null };

  const rep = job.report;
  const selfKey = String(raw.site_key);
  const isSelf = (url: string) => {
    try {
      return siteKeyOf(url) === selfKey;
    } catch {
      return false;
    }
  };
  const [pool, hidden] = await Promise.all([gradedPool(client) as Promise<PoolSite[]>, gradeHiddenUrls()]);
  const shown = (s: { url: string }) => !hidden.has(s.url) && !isSelf(s.url);
  const similar = rep.similar.filter(shown).slice(0, 4);
  const betterGroup = rep.better.map((b) => ({ ...b, sites: b.sites.filter(shown) })).find((b) => b.sites.length > 0) ?? null;
  const urls = [...similar.map((s) => s.url), ...(betterGroup ? [betterGroup.sites[0].url] : [])];
  const shots = await shotBases([...new Set(urls)]);
  const place = (url: string) => placeIn(pool, url);
  const toShown = (s: (typeof similar)[number]): ShownSite => ({
    ...s,
    domain: s.domain || domainOf(s.url),
    hero: shots.has(s.url) ? heroOf(shots.get(s.url)!) : null,
    rank: place(s.url)?.rank ?? null,
    topPct: place(s.url)?.topPct ?? null,
  });

  let better: NonNullable<GradePage["report"]>["better"] = null;
  if (betterGroup) {
    const s = betterGroup.sites[0];
    better = { site: toShown(s), label: betterGroup.label, yours: betterGroup.yours, theirs: 5, note: await axisNote(s.url, betterGroup.criterion) };
  }

  return {
    ...base,
    report: {
      verdict: verdictOf(geminiTier),
      groups: hiringGroups(rep.facts),
      fixes: fixEffects(raw.result, rep.fixes, pool, { isSelf }),
      better,
      similar: similar.map(toShown),
    },
  };
}

/** Two listed portfolios with screenshots, for the face-off card while a grade runs. */
export async function faceOffPair(): Promise<{ url: string; domain: string; hero: string }[]> {
  try {
    await ensureSchema();
    const pool = (await gradedPool(db())) as PoolSite[];
    const hidden = await gradeHiddenUrls();
    const pick = pool.filter((p) => !hidden.has(p.url) && p.tier && ["S", "A"].includes(p.tier));
    for (let i = pick.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pick[i], pick[j]] = [pick[j], pick[i]];
    }
    const sample = pick.slice(0, 12).map((p) => p.url);
    const shots = await shotBases(sample);
    return sample
      .filter((u) => shots.has(u))
      .slice(0, 2)
      .map((u) => ({ url: u, domain: domainOf(u), hero: heroOf(shots.get(u)!) }));
  } catch {
    return [];
  }
}

/**
 * The grade's tier and "top N%" by ELO (lib/tiers-store.mjs placeGrade): a
 * listed site's own rating row, else a starting rank from the points its
 * grade shows, placed in the daily cutoffs. Before MIN_FACEOFFS face-offs it
 * is a starting tier, and a starting tier is never S (owner: the best start
 * is A; S is earned through face-off wins).
 */
async function standingFor(client: ReturnType<typeof db>, url: string | null, result: unknown): Promise<GradePage["standing"]> {
  try {
    const grade = typeof result === "string" ? JSON.parse(result) : result;
    if (!grade || typeof grade !== "object" || (grade as { is_portfolio?: boolean }).is_portfolio === false) return null;
    const [row, meta] = await Promise.all([url ? readSiteRow(client, url) : null, readTierMeta(client)]);
    const rank = placeGrade(grade, { meta, row: row && !row.fresh ? row : null });
    if (!rank?.tier) return null;
    const faceoffs = Math.floor(Number(rank.faceoffs ?? 0));
    const starting = faceoffs < MIN_FACEOFFS;
    const tier = starting && familyOf(rank.tier) === "S" ? "A+" : String(rank.tier);
    return { tier, topPct: typeof rank.top === "number" ? rank.top : null, faceoffs, starting };
  } catch {
    return null;
  }
}
