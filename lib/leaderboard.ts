import feed from "@/data/feed.json";
import { db, ensureSchema } from "@/lib/db";
import { readBoard, type BoardRow, type View } from "@/lib/ranking/board";
import { rankingConfig } from "@/lib/ranking/config.mjs";
import { hiddenUrls } from "@/lib/roster";
import { heroOf, mshotsUrl, shotBases } from "@/lib/shots";
import { topPct } from "@/lib/games/pool.mjs";
import { factLines, strengthsAndFixes } from "@/lib/grader/report.mjs";

// What the /top page shows, read on the server: one page of a ranking view
// (lib/ranking/board.ts) when RANKING_V2 is on, else today's single ELO
// board, each row with its screenshot, "why it's good" from its stored AI
// grade, its movement this week and, in Merged, whether the AI and people
// strongly disagree. The page is rendered at most every few minutes (ISR),
// and every read here is a handful of indexed lookups for the rows shown
// (docs/COSTS.md section C).

/** "elo" is today's board (ratings.elo), shown while RANKING_V2 is off. */
export type BoardKind = View | "elo";

/** The three ranking views are on (RANKING_V2, wrangler.jsonc vars). */
export const rankingViewsEnabled = () => rankingConfig(process.env).enabled;

export type Why = {
  /** The basics as pass/fail chips. */
  facts: { label: string; pass: boolean }[];
  /** The AI's strongest judgement. */
  best: { label: string; note: string } | null;
};

export type Entry = {
  /** Place shown; equal for sites that share it. */
  rank: number;
  tied: boolean;
  url: string;
  name: string;
  tagline: string | null;
  domain: string;
  /** Screenshot (our capture, or mShots). */
  shot: string;
  score: string;
  /** Places moved this week (up is positive); null when there is no history. */
  move: number | null;
  /** Where it could land given the evidence ("#2-#5"); null on the AI and ELO boards. */
  likely: string | null;
  /** "Top X%" among the sites shown in this view (AI view). */
  topPct: number | null;
  tier: string | null;
  /** AI and people strongly disagree (Merged): their places in each view. */
  disagree: { ai: number; people: number } | null;
  votes: number | null;
  why: Why | null;
};

export type Leaderboard = {
  kind: BoardKind;
  rows: Entry[];
  /** Sites in the view (all pages). */
  total: number;
  /** ELO board: votes cast. */
  totalVotes: number | null;
};

type FeedEntry = { url: string; name: string; tagline?: string };
const byUrl = new Map((feed as FeedEntry[]).map((p) => [p.url, p]));

export const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const noTable = (e: unknown) => /no such (table|column)/i.test(String((e as Error)?.message ?? e));
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// The basics a row shows as chips (lib/grader/report.mjs factLines ids).
const CHIP: Record<string, string> = {
  resume: "Resume",
  github: "GitHub",
  project_links: "Projects work",
  own_domain: "Own domain",
  contact: "Contact",
  fresh_footer: "Recent",
};

