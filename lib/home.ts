import feed from "@/data/feed.json";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { CONTRIBUTOR_COUNT_LABEL } from "@/lib/portfolio-count";
import { gradedPool, factLines, judgmentLines } from "@/lib/grader/report.mjs";
import { liveCounts, siteStats } from "@/lib/games/stats.mjs";
import { gamesEnabled } from "@/lib/games/server";
import { rankedSites } from "@/lib/tiers-board";
import { isPublicTier } from "@/lib/tiers.mjs";
import { readPolls } from "@/lib/polls/store.mjs";
import { publicPolls, type PublicPoll, type StoredPoll, type UpcomingPoll } from "@/lib/polls/server";

// The home page's data, all real, read once per render of the cached page
// (app/page.tsx is rendered at most every few minutes, never per visit).
// The slower numbers sit in the database cache for an hour, so a render costs
// a handful of indexed rows (docs/COSTS.md section C).

type FeedRow = { name: string; url: string; tagline?: string };
const FEED = feed as FeedRow[];
const byUrl = new Map(FEED.map((p) => [p.url, p]));
const HOUR = 60 * 60 * 1000;

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** A listed portfolio's page on PortfolioRank (its report). */
export const reportPath = (url: string) => `/p/${encodeURIComponent(url)}`;

/** The AI grade's "top N%" for a rank among `total`, never 0. */
export const topPct = (rank: number, total: number) => Math.max(1, Math.round((100 * rank) / Math.max(1, total)));

type PoolSite = {
  url: string;
  name: string;
  mu: number;
  tier: string;
  quality: number | null;
  axes: Record<string, number | null>;
  roles: string[];
};

/**
 * The graded, listed portfolios best first (by the AI grade's level), with
 * each one's rank by AI grade. The pool itself is cached an hour
 * (lib/grader/report.mjs gradedPool).
 */
async function rankedPool(): Promise<(PoolSite & { aiRank: number })[]> {
  await ensureSchema();
  const [pool, hidden] = await Promise.all([gradedPool(db()) as Promise<PoolSite[]>, hiddenUrls()]);
  return pool
    .filter((p) => byUrl.has(p.url) && !hidden.has(p.url))
    .sort((a, b) => b.mu - a.mu || (b.quality ?? 0) - (a.quality ?? 0) || a.url.localeCompare(b.url))
    .map((p, i) => ({ ...p, aiRank: i + 1 }));
}

/**
 * Showcase quality: Gemini scores visual design and the five-second test
 * from the very screenshot we show (the top-of-page capture,
 * pipeline/rubric.mjs buildRubricRequest), so a 5 for visual design and at
 * least 4 for the five-second test means the capture itself looks good: not
 * blank, not a cookie wall, not a broken layout. Blank and failed captures
 * never reach the grade at all (pipeline/capture.mjs gate).
 */
export const strongCapture = (p: Pick<PoolSite, "axes">) => p.axes.visual_design === 5 && (p.axes.five_second_test ?? 0) >= 4;

export type ShowItem = {
  url: string;
  name: string;
  domain: string;
  hero: string;
  tier: string;
  rank: number;
  href: string;
};

/** The hero's card deck: the best-graded portfolios whose screenshots are strong. */
async function showcase(pool: (PoolSite & { aiRank: number })[], count = 6): Promise<ShowItem[]> {
  const strong = pool.filter(strongCapture).slice(0, count * 2);
  const shots = await shotBases(strong.map((p) => p.url));
  return strong
    .filter((p) => shots.has(p.url))
    .slice(0, count)
    .map((p) => ({
      url: p.url,
      name: p.name,
      domain: domainOf(p.url),
      hero: heroOf(shots.get(p.url)!),
      tier: p.tier,
      rank: p.aiRank,
      href: reportPath(p.url),
    }));
}

export type BoardItem = {
  url: string;
  name: string;
  line: string;
  rank: number;
  tied: boolean;
  hero: string | null;
  /** What the score column shows: ELO, or the tier on the new boards. */
  score: string;
  href: string;
};

export type TopTen =
  | { kind: "ai"; rows: BoardItem[] }
  /** Tiers by ELO (RANKING_V2): the ranked board's first 10 (lib/tiers-board.ts), the score a tier by ELO. */
  | { kind: "ranked"; rows: BoardItem[] };

/**
 * The top 10. With RANKING_V2 on: the ranked board's first 10, tiers by ELO
 * (lib/tiers-board.ts), the same rows /top shows first. Until then the order
 * of the AI grade (the people's ELO board is too thin to rank on yet: most
 * sites share one vote), with the tier in the score column.
 */
