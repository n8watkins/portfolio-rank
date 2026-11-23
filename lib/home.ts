import feed from "@/data/feed.json";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { heroOf, shotBases } from "@/lib/shots";
import { hiddenUrls } from "@/lib/roster";
import { CONTRIBUTOR_COUNT_LABEL } from "@/lib/portfolio-count";
import { factLines } from "@/lib/grader/report.mjs";
import { freshGrade } from "@/lib/fresh-facts.mjs";
import { GEMINI_SAYS_PORTFOLIO_SQL } from "@/pipeline/rubric.mjs";
import { liveCounts, siteStats } from "@/lib/games/stats.mjs";
import { gamesEnabled } from "@/lib/games/server";
import { rankedSites } from "@/lib/tiers-board";
import { eloOrder } from "@/lib/leaderboard";
import { familyOf, isPublicTier, tierLabel } from "@/lib/tiers.mjs";
import { peekTierMeta } from "@/lib/tiers-db.mjs";
import { publicLetters, siteTiers } from "@/lib/tiers-letters.mjs";
import { tiersShown } from "@/lib/tiers-view";
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

/** "Top N%" for a rank among `total`, never 0. */
export const topPct = (rank: number, total: number) => Math.max(1, Math.round((100 * rank) / Math.max(1, total)));

/** How many of the ranked order the home page reads: the cards pick from its best. */
const POOL_SIZE = 300;

type PoolSite = {
  url: string;
  name: string;
  /** Its place in the order /top shows (boardOrder). */
  rank: number;
  /** Its Tier (every letter) while tiers are shown, else null: shown only when public. Never Gemini's letter. */
  tier: string | null;
};

/** True while tiers by ELO are on (RANKING_V2), as /top reads it (lib/leaderboard.ts rankingViewsEnabled). */
const rankingV2 = () => /^true$/i.test(String(process.env.RANKING_V2 ?? ""));

/**
 * The order /top shows, so the home page's Top 10 and its "#N" places come
 * from the same order in each flag state: with RANKING_V2 on, the ranked
 * board (code checks, then votes; lib/tiers-board.ts rankedSites); with it
 * off, the people's ELO board (sites with at least one person's vote, best
 * ELO first; lib/leaderboard.ts eloOrder). Never Gemini's order or letter.
 * A database error is thrown to the page's error path, never shown as an
 * empty board.
 */
async function boardOrder(limit: number): Promise<{ sites: PoolSite[]; total: number }> {
  if (rankingV2()) {
    const { sites, total } = await rankedSites(limit);
    return { sites: sites.map((s) => ({ url: s.url, name: s.name, rank: s.rank, tier: s.tier })), total };
  }
  // The whole ELO board (people's votes only, so a few hundred rows), so `total` is its size.
  const all = await eloOrder(100_000);
  return { sites: all.slice(0, limit).map((r, i) => ({ url: r.url, name: byUrl.get(r.url)?.name ?? domainOf(r.url), rank: i + 1, tier: null })), total: all.length };
}

/**
 * The best of /top's order, for the showcase and the portfolio of the day.
 * Cached an hour, as the AI-grade pool it replaced was, so their "#N" can lag
 * /top by up to an hour; the Top 10 reads the order fresh (topTen). No Gemini
 * answer is read (owner, 2026-11-23).
 */
async function rankedPool(): Promise<{ pool: PoolSite[]; total: number }> {
  await ensureSchema();
  const { sites, total } = await cached<{ sites: PoolSite[]; total: number }>("home", `pool:${rankingV2() ? "tiers" : "elo"}`, { ttlMs: HOUR }, () =>
    boardOrder(POOL_SIZE)
  );
  return { pool: sites, total };
}

/**
 * The letter a home card shows for each site: its public Tier while tiers are
 * shown (RANKING_V2), else none. Never Gemini's letter (owner, 2026-11-22).
 */
async function lettersFor(urls: string[]): Promise<Map<string, string | null>> {
  if (!tiersShown() || !urls.length) return new Map();
  return publicLetters(db(), urls).catch(() => new Map());
}

export type ShowItem = {
  url: string;
  name: string;
  domain: string;
  hero: string;
  /** The public Tier, or null (tiers hidden, or none). */
  tier: string | null;
  rank: number;
  href: string;
};

