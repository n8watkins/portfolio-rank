import feed from "@/data/feed.json";
import { db } from "@/lib/db";
import { hiddenUrls } from "@/lib/roster";
import { shotBases } from "@/lib/shots";
import { domainOf, shotUrl, whyFor, type Why } from "@/lib/leaderboard";
import { readTierMeta, standingOf, topRows } from "@/lib/tiers-db.mjs";

// The ranked board (tiers by ELO, lib/tiers.mjs; RANKING_V2 only): the best
// ELO first, each with its letter from the daily cutoffs, derived on read. An
// index range read of the rows shown (lib/tiers-db.mjs topRows), never the
// whole library. /top and the home page's Top 10 show it while the flag is on.

type FeedEntry = { url: string; name: string; tagline?: string };
const byUrl = new Map((feed as FeedEntry[]).map((p) => [p.url, p]));

export type RankedSite = {
  url: string;
  name: string;
  tagline: string | null;
  domain: string;
  /** The tier by ELO (every letter; a page shows only the public ones, lib/tiers.mjs isPublicTier). */
  tier: string;
  elo: number;
  /** Real face-offs (people's votes and AI comparisons), each counted once. */
  votes: number;
  top: number | null;
  rank: number;
};

/** The first `limit` listed, graded portfolios in the ranked order, with the library size. */
export async function rankedSites(limit = 100): Promise<{ sites: RankedSite[]; total: number }> {
  const [rows, meta, hidden] = await Promise.all([topRows(db(), limit + 50), readTierMeta(db()), hiddenUrls()]);
  const sites = rows
    .filter((r) => byUrl.has(r.url) && !hidden.has(r.url))
    .slice(0, limit)
    .map((r, i) => {
      const s = standingOf(r, meta);
      const f = byUrl.get(r.url)!;
      return { url: r.url, name: f.name, tagline: f.tagline ?? null, domain: domainOf(r.url), tier: s.tier ?? "B", elo: s.elo, votes: s.votes, top: s.top, rank: i + 1 };
    });
  return { sites, total: (meta as { n?: number } | null)?.n ?? sites.length };
}

export type RankedRow = RankedSite & { shot: string; why: Why | null };
export type RankedBoard = { rows: RankedRow[]; total: number; totalVotes: number };

/** The ranked board for /top: the rows with their screenshot and "why it's good", the library size and votes cast. */
export async function loadRankedBoard(limit = 100): Promise<RankedBoard> {
  const [{ sites, total }, votes] = await Promise.all([
    rankedSites(limit),
    db()
      // Kept by triggers on votes (lib/schema.mjs COUNTERS): one row, not a count of the vote log.
      .execute("SELECT n FROM vote_totals WHERE k = 'all'")
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0),
  ]);
  const urls = sites.map((s) => s.url);
  const [bases, why] = await Promise.all([shotBases(urls), whyFor(urls)]);
  // A grade its owner hid shows no letter.
  const rows = sites.map((s) => ({ ...s, tier: why.has(s.url) ? s.tier : "", shot: shotUrl(bases, s.url), why: why.get(s.url) ?? null }));
  return { rows, total, totalVotes: votes };
}
