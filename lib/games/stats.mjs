// The live numbers (owner decision 2026-11-10): one endpoint with many
// numbers, each from the cheapest source that is exact enough.
//   siteStats    one pass over the listed portfolios (about 2,100 rows),
//                cached for an hour (app/api/stats/live)
//   liveCounts   counters and today's votes through an index: a handful of
//                rows, fresh on every edge-cache miss
//   githubStats  two GitHub API requests, cached for a day
// Plain JavaScript taking a libSQL client and a fetch, for the tests.
import { HIDDEN_WHERE } from "../hidden.mjs";
import { pacificParts, quotaDay } from "../../pipeline/quota-day.mjs";
import { tierOfValue, tierValue } from "../tiers.mjs";

/** Roles read from a portfolio's tagline, first match wins (the redesign's list). */
export const ROLES = [
  { key: "fullstack", label: "Full stack", re: /full.?stack|\bme[ar]n\b/i },
  { key: "frontend", label: "Frontend", re: /front.?end|^(?!.*full.?stack).*\bweb dev/i },
  { key: "backend", label: "Backend", re: /back.?end/i },
  { key: "ai", label: "AI / ML", re: /\bai\b|machine learning|\bml\b|data scien|llm/i },
  { key: "mobile", label: "Mobile", re: /mobile|android|ios|flutter|react native/i },
  { key: "design", label: "Design / UX", re: /design|ux|\bui\b/i },
];

export const roleOf = (tagline) => (tagline ? (ROLES.find((r) => r.re.test(tagline)) ?? null) : null);


const pct = (n, of) => (of ? Math.round((n / of) * 100) : null);
const noTable = (e) => /no such (table|column)/i.test(String(e?.message ?? e));
/** An instant as SQLite's datetime text ("YYYY-MM-DD HH:MM:SS", UTC), how votes.created_at is stored. */
export const sqliteTime = (d) => new Date(d).toISOString().slice(0, 19).replace("T", " ");

/** The instant the Pacific month of `now` began. */
export function pacificMonthStart(now = new Date()) {
  const p = pacificParts(now);
  // Noon UTC on the 1st is early morning of the 1st in Los Angeles.
  return quotaDay(new Date(Date.UTC(p.year, p.month - 1, 1, 12))).start;
}

/**
 * Numbers about the list, from one read of the listed portfolios and their
 * grades. `feed` is data/feed.json (names and taglines).
 */
