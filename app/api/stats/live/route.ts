import { NextResponse } from "next/server";
import feed from "@/data/feed.json";
import { cached } from "@/lib/cache";
import { db, ensureSchema } from "@/lib/db";
import { cachedResponse } from "@/lib/edge-cache";
import { SITE, SITE_URL } from "@/lib/site";
import { githubStats, liveCounts, siteStats } from "@/lib/games/stats.mjs";
import { gamesEnabled, off } from "@/lib/games/server";
import { testSeam } from "@/lib/grader/server";

// GET /api/stats/live (GAMES_V2) -> the live numbers in one answer:
//   portfolios, graded, gradedThisWeek, votesToday, votes, quizzesPlayed,
//   ownDomainPct, resumePct, commonRole { key, label, pct }, averageTier
//   { value, tier }, changedThisMonth, newest { url, name },
//   contributors (the community list), stars (PortfolioRank's repository),
//   at, measuredAt { site, github }
// The same for everyone and cached at the edge for a minute. Behind it the
// list numbers are cached an hour and the GitHub numbers a day in the
// database cache, so a data center's minute costs a few indexed rows
// (docs/COSTS.md section C). A number that can't be known yet is null.
export const dynamic = "force-dynamic";
const MAX_AGE = 60;
const HOUR = 60 * 60 * 1000;

type SiteStats = Awaited<ReturnType<typeof siteStats>>;
type GitHubStats = { stars: number | null; contributors: number | null };

export async function GET() {
  if (!gamesEnabled()) return off();
  return cachedResponse(`${SITE_URL}/api/stats/live`, async () => {
    await ensureSchema();
    const now = new Date();
    const [site, gh, counts] = await Promise.all([
      cached<SiteStats>("stats", "site", { ttlMs: HOUR }, () => siteStats(db(), { feed: feed as { url: string; name: string; tagline?: string }[], now })),
      cached<GitHubStats>(
        "stats",
        "github",
        { ttlMs: 24 * HOUR, isFailure: (g) => g.stars == null || g.contributors == null, failureTtlMs: HOUR },
        () => githubStats({ repo: SITE.githubRepo, token: process.env.GITHUB_API_TOKEN ?? null, base: testSeam("GAMES_TEST_GITHUB_API") })
      ),
      liveCounts(db(), { now }),
    ]);
    const { measuredAt: siteAt, stale: _s, ...siteNums } = site;
    const { measuredAt: ghAt, stale: _g, ...ghNums } = gh;
    void _s;
    void _g;
    return NextResponse.json(
      { ...siteNums, ...counts, ...ghNums, at: now.toISOString(), measuredAt: { site: siteAt ?? null, github: ghAt ?? null } },
      { headers: { "cache-control": `public, max-age=${MAX_AGE}` } }
    );
  });
}