async function topTen(pool: (PoolSite & { aiRank: number })[]): Promise<TopTen> {
  await ensureSchema();
  const item = (url: string, rank: number, score: string, tied = false): BoardItem => {
    const p = byUrl.get(url);
    return { url, name: p?.name ?? domainOf(url), line: p?.tagline || domainOf(url), rank, tied, hero: null, score, href: reportPath(url) };
  };
  if (/^true$/i.test(String(process.env.RANKING_V2 ?? ""))) {
    // Tiers by ELO: the ranked board's first 10, the same rows /top shows first (public letters only).
    const { sites } = await rankedSites(10);
    const rows = sites.map((s) => item(s.url, s.rank, isPublicTier(s.tier) ? s.tier : ""));
    const shots = await shotBases(rows.map((r) => r.url));
    for (const r of rows) r.hero = shots.has(r.url) ? heroOf(shots.get(r.url)!) : null;
    return { kind: "ranked", rows };
  }
  const rows = pool.slice(0, 10).map((p) => item(p.url, p.aiRank, p.tier));
  const shots = await shotBases(rows.map((r) => r.url));
  for (const r of rows) r.hero = shots.has(r.url) ? heroOf(shots.get(r.url)!) : null;
  return { kind: "ai", rows };
}

export type GradedItem = { url: string; name: string; domain: string; tier: string; at: string; hero: string | null; href: string };

/** The portfolios Gemini graded most recently. Cached an hour: it reads the whole list. */
async function recentlyGraded(count = 6): Promise<GradedItem[]> {
  const hidden = await hiddenUrls();
  const { items } = await cached<{ items: { url: string; tier: string; at: string }[] }>("home", "recent-grades", { ttlMs: HOUR }, async () => {
    const res = await db().execute(
      `SELECT url, json_extract(ai_rubric, '$.tier') AS tier, json_extract(ai_rubric, '$.judged_at') AS at
       FROM portfolios
       WHERE delisted_at IS NULL AND ai_rubric IS NOT NULL AND json_valid(ai_rubric)
         AND json_extract(ai_rubric, '$.tier') IS NOT NULL AND json_extract(ai_rubric, '$.judged_at') IS NOT NULL
         AND COALESCE(json_extract(ai_rubric, '$.is_portfolio'), 1) != 0
       ORDER BY at DESC LIMIT 30`
    );
    return { items: res.rows.map((r) => ({ url: String(r.url), tier: String(r.tier), at: String(r.at) })) };
  });
  const list = items.filter((r) => byUrl.has(r.url) && !hidden.has(r.url)).slice(0, count);
  const shots = await shotBases(list.map((r) => r.url));
  return list.map((r) => ({
    url: r.url,
    name: byUrl.get(r.url)?.name ?? domainOf(r.url),
    domain: domainOf(r.url),
    tier: r.tier,
    at: r.at,
    hero: shots.has(r.url) ? heroOf(shots.get(r.url)!) : null,
    href: reportPath(r.url),
  }));
}

export type LiveStat = { key: string; label: string; value: string; tone: 1 | 2 | 3 | 4 };

type SiteStats = Awaited<ReturnType<typeof siteStats>>;

/** The Live card's numbers: the same as /api/stats/live, read here so the page renders them. */
async function liveStats(listed: number, pool: PoolSite[]): Promise<LiveStat[]> {
  const now = new Date();
  const [site, counts, week] = await Promise.all([
    cached<SiteStats>("stats", "site", { ttlMs: HOUR }, () => siteStats(db(), { feed: FEED, now })),
    liveCounts(db(), { now }),
    // Votes in the last 7 days: a count over the log's recent rows, so an hour in the cache.
    cached<{ n: number }>("home", "votes-week", { ttlMs: HOUR }, async () => {
      const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
      const r = await db().execute({ sql: "SELECT COUNT(*) AS n FROM votes WHERE created_at >= ?", args: [since] });
      return { n: Number(r.rows[0]?.n ?? 0) };
    }),
  ]);
  const sGrades = pool.filter((p) => p.tier === "S").length;
  const n = (v: number) => v.toLocaleString("en-US");
  const out: (LiveStat | null)[] = [
    // The same count as the hero: listed and not hidden.
    { key: "portfolios", label: "Portfolios listed", value: n(listed), tone: 1 },
    // Beside it, the people who listed them (the community list's contributors).
    { key: "contributors", label: "Contributors to the list", value: CONTRIBUTOR_COUNT_LABEL, tone: 3 },
    // The same count as the AI ranks on this page (listed, graded, not hidden).
    { key: "graded", label: "Graded by AI", value: n(pool.length), tone: 2 },
    site.ownDomainPct == null ? null : { key: "own", label: "On their own domain", value: `${site.ownDomainPct}%`, tone: 4 },
    site.commonRole ? { key: "role", label: "Most common role", value: site.commonRole.label, tone: 3 } : null,
    // A quiet week would read as a dead site: then a number that is never 0.
    week.n > 0
      ? { key: "votesWeek", label: "Votes this week", value: n(week.n), tone: 3 }
      : { key: "sGrades", label: "Portfolios graded S", value: n(sGrades), tone: 3 },
    counts.votes > 0 ? { key: "votes", label: "Votes all time", value: n(counts.votes), tone: 1 } : null,
    site.resumePct == null ? null : { key: "resume", label: "Link a resume", value: `${site.resumePct}%`, tone: 2 },
    site.averageTier ? { key: "tier", label: "Average tier", value: site.averageTier.tier, tone: 4 } : null,
    site.gradedThisWeek > 0 ? { key: "week", label: "Graded this week", value: n(site.gradedThisWeek), tone: 2 } : null,
    site.changedThisMonth > 0 ? { key: "changed", label: "Sites changed this month", value: n(site.changedThisMonth), tone: 4 } : null,
    gamesEnabled() && counts.quizzesPlayed > 0 ? { key: "quizzes", label: "Quizzes played", value: n(counts.quizzesPlayed), tone: 1 } : null,
  ];
  return out.filter((s): s is LiveStat => s !== null);
}