export async function siteStats(db, { feed, now = new Date() }) {
  const listed = (
    await db.execute(
      `SELECT url,
              json_extract(ai_rubric, '$.tier') AS ai_tier,
              json_extract(ai_rubric, '$.rank.tier') AS tier,
              json_extract(ai_rubric, '$.is_portfolio') AS is_portfolio,
              json_extract(ai_rubric, '$.judged_at') AS judged_at,
              json_extract(ai_rubric, '$.facts.own_domain') AS own_domain,
              json_extract(ai_rubric, '$.facts.resume') AS resume
       FROM portfolios
       WHERE delisted_at IS NULL AND NOT (${HIDDEN_WHERE})
         AND (ai_rubric IS NULL OR json_valid(ai_rubric))`
    )
  ).rows;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  let graded = 0;
  let gradedThisWeek = 0;
  let tierSum = 0;
  let tiered = 0;
  let own = 0;
  let ownOf = 0;
  let resume = 0;
  let resumeOf = 0;
  for (const r of listed) {
    // Graded: Gemini answered (its letter is there). The tier is the one by rank (lib/tiers.mjs).
    if (r.ai_tier == null || Number(r.is_portfolio) === 0) continue;
    graded++;
    const value = tierValue(r.tier == null ? null : String(r.tier));
    if (value != null) {
      tierSum += value;
      tiered++;
    }
    if (r.judged_at != null && String(r.judged_at) >= weekAgo) gradedThisWeek++;
    if (r.own_domain != null) {
      ownOf++;
      if (Number(r.own_domain) === 1) own++;
    }
    if (r.resume != null) {
      resumeOf++;
      if (Number(r.resume) === 1) resume++;
    }
  }
  const avg = tiered ? Math.round((tierSum / tiered) * 100) / 100 : null;

  const roles = new Map();
  let withRole = 0;
  for (const p of feed) {
    const role = roleOf(p.tagline);
    if (!role) continue;
    withRole++;
    roles.set(role.key, (roles.get(role.key) ?? 0) + 1);
  }
  const top = [...roles].sort((a, b) => b[1] - a[1])[0];
  const topRole = top ? ROLES.find((r) => r.key === top[0]) : null;

  let changedThisMonth = 0;
  try {
    const r = await db.execute({
      sql: "SELECT COUNT(DISTINCT url) AS n FROM rating_resets WHERE reason = 'page_changed' AND at >= ?",
      args: [pacificMonthStart(now).toISOString()],
    });
    changedThisMonth = Number(r.rows[0]?.n ?? 0);
  } catch (e) {
    if (!noTable(e)) throw e;
  }

  // The newest row on the list: rowids only grow, so the last one inserted.
  const newestRow = (
    await db.execute(`SELECT url FROM portfolios WHERE delisted_at IS NULL AND NOT (${HIDDEN_WHERE}) ORDER BY rowid DESC LIMIT 1`)
  ).rows[0];
  const names = new Map(feed.map((p) => [p.url, p.name]));
  const newestUrl = newestRow ? String(newestRow.url) : null;

  return {
    portfolios: feed.length,
    graded,
    gradedThisWeek,
    ownDomainPct: pct(own, ownOf),
    resumePct: pct(resume, resumeOf),
    commonRole: topRole ? { key: topRole.key, label: topRole.label, pct: pct(top[1], withRole) } : null,
    // On the D 1 to SSS 7 scale. Tiers by rank make this B by design, so the home page no longer shows it.
    averageTier: avg == null ? null : { value: avg, tier: tierOfValue(avg) },
    changedThisMonth,
    newest: newestUrl ? { url: newestUrl, name: names.get(newestUrl) ?? null } : null,
  };
}

/** The fast-moving numbers: votes today (Pacific), all votes, quizzes finished. */
export async function liveCounts(db, { now = new Date() } = {}) {
  const [today, totals, games] = await db.batch(
    [
      { sql: "SELECT COUNT(*) AS n FROM votes WHERE created_at >= ?", args: [sqliteTime(quotaDay(now).start)] },
      { sql: "SELECT n FROM vote_totals WHERE k = 'all'", args: [] },
      { sql: "SELECT n FROM game_totals WHERE k = 'quizzes'", args: [] },
    ],
    "read"
  );
  return {
    votesToday: Number(today.rows[0]?.n ?? 0),
    votes: Number(totals.rows[0]?.n ?? 0),
    quizzesPlayed: Number(games.rows[0]?.n ?? 0),
  };
}

export const GITHUB_API = "https://api.github.com";
export const COMMUNITY_REPO = "emmabostian/developer-portfolios";

/**
 * PortfolioRank's stars and the community list's contributors from the
 * GitHub API. A failed request gives null for that number.
 */
/** @param {{ repo: string, fetchImpl?: typeof fetch, token?: string | null, base?: string }} args */
export async function githubStats({ repo, fetchImpl = globalThis.fetch, token = null, base = GITHUB_API }) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "PortfolioRank", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const get = (path) => fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(8000) });
  let stars = null;
  let contributors = null;
  try {
    const res = await get(`/repos/${repo}`);
    if (res.ok) stars = Number((await res.json()).stargazers_count ?? null);
  } catch {
    /* null */
  }
  try {
    // One per page: the last page's number is the count.
    const res = await get(`/repos/${COMMUNITY_REPO}/contributors?per_page=1&anon=1`);
    if (res.ok) {
      const last = res.headers.get("link")?.match(/[?&]page=(\d+)>;\s*rel="last"/)?.[1];
      contributors = last ? Number(last) : (await res.json()).length;
    }
  } catch {
    /* null */
  }
  return { stars, contributors };
}
