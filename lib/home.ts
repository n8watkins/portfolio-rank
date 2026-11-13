import feed from "@/data/feed.json";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { CONTRIBUTOR_COUNT_LABEL } from "@/lib/portfolio-count";
import { gradedPool, factLines, judgmentLines } from "@/lib/grader/report.mjs";
import { liveCounts, siteStats } from "@/lib/games/stats.mjs";
import { atLeast, isPublicTier } from "@/lib/tiers.mjs";
import { gamesEnabled } from "@/lib/games/server";
import { rankedOrder } from "@/lib/leaderboard";
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
  /** The grade key (lib/grade-score.mjs) and the tier by ELO from face-offs (lib/tiers.mjs). */
  key: number | null;
  tier: string | null;
  quality: number | null;
  axes: Record<string, number | null>;
  roles: string[];
};

/** A graded portfolio in the leaderboard's ranked order: its place on the board, tier, ELO and face-offs. */
type HomeSite = PoolSite & { rank: number; elo: number; faceoffs: number; top: number | null };

/**
 * The graded, listed portfolios in the leaderboard's ranked order (by tier,
 * then ELO from face-offs: lib/leaderboard.ts rankedOrder), each with its
 * place on that board, so the home page and /top tell one story. The pool
 * (axes, roles) is cached an hour (lib/grader/report.mjs gradedPool), the
 * order is one cached row.
 */
async function rankedPool(): Promise<HomeSite[]> {
  await ensureSchema();
  const [pool, order] = await Promise.all([gradedPool(db()) as Promise<PoolSite[]>, rankedOrder()]);
  const byPool = new Map(pool.map((p) => [p.url, p]));
  return order
    .map((r, i) => ({ r, rank: i + 1, p: byPool.get(r.e.url) }))
    .filter((x): x is { r: (typeof order)[number]; rank: number; p: PoolSite } => x.p != null)
    .map(({ r, rank, p }) => ({ ...p, tier: r.p.tier, rank, elo: r.e.elo, faceoffs: r.e.faceoffs, top: r.p.provisional ? null : r.p.top }));
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
  tier: string | null;
  rank: number;
  href: string;
};

/** The hero's card deck: the best-graded portfolios whose screenshots are strong. */
async function showcase(pool: HomeSite[], count = 6): Promise<ShowItem[]> {
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
      rank: p.rank,
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
  /** The public tier by ELO (lib/tiers.mjs), or "" for none. */
  tier: string;
  /** The ELO from face-offs; null without face-offs. */
  elo: number | null;
  href: string;
};

export type TopTen = { kind: "ranked"; rows: BoardItem[] };

/** The top 10 of the leaderboard's ranked board (tiers by ELO, graded only), the same rows /top shows first. */
async function topTen(pool: HomeSite[]): Promise<TopTen> {
  const rows: BoardItem[] = pool.slice(0, 10).map((p) => {
    const f = byUrl.get(p.url);
    return {
      url: p.url,
      name: f?.name ?? domainOf(p.url),
      line: f?.tagline || domainOf(p.url),
      rank: p.rank,
      tied: false,
      hero: null,
      tier: isPublicTier(p.tier) ? p.tier! : "",
      elo: p.faceoffs > 0 ? p.elo : null,
      href: reportPath(p.url),
    };
  });
  const shots = await shotBases(rows.map((r) => r.url));
  for (const r of rows) r.hero = shots.has(r.url) ? heroOf(shots.get(r.url)!) : null;
  return { kind: "ranked", rows };
}

/** `tier` is the tier by rank (lib/tiers.mjs); shown publicly only from B up. */
export type GradedItem = { url: string; name: string; domain: string; tier: string; at: string; hero: string | null; href: string };

/** The portfolios Gemini graded most recently. Cached an hour: it reads the whole list. */
async function recentlyGraded(count = 6): Promise<GradedItem[]> {
  const hidden = await hiddenUrls();
  // v3: the tier by ELO from face-offs (lib/tiers.mjs), not Gemini's letter or the old tier by grade score.
  const { items } = await cached<{ items: { url: string; tier: string; at: string }[] }>("home", "recent-grades-v3", { ttlMs: HOUR }, async () => {
    const res = await db().execute(
      `SELECT url, json_extract(ai_rubric, '$.rank.tier') AS tier, json_extract(ai_rubric, '$.judged_at') AS at
       FROM portfolios
       WHERE delisted_at IS NULL AND ai_rubric IS NOT NULL AND json_valid(ai_rubric)
         AND json_extract(ai_rubric, '$.rank.tier') IS NOT NULL AND json_extract(ai_rubric, '$.judged_at') IS NOT NULL
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
  // The S family: the top 1% (SSS to S-, lib/tiers.mjs).
  // Tiers come from face-offs and start at B, so the count that is never 0 is the graded library.
  const graded = pool.length;
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
      : { key: "graded", label: "Portfolios graded", value: n(graded), tone: 3 },
    counts.votes > 0 ? { key: "votes", label: "Votes all time", value: n(counts.votes), tone: 1 } : null,
    site.resumePct == null ? null : { key: "resume", label: "Link a resume", value: `${site.resumePct}%`, tone: 2 },
    // No "Average tier": tiers by ELO (lib/tiers.mjs) make it B by design.
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
  tier: string | null;
  /** Its place on the leaderboard's ranked board (tier, then ELO), its "top N%" once it has a tier of its own, and its ELO. */
  rank: number;
  top: number | null;
  elo: number | null;
  total: number;
  best: { label: string; note: string }[];
  facts: { id: string; label: string; pass: boolean }[];
  href: string;
};

/** One strong portfolio a day, the same for everyone, never one the hero shows. */
async function portfolioOfTheDay(pool: HomeSite[], skip: Set<string>, now = new Date()): Promise<PortfolioOfTheDay | null> {
  // The A family or better: the top 30% by ELO (SSS to A-, lib/tiers.mjs); while few have enough
  // face-offs for a tier, the best AI grades (the pool is in grade order).
  const open = pool.filter((p) => strongCapture(p) && !skip.has(p.url));
  const strong = open.filter((p) => atLeast(p.tier, "A"));
  const candidates = (strong.length >= 10 ? strong : open).slice(0, 100);
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
      rank: p.rank,
      total: pool.length,
      top: p.top,
      elo: p.faceoffs > 0 ? p.elo : null,
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