export type PortfolioOfTheDay = {
  url: string;
  name: string;
  line: string;
  domain: string;
  hero: string;
  tier: string;
  rank: number;
  total: number;
  best: { label: string; note: string }[];
  facts: { id: string; label: string; pass: boolean }[];
  href: string;
};

/** One strong portfolio a day, the same for everyone, never one the hero shows. */
async function portfolioOfTheDay(pool: (PoolSite & { aiRank: number })[], skip: Set<string>, now = new Date()): Promise<PortfolioOfTheDay | null> {
  const candidates = pool.filter((p) => strongCapture(p) && !skip.has(p.url) && (p.tier === "S" || p.tier === "A")).slice(0, 100);
  if (candidates.length === 0) return null;
  const day = Math.floor(now.getTime() / 86_400_000);
  // Walk from today's pick to the first one with a capture.
  for (let k = 0; k < Math.min(candidates.length, 8); k++) {
    const p = candidates[(day * 37 + k) % candidates.length];
    const [shots, row] = await Promise.all([
      shotBases([p.url]),
      db().execute({ sql: "SELECT ai_rubric FROM portfolios WHERE url = ?", args: [p.url] }),
    ]);
    const base = shots.get(p.url);
    if (!base) continue;
    let grade: Record<string, unknown> = {};
    try {
      grade = JSON.parse(String(row.rows[0]?.ai_rubric ?? "{}"));
    } catch {}
    const judgments = (judgmentLines(grade) as { label: string; score: number | null; note: string }[])
      .filter((j) => typeof j.score === "number" && j.note)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const facts = (factLines(grade) as { id: string; label: string; pass: boolean | null }[]).filter((f) => f.pass !== null) as {
      id: string;
      label: string;
      pass: boolean;
    }[];
    return {
      url: p.url,
      name: p.name,
      line: byUrl.get(p.url)?.tagline || domainOf(p.url),
      domain: domainOf(p.url),
      hero: heroOf(base),
      tier: p.tier,
      rank: p.aiRank,
      total: pool.length,
      best: judgments.slice(0, 2).map((j) => ({ label: j.label, note: j.note })),
      facts: facts.slice(0, 6),
      href: reportPath(p.url),
    };
  }
  return null;
}

/** This week's poll, the next ones scheduled and the last results. */
async function polls(): Promise<{ active: PublicPoll | null; upcoming: UpcomingPoll[]; past: PublicPoll[] }> {
  const read = (await readPolls(db(), { now: new Date(), past: 3, upcoming: 3 })) as { active: StoredPoll | null; upcoming: UpcomingPoll[]; past: StoredPoll[] };
  const all = await publicPolls(read.active ? [read.active, ...read.past] : read.past);
  const upcoming = read.upcoming;
  return read.active ? { active: all[0], upcoming, past: all.slice(1) } : { active: null, upcoming, past: all };
}

export type HomeData = Awaited<ReturnType<typeof homeData>>;

export async function homeData() {
  await ensureSchema();
  const pool = await rankedPool();
  const hidden = await hiddenUrls();
  const total = FEED.filter((p) => !hidden.has(p.url)).length;
  const [show, top, recent, stats, poll] = await Promise.all([showcase(pool), topTen(pool), recentlyGraded(), liveStats(total, pool), polls()]);
  const potd = await portfolioOfTheDay(pool, new Set(show.map((s) => s.url)));
  return {
    /** Listed portfolios anyone can see (the browse grid's count). */
    total,
    showcase: show,
    top,
    recent,
    stats,
    potd,
    polls: poll,
    /** When this render read the data: what "3 days ago" counts from. */
    at: Date.now(),
  };
}