/** The hero's card deck: the best-ranked portfolios that have a stored screenshot, in /top's order. */
async function showcase(pool: PoolSite[], count = 6): Promise<ShowItem[]> {
  // The best of the order with a stored screenshot (no Gemini score picks them, owner 2026-11-23).
  const strong = pool.slice(0, count * 4);
  const shots = await shotBases(strong.map((p) => p.url));
  const picked = strong.filter((p) => shots.has(p.url)).slice(0, count);
  const letters = await lettersFor(picked.map((p) => p.url));
  return picked.map((p) => ({
    url: p.url,
    name: p.name,
    domain: domainOf(p.url),
    hero: heroOf(shots.get(p.url)!),
    tier: letters.get(p.url) ?? null,
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
  /** What the score column shows: ELO, or the tier on the new boards. */
  score: string;
  href: string;
};

export type TopTen =
  /** RANKING_V2 off: the first 10 of the people's ELO board /top shows (lib/leaderboard.ts eloOrder), the score its ELO. */
  | { kind: "elo"; rows: BoardItem[] }
  /** Tiers by ELO (RANKING_V2): the ranked board's first 10 (lib/tiers-board.ts), the score a tier by ELO. */
  | { kind: "ranked"; rows: BoardItem[] };

/**
 * The top 10: the same first 10 rows /top shows, read fresh, in each flag
 * state. With RANKING_V2 on, the ranked board (code checks, then votes) with
 * each public Tier; with it off, the people's ELO board with each ELO. Never
 * Gemini's order or letter (owner, 2026-11-22).
 */
async function topTen(): Promise<TopTen> {
  const item = (url: string, rank: number, score: string): BoardItem => {
    const p = byUrl.get(url);
    return { url, name: p?.name ?? domainOf(url), line: p?.tagline || domainOf(url), rank, tied: false, hero: null, score, href: reportPath(url) };
  };
  const shown = rankingV2();
  const rows: BoardItem[] = shown
    ? (await rankedSites(10)).sites.map((s) => item(s.url, s.rank, isPublicTier(s.tier) ? s.tier : ""))
    : (await eloOrder(10)).map((r, i) => item(r.url, i + 1, String(Math.round(r.elo))));
  const shots = await shotBases(rows.map((r) => r.url));
  for (const r of rows) r.hero = shots.has(r.url) ? heroOf(shots.get(r.url)!) : null;
  return { kind: shown ? "ranked" : "elo", rows };
}

/** `tier`: the site's public Tier while tiers are shown, else null; never Gemini's letter. */
export type GradedItem = { url: string; name: string; domain: string; tier: string | null; at: string; hero: string | null; href: string };

/** The portfolios Gemini graded most recently. Cached an hour: it reads the whole list. */
async function recentlyGraded(count = 6): Promise<GradedItem[]> {
  const hidden = await hiddenUrls();
  const { items } = await cached<{ items: { url: string; at: string }[] }>("home", "recent-grades", { ttlMs: HOUR }, async () => {
    const res = await db().execute(
      `SELECT url, json_extract(ai_rubric, '$.judged_at') AS at
       FROM portfolios
       WHERE delisted_at IS NULL AND ai_rubric IS NOT NULL AND json_valid(ai_rubric)
         AND ${GEMINI_SAYS_PORTFOLIO_SQL("ai_rubric")} AND json_extract(ai_rubric, '$.judged_at') IS NOT NULL
       ORDER BY at DESC LIMIT 30`
    );
    return { items: res.rows.map((r) => ({ url: String(r.url), at: String(r.at) })) };
  });
  const list = items.filter((r) => byUrl.has(r.url) && !hidden.has(r.url)).slice(0, count);
  const [shots, letters] = await Promise.all([shotBases(list.map((r) => r.url)), lettersFor(list.map((r) => r.url))]);
  return list.map((r) => ({
    url: r.url,
    name: byUrl.get(r.url)?.name ?? domainOf(r.url),
    domain: domainOf(r.url),
    tier: letters.get(r.url) ?? null,
    at: r.at,
    hero: shots.has(r.url) ? heroOf(shots.get(r.url)!) : null,
    href: reportPath(r.url),
  }));
}

export type LiveStat = { key: string; label: string; value: string; tone: 1 | 2 | 3 | 4 };

type SiteStats = Awaited<ReturnType<typeof siteStats>>;

/** The Live card's numbers: the same as /api/stats/live, read here so the page renders them. */
async function liveStats(listed: number): Promise<LiveStat[]> {
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
  const shown = tiersShown();
  // Portfolios with an S Tier (earned with face-off wins), from the daily run's S band; never Gemini's S.
  const sTiers = shown
    ? await peekTierMeta(db()).then((m) => Object.values((m as { sBand?: { counts?: Record<string, number> } } | null)?.sBand?.counts ?? {}).reduce((a, b) => a + b, 0))
    : 0;
  const n = (v: number) => v.toLocaleString("en-US");
  const out: (LiveStat | null)[] = [
    // The same count as the hero: listed and not hidden.
    { key: "portfolios", label: "Portfolios listed", value: n(listed), tone: 1 },
    // Beside it, the people who listed them (the community list's contributors).
    { key: "contributors", label: "Contributors to the list", value: CONTRIBUTOR_COUNT_LABEL, tone: 3 },
    // Listed, not hidden, Gemini answered and did not say "not a portfolio" (lib/games/stats.mjs siteStats).
    { key: "graded", label: "Graded by AI", value: n(site.graded), tone: 2 },
    site.ownDomainPct == null ? null : { key: "own", label: "On their own domain", value: `${site.ownDomainPct}%`, tone: 4 },
    site.commonRole ? { key: "role", label: "Most common role", value: site.commonRole.label, tone: 3 } : null,
    // A quiet week would read as a dead site: then a number that is never 0.
    week.n > 0
      ? { key: "votesWeek", label: "Votes this week", value: n(week.n), tone: 3 }
      : sTiers > 0
        ? { key: "sTiers", label: "Portfolios in tier S", value: n(sTiers), tone: 3 }
        : null,
    counts.votes > 0 ? { key: "votes", label: "Votes all time", value: n(counts.votes), tone: 1 } : null,
    site.resumePct == null ? null : { key: "resume", label: "Link a resume", value: `${site.resumePct}%`, tone: 2 },
    shown && site.averageTier ? { key: "tier", label: "Average tier", value: tierLabel(site.averageTier.tier), tone: 4 } : null,
    site.gradedThisWeek > 0 ? { key: "week", label: "Graded this week", value: n(site.gradedThisWeek), tone: 2 } : null,
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
  /** The public Tier while tiers are shown, else null; never Gemini's letter. */
  tier: string | null;
  rank: number;
  total: number;
  /** What `rank` is a place in: /top's order in this flag state. */
  order: "code checks and votes" | "people's votes";
  best: { label: string; note: string }[];
  facts: { id: string; label: string; pass: boolean }[];
  href: string;
};

/**
 * One strong portfolio a day, the same for everyone, never one the hero
 * shows: a strong capture whose Tier (lib/tiers-letters.mjs siteTiers: code
 * checks and votes, never Gemini's letter) is in the S or A family.
 */
async function portfolioOfTheDay(pool: PoolSite[], total: number, skip: Set<string>, now = new Date()): Promise<PortfolioOfTheDay | null> {
  const strong = pool.filter((p) => !skip.has(p.url)).slice(0, 300);
  const tiers = await siteTiers(db(), strong.map((p) => p.url)).catch(() => new Map<string, string | null>());
  const candidates = strong.filter((p) => ["S", "A"].includes(familyOf(tiers.get(p.url) ?? null) ?? "")).slice(0, 100);
  if (candidates.length === 0) return null;
  const day = Math.floor(now.getTime() / 86_400_000);
  // Walk from today's pick to the first one with a capture.
  for (let k = 0; k < Math.min(candidates.length, 8); k++) {
    const p = candidates[(day * 37 + k) % candidates.length];
    const [shots, row] = await Promise.all([
      shotBases([p.url]),
      db().execute({ sql: "SELECT ai_rubric, facts FROM portfolios WHERE url = ?", args: [p.url] }),
    ]);
    const base = shots.get(p.url);
    if (!base) continue;
    // Its fact lines from the newest measured facts (lib/fresh-facts.mjs).
    const grade = (freshGrade(String(row.rows[0]?.ai_rubric ?? "{}"), row.rows[0]?.facts) ?? {}) as Record<string, unknown>;
    // Project links say how many load ("5 of 8 project links load") for facts of version 3; older ones keep their label.
    const facts = (factLines(grade) as { id: string; label: string; pass: boolean | null; shownAs: string }[])
      .filter((f) => f.pass !== null)
      .map((f) => ({ id: f.id, label: f.shownAs ?? f.label, pass: f.pass as boolean }));
    return {
      url: p.url,
      name: p.name,
      line: byUrl.get(p.url)?.tagline || domainOf(p.url),
      domain: domainOf(p.url),
      hero: heroOf(base),
      tier: (await lettersFor([p.url])).get(p.url) ?? null,
      rank: p.rank,
      total,
      order: rankingV2() ? "code checks and votes" : "people's votes",
      // No Gemini answer is shown (owner, 2026-11-23).
      best: [],
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
  const { pool, total: ranked } = await rankedPool();
  const hidden = await hiddenUrls();
  const total = FEED.filter((p) => !hidden.has(p.url)).length;
  const [show, top, recent, stats, poll] = await Promise.all([showcase(pool), topTen(), recentlyGraded(), liveStats(total), polls()]);
  const potd = await portfolioOfTheDay(pool, ranked, new Set(show.map((s) => s.url)));
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
