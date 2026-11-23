// The live numbers (owner decision 2026-11-10): one endpoint with many
// numbers, each from the cheapest source that is exact enough.
//   siteStats    one pass over the listed portfolios (about 2,100 rows),
//                cached for an hour (app/api/stats/live)
//   liveCounts   counters and today's votes through an index: a handful of
//                rows, fresh on every edge-cache miss
//   githubStats  two GitHub API requests, cached for a day
// Plain JavaScript taking a libSQL client and a fetch, for the tests.
import { HIDDEN_WHERE } from "../hidden.mjs";
import { quotaDay } from "../../pipeline/quota-day.mjs";
import { tierOfValue, tierValue } from "../tiers.mjs";
import { GEMINI_ANSWERED_SQL } from "../../pipeline/rubric.mjs";

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


/**
 * The average Tier of the library's members (tier_ratings.tier, as the daily
 * run last wrote it: never Gemini's letter, owner 2026-11-22), or null
 * before there is one. { value (lib/tiers.mjs tierValue, D 1 to SSS 14), tier }.
 */
async function averageTierOf(db) {
  let rows = [];
  try {
    rows = (await db.execute("SELECT tier FROM tier_ratings WHERE member = 1 AND tier IS NOT NULL")).rows;
  } catch (e) {
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
  }
  const values = rows.map((r) => tierValue(String(r.tier))).filter((v) => typeof v === "number");
  if (!values.length) return null;
  const value = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  return { value, tier: tierOfValue(value) };
}

const pct = (n, of) => (of ? Math.round((n / of) * 100) : null);
/** An instant as SQLite's datetime text ("YYYY-MM-DD HH:MM:SS", UTC), how votes.created_at is stored. */
export const sqliteTime = (d) => new Date(d).toISOString().slice(0, 19).replace("T", " ");

/**
 * Numbers about the list, from one read of the listed portfolios and their
 * grades. `feed` is data/feed.json (names and taglines).
 */
export async function siteStats(db, { feed, now = new Date() }) {
  const listed = (
    await db.execute(
      `SELECT url,
              ${GEMINI_ANSWERED_SQL("ai_rubric")} AS answered,
              json_extract(ai_rubric, '$.is_portfolio') AS is_portfolio,
              json_extract(ai_rubric, '$.judged_at') AS judged_at,
              json_extract(ai_rubric, '$.facts.own_domain') AS own_domain,
              json_extract(ai_rubric, '$.facts.resume') AS resume,
              COALESCE(json_extract(ai_rubric, '$.facts.v'), 0) AS grade_v,
              CASE WHEN json_valid(facts) THEN COALESCE(json_extract(facts, '$.v'), 0) END AS facts_v,
              CASE WHEN json_valid(facts) THEN json_extract(facts, '$.own_domain') END AS facts_own_domain,
              CASE WHEN json_valid(facts) THEN json_extract(facts, '$.resume') END AS facts_resume
       FROM portfolios
       WHERE delisted_at IS NULL AND NOT (${HIDDEN_WHERE})
         AND (ai_rubric IS NULL OR json_valid(ai_rubric))`
    )
  ).rows;
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  let graded = 0;
  let gradedThisWeek = 0;
  let own = 0;
  let ownOf = 0;
  let resume = 0;
  let resumeOf = 0;
  for (const r of listed) {
    // Graded: Gemini answered (any rubric version; an older grade's letter is never read) and not "not a portfolio".
    if (Number(r.answered) !== 1 || Number(r.is_portfolio) === 0) continue;
    graded++;
    if (r.judged_at != null && String(r.judged_at) >= weekAgo) gradedThisWeek++;
    // The newest measured facts when they are as new a measuring version as the grade's copy (lib/fresh-facts.mjs).
    const fresh = (r.facts_own_domain != null || r.facts_resume != null) && Number(r.facts_v) >= Number(r.grade_v ?? 0);
    const ownDomain = fresh ? r.facts_own_domain : r.own_domain;
    const hasResume = fresh ? r.facts_resume : r.resume;
    if (ownDomain != null) {
      ownOf++;
      if (Number(ownDomain) === 1) own++;
    }
    if (hasResume != null) {
      resumeOf++;
      if (Number(hasResume) === 1) resume++;
    }
  }
  const averageTier = await averageTierOf(db);

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
    // The members' average Tier; pages show it only while tiers are shown (RANKING_V2).
    averageTier,
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