/** "Why it's good" for each url with a stored AI grade its owner hasn't hidden. */
async function whyFor(urls: string[]): Promise<Map<string, Why>> {
  const out = new Map<string, Why>();
  if (!urls.length) return out;
  const grades = await db().execute({
    sql: `SELECT url, ai_rubric FROM portfolios WHERE url IN (${marks(urls.length)}) AND ai_rubric IS NOT NULL`,
    args: urls,
  });
  let hidden = new Set<string>();
  try {
    const h = await db().execute({
      sql: `SELECT url FROM portfolio_owner WHERE hide_grade = 1 AND url IN (${marks(urls.length)})`,
      args: urls,
    });
    hidden = new Set(h.rows.map((r) => String(r.url)));
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  for (const r of grades.rows) {
    const url = String(r.url);
    if (hidden.has(url)) continue;
    let g: Record<string, unknown> | null = null;
    try {
      g = JSON.parse(String(r.ai_rubric));
    } catch {
      continue;
    }
    if (!g || typeof g !== "object") continue;
    const facts = (factLines(g) as { id: string; pass: boolean | null }[])
      .filter((f) => CHIP[f.id] && typeof f.pass === "boolean")
      .map((f) => ({ label: CHIP[f.id], pass: f.pass as boolean }));
    const top = (strengthsAndFixes(g).strengths as { title: string; why: string; by: string }[]).find((s) => s.by === "ai");
    out.set(url, { facts, best: top ? { label: top.title, note: top.why } : null });
  }
  return out;
}

/** The tier of each url's stored grade (ELO board), skipping hidden grades. */
function tierOf(why: Map<string, Why>, tiers: Map<string, string>, url: string) {
  return why.has(url) ? (tiers.get(url) ?? null) : null;
}

/** Places moved between the last two weekly snapshots of a view. */
async function movement(view: View, urls: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!urls.length) return out;
  try {
    // MAX over the (view, week, url) key is an index seek, not a scan.
    const w1 = (await db().execute({ sql: "SELECT MAX(week) AS w FROM rank_history WHERE view = ?", args: [view] })).rows[0]?.w;
    if (w1 == null) return out;
    const w0 = (await db().execute({ sql: "SELECT MAX(week) AS w FROM rank_history WHERE view = ? AND week < ?", args: [view, w1] })).rows[0]?.w;
    if (w0 == null) return out;
    const res = await db().execute({
      sql: `SELECT week, url, rank FROM rank_history WHERE view = ? AND week IN (?, ?) AND url IN (${marks(urls.length)})`,
      args: [view, w0, w1, ...urls],
    });
    const before = new Map<string, number>();
    const now = new Map<string, number>();
    for (const r of res.rows) (String(r.week) === String(w1) ? now : before).set(String(r.url), Number(r.rank));
    for (const [url, rank] of now) {
      const was = before.get(url);
      if (was != null) out.set(url, was - rank);
    }
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  return out;
}

/**
 * Merged rows where the AI and people strongly disagree: both views place
 * the site, people's place has enough evidence, and the two "top X%" are
 * at least 40 points apart.
 */
async function disagreements(urls: string[]): Promise<Map<string, { ai: number; people: number }>> {
  const out = new Map<string, { ai: number; people: number }>();
  if (!urls.length) return out;
  try {
    const [ranks, totals] = await db().batch(
      [
        {
          sql: `SELECT view, url, shown_rank, confidence FROM site_ratings WHERE view IN ('ai', 'people') AND shown_rank IS NOT NULL AND url IN (${marks(urls.length)})`,
          args: urls,
        },
        "SELECT view, MAX(shown_rank) AS n FROM site_ratings WHERE view IN ('ai', 'people') GROUP BY view",
      ],
      "read"
    );
    const n = new Map(totals.rows.map((r) => [String(r.view), Number(r.n)]));
    const ai = new Map<string, number>();
    const people = new Map<string, { rank: number; sure: boolean }>();
    for (const r of ranks.rows) {
      const rank = Number(r.shown_rank);
      if (r.view === "ai") ai.set(String(r.url), rank);
      else people.set(String(r.url), { rank, sure: r.confidence === "settled" || r.confidence === "confident" });
    }
    for (const url of urls) {
      const a = ai.get(url);
      const p = people.get(url);
      if (a == null || !p?.sure) continue;
      const pa = topPct(a, n.get("ai") ?? 0);
      const pp = topPct(p.rank, n.get("people") ?? 0);
      if (pa != null && pp != null && Math.abs(pa - pp) >= 40) out.set(url, { ai: a, people: p.rank });
    }
  } catch (e) {
    if (!noTable(e)) throw e;
  }
  return out;
}

/**
 * Where each row could likely land: its rating give or take one sigma
 * (about two chances in three), from the first site whose likely range is
 * wholly above this one's to the last site whose range still reaches it,
 * counted among the rows read; "+" when that runs past them.
 */
function likelyRanks(rows: BoardRow[], total: number): string[] {
  const lo = (r: BoardRow) => r.mu - r.sigma;
  const hi = (r: BoardRow) => r.mu + r.sigma;
  return rows.map((r) => {
    const best = Math.min(r.rank, 1 + rows.filter((o) => lo(o) > hi(r)).length);
    const reach = rows.filter((o) => hi(o) >= lo(r));
    const last = reach[reach.length - 1];
    const open = last === rows[rows.length - 1] && last.rank < total;
    const worst = Math.max(last?.rank ?? r.rank, r.rank);
    return best === worst && !open ? `#${best}` : `#${best}-#${worst}${open ? "+" : ""}`;
  });
}

const shotUrl = (bases: Map<string, string>, url: string) => {
  const b = bases.get(url);
  return b ? heroOf(b) : mshotsUrl(url, 640);
};

/** One board, best first, up to `limit` rows, ready to render. */
export async function loadLeaderboard(kind: BoardKind, limit = 100): Promise<Leaderboard> {
  await ensureSchema();
  if (kind === "elo") return loadElo(limit);

  const board = await readBoard(kind, { limit });
  const urls = board.rows.map((r) => r.url);
  const [bases, why, moves, split] = await Promise.all([
    shotBases(urls),
    whyFor(urls),
    kind === "ai" ? Promise.resolve(new Map<string, number>()) : movement(kind, urls),
    kind === "merged" ? disagreements(urls) : Promise.resolve(new Map<string, { ai: number; people: number }>()),
  ]);
  const likely = kind === "ai" ? null : likelyRanks(board.rows, board.total);

  // Neighbours the board marks tied, with the same score as shown, share
  // the higher one's place ("=3").
  const rows: Entry[] = [];
  board.rows.forEach((r, i) => {
    const prev = board.rows[i - 1];
    const shared = Boolean(prev?.tiedWithNext) && prev.mu.toFixed(1) === r.mu.toFixed(1);
    if (shared) rows[i - 1].tied = true;
    const p = byUrl.get(r.url);
    rows.push({
      rank: shared ? rows[i - 1].rank : r.rank,
      tied: shared,
      url: r.url,
      name: p?.name ?? domainOf(r.url),
      tagline: p?.tagline ?? null,
      domain: domainOf(r.url),
      shot: shotUrl(bases, r.url),
      score: r.mu.toFixed(1),
      move: moves.get(r.url) ?? null,
      likely: likely?.[i] ?? null,
      topPct: kind === "ai" ? topPct(r.rank, board.total) : null,
      tier: why.has(r.url) ? r.tier : null,
      disagree: split.get(r.url) ?? null,
      votes: null,
      why: why.get(r.url) ?? null,
    });
  });
  return { kind, rows, total: board.total, totalVotes: null };
}

// Today's board while RANKING_V2 is off: ELO from head-to-head votes, with
// the AI seed standing in until enough people have voted.
const MIN_VOTES = 1;

async function loadElo(limit: number): Promise<Leaderboard> {
  const hidden = await hiddenUrls();
  const [res, votes] = await db().batch(
    [
      { sql: "SELECT url, elo, votes FROM ratings WHERE votes >= ? ORDER BY elo DESC LIMIT ?", args: [MIN_VOTES, limit + 50] },
      // Kept by triggers on votes (lib/schema.mjs COUNTERS): one row, not a count of the vote log.
      "SELECT n FROM vote_totals WHERE k = 'all'",
    ],
    "read"
  );
  const ranked = res.rows
    .map((r) => ({ url: String(r.url), elo: Number(r.elo), votes: Number(r.votes) }))
    .filter((r) => byUrl.has(r.url) && !hidden.has(r.url))
    .slice(0, limit);
  const urls = ranked.map((r) => r.url);
  const [bases, why] = await Promise.all([shotBases(urls), whyFor(urls)]);
  const tiers = new Map<string, string>();
  if (urls.length) {
    const t = await db().execute({
      sql: `SELECT url, json_extract(ai_rubric, '$.tier') AS tier FROM portfolios WHERE url IN (${marks(urls.length)}) AND ai_rubric IS NOT NULL AND json_valid(ai_rubric)`,
      args: urls,
    });
    for (const r of t.rows) if (r.tier != null) tiers.set(String(r.url), String(r.tier));
  }
  const rows: Entry[] = ranked.map((r, i) => {
    const p = byUrl.get(r.url)!;
    return {
      rank: i + 1,
      tied: false,
      url: r.url,
      name: p.name,
      tagline: p.tagline ?? null,
      domain: domainOf(r.url),
      shot: shotUrl(bases, r.url),
      score: String(Math.round(r.elo)),
      move: null,
      likely: null,
      topPct: null,
      tier: tierOf(why, tiers, r.url),
      disagree: null,
      votes: r.votes,
      why: why.get(r.url) ?? null,
    };
  });
  return { kind: "elo", rows, total: rows.length, totalVotes: Number(votes.rows[0]?.n ?? 0) };
}
