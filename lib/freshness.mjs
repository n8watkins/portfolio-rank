// When checks re-run (AUTOMATION.md "When checks re-run", docs/DECISIONS.md
// "Check freshness"): one rule for every check PortfolioRank measures on a
// portfolio (Lighthouse, polish, the grader's free checks, project link
// checks, screenshots), driven by a cheap change fingerprint per site.
//
// The fingerprint comes from one ordinary page fetch, the same fetch the
// polish check and the grader's free checks already make: a hash of the
// normalized HTML (per-request noise such as nonces, CSRF tokens,
// timestamps and inline script state stripped) plus the script and
// stylesheet URLs (build hashes change on every deploy), with the ETag and
// Last-Modified headers counted when they can't be per-request noise.
//
// The rule (decide below): reuse a stored result while the page is
// unchanged; re-run it when the fingerprint changed after it was measured,
// when the admin pressed "Re-measure" or an owner asked for a re-grade
// (forced_at), or when it is older than its kind's maximum age. A failure
// is retried after its short window.
//
// Plain JavaScript so the app (Workers), the hourly cron and the pipeline
// scripts on GitHub Actions share it.
import { createHash } from "node:crypto";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Every check kind and its rule's numbers.
 *   maxAgeMs        re-run past this age even when the page never changed
 *   failureRetryMs  a failed result is reused this long, then tried again
 *   where           what holds it (for the docs and the admin view)
 */
export const CHECK_KINDS = {
  // Google PageSpeed (/api/psi, cache "psi:<url>").
  lighthouse: { label: "Lighthouse", maxAgeMs: 90 * DAY, failureRetryMs: HOUR },
  // The polish checklist and share card (/api/inspect, cache "inspect:<url>"):
  // it checks that the share image and favicon still load, which can break
  // without the page changing, so it ages like the link checks.
  polish: { label: "Polish", maxAgeMs: 30 * DAY, failureRetryMs: HOUR },
  // The project and demo links a page points to (portfolios.facts.project_links,
  // and the grader's free checks): links rot without the page changing.
  links: { label: "Link checks", maxAgeMs: 30 * DAY, failureRetryMs: HOUR },
  // The capture: screenshots, page text and facts (portfolios.captured_at).
  screenshots: { label: "Screenshots", maxAgeMs: 90 * DAY, failureRetryMs: HOUR },
  // "Grade my portfolio"'s free checks (lib/grader/quick.ts): a request is a
  // grade, so the page is always fetched again; only its link checks are
  // reused while the page is unchanged (the links rule). A failure keeps its
  // own 10 minutes, so someone who just fixed their site can try again soon.
  freeChecks: { label: "Free checks", maxAgeMs: 30 * DAY, failureRetryMs: 10 * 60 * 1000 },
};

/** @typedef {keyof typeof CHECK_KINDS} CheckKind */

/** How often each listed site's fingerprint is checked, and never more than once in this window. */
export const FINGERPRINT_EVERY_MS = 7 * DAY;
export const FINGERPRINT_MIN_GAP_MS = DAY;
/** The body cap for a fingerprint fetch (the polish check reads the same). */
export const FINGERPRINT_MAX_BYTES = 800_000;
/** Only this much of the normalized HTML is hashed, so a capped read always hashes the same prefix. */
export const HASH_CHARS = 300_000;
/** A Last-Modified this close to the response's own time is "now" (a dynamic page), never a version. */
const DYNAMIC_LAST_MODIFIED_MS = 120_000;

// ---------------------------------------------------------------------------
// Normalization: what changes on every request is not a change
// ---------------------------------------------------------------------------

// Names of values that differ per request or per visitor.
const TOKEN_NAME = "(?:csrf|xsrf|nonce|token|authenticity|request[-_]?id|trace[-_]?id|traceparent|sentry-trace|baggage|session[-_]?id|wpnonce)";

const NOISE = [
  // Inline scripts: analytics, per-request state, embedded timestamps, and
  // CDN injections whose number varies per response. External scripts count
  // through their URL (assetUrls), so an inline one is dropped whole.
  [/<script\b(?![^>]*\ssrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/gi, ""],
  [/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>"],
  [/<!--[\s\S]*?-->/g, ""],
  // Web fonts' @font-face rules: font CDNs (Cloudflare Fonts) send the
  // subsets in a different order per request.
  [/@font-face\s*\{[^}]*\}/gi, ""],
  // Ids from per-render counters (React useId, UI kits' "bits-5"): the
  // number in an id or a reference to one is not content.
  [/(\s(?:id|for|aria-[\w-]+|data-[\w-]*id)\s*=\s*["'][^"'0-9]*)[0-9][^"']*(["'])/gi, "$1#$2"],
  // Long base64 attribute values are tracking payloads (GitHub's hydro data
  // carries a request id and a visitor id).
  // Mixed case and digits, so a long lowercase URL slug is not one.
  [/(=\s*["'])(?=[^"']*[A-Z])(?=[^"']*[a-z])(?=[^"']*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}(["'])/g, "$1<b64>$2"],
  // Cloudflare's own links (bot labyrinth, challenge, email) carry per-response ids.
  [/(\/cdn-cgi\/[^"'\s>?#]*)[?#][^"'\s>]*/gi, "$1"],
  // CSP nonces.
  [/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, ""],
  // CSRF and other token meta tags and hidden inputs.
  [new RegExp(`<meta\\b[^>]*\\bname\\s*=\\s*["']?[^"'>]*${TOKEN_NAME}[^>]*>`, "gi"), ""],
  [new RegExp(`<input\\b[^>]*\\bname\\s*=\\s*["']?[^"'>]*${TOKEN_NAME}[^>]*>`, "gi"), ""],
  // Token-like attributes (data-csrf, data-request-id, ...): keep the name, drop the value.
  [new RegExp(`(\\s[\\w:-]*${TOKEN_NAME}[\\w:-]*)\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, "gi"), "$1"],
  // Token query parameters in links (WordPress _wpnonce, session ids).
  [new RegExp(`([?&][\\w-]*${TOKEN_NAME}[\\w-]*=)[^&"'\\s>]*`, "gi"), "$1"],
  // Cloudflare's email obfuscation is re-keyed on every response.
  [/(\/cdn-cgi\/l\/email-protection#)[0-9a-f]+/gi, "$1"],
  [/\sdata-cfemail\s*=\s*(?:"[^"]*"|'[^']*')/gi, ""],
  // Timestamps: ISO 8601, HTTP dates, clock times, epoch seconds or milliseconds.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<t>"],
  [/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g, "<t>"],
  [/\b\d{1,2}:\d{2}:\d{2}\b/g, "<t>"],
  [/\b\d{10,}\b/g, "<n>"],
  // Random ids: UUIDs and long hex runs (request and trace ids).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b[0-9a-f]{24,}\b/gi, "<id>"],
  // Whitespace: collapsed, and none between tags (a template's indentation is not a change).
  [/\s+/g, " "],
  [/>\s+</g, "><"],
];

/**
 * The HTML with per-request noise removed. A read cut off in the middle of
 * an inline script or a comment (a body past the byte cap) is cut back to
 * where that script or comment starts, so the cut point never leaks noise.
 */
export function normalizeHtml(html) {
  let s = String(html ?? "");
  const cutAt = (open, close) => {
    const o = s.toLowerCase().lastIndexOf(open);
    if (o >= 0 && o > s.toLowerCase().lastIndexOf(close)) s = s.slice(0, o);
  };
  cutAt("<script", "</script");
  cutAt("<!--", "-->");
  for (const [re, to] of NOISE) s = s.replace(re, to);
  // The head's order is not content: streaming renderers (Next.js metadata)
  // emit its tags in a different order per response.
  const head = s.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  if (head) s = s.replace(head[1], () => head[1].split(/(?=<)/).sort().join(""));
  return s.trim();
}

const NOISY_PARAM = new RegExp(`^(?:t|ts|_|cb|timestamp|cachebust|nocache|[\\w-]*${TOKEN_NAME}[\\w-]*)$`, "i");

/** An asset URL as a version: absolute, without per-request query parameters. */
function assetKey(raw, base) {
  let u;
  try {
    u = new URL(raw.replace(/&amp;/g, "&"), base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  for (const [k, v] of [...u.searchParams]) if (NOISY_PARAM.test(k) || /^\d{10,}$/.test(v)) u.searchParams.delete(k);
  u.hash = "";
  // The site's own assets by path, so the same page reached with or without
  // "www." (or over http) has the same fingerprint.
  let host = "";
  try {
    host = new URL(base).hostname.replace(/^www\./, "");
  } catch {}
  return u.hostname.replace(/^www\./, "") === host ? `${u.pathname}${u.search}` : u.href;
}

const attr = (tag, name) => tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))?.slice(1).find((v) => v != null) ?? null;

/**
 * The page's script and stylesheet URLs, sorted: a deploy changes their
 * build hashes even when the HTML around them is the same.
 */
export function assetUrls(html, baseUrl) {
  const out = new Set();
  const add = (raw) => {
    const k = raw && assetKey(raw.trim(), baseUrl);
    if (k) out.add(k);
  };
  const s = String(html ?? "");
  for (const m of s.matchAll(/<script\b[^>]*>/gi)) add(attr(m[0], "src"));
  for (const m of s.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    const as = (attr(m[0], "as") ?? "").toLowerCase();
    if (/\bstylesheet\b|\bmodulepreload\b/.test(rel) || (/\bpreload\b/.test(rel) && (as === "script" || as === "style"))) add(attr(m[0], "href"));
  }
  return [...out].sort().slice(0, 300);
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const header = (headers, name) => {
  if (!headers) return null;
  const v = typeof headers.get === "function" ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return v == null || v === "" ? null : String(v);
};

/**
 * The change fingerprint of one fetched page.
 *   hash          normalized HTML (first HASH_CHARS) + asset URLs: the change signal
 *   raw           the body as received: only to tell whether the validators may count
 *   etag          the ETag header
 *   lastModified  Last-Modified, unless it is the response's own time (a dynamic page)
 *   assets        how many script and stylesheet URLs it found
 * @param {{ html: string, finalUrl: string, headers?: { get(name: string): string | null } | Record<string, string> | null, now?: number }} page
 * @returns {{ hash: string, raw: string, etag: string | null, lastModified: string | null, assets: number }}
 */
export function pageFingerprint({ html, finalUrl, headers = null, now = Date.now() }) {
  const assets = assetUrls(html, finalUrl);
  const normalized = normalizeHtml(html).slice(0, HASH_CHARS);
  let lastModified = header(headers, "last-modified");
  if (lastModified) {
    const lm = Date.parse(lastModified);
    const at = Date.parse(header(headers, "date") ?? "") || now;
    if (!Number.isFinite(lm) || Math.abs(at - lm) < DYNAMIC_LAST_MODIFIED_MS) lastModified = null;
  }
  return {
    hash: sha(`${normalized}\n${assets.join("\n")}`),
    raw: sha(String(html ?? "")),
    etag: header(headers, "etag"),
    lastModified,
    assets: assets.length,
  };
}

/**
 * Did the page change between two fingerprints?
 *   - The normalized content or the asset URLs differ: changed ("content").
 *   - The body is byte-for-byte the same but the ETag or a real Last-Modified
 *     moved: a redeploy of identical HTML whose scripts may have changed
 *     under the same names ("redeploy").
 * Validators never count when the body differs only by noise: a server
 * that hashes each response into its ETag would otherwise "change" on every
 * check. The first fingerprint of a site is its baseline, never a change.
 */
export function compareFingerprints(prev, next) {
  if (!prev?.hash) return { changed: false, first: true, reason: "first" };
  if (prev.hash !== next.hash) return { changed: true, first: false, reason: "content" };
  if (prev.raw && prev.raw === next.raw) {
    const moved = (a, b) => Boolean(a && b && a !== b);
    if (moved(prev.etag, next.etag) || moved(prev.lastModified ?? prev.last_modified, next.lastModified)) {
      return { changed: true, first: false, reason: "redeploy" };
    }
  }
  return { changed: false, first: false, reason: "same" };
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const num = (v) => (v == null || v === "" ? null : Number(v));

/**
 * Reuse or re-run one stored result.
 *   kind    a key of CHECK_KINDS
 *   result  { at: ms, failed: boolean } or null when nothing is stored
 *   page    the site's site_freshness row ({ checked_at, changed_at, forced_at }) or null
 * @param {CheckKind} kind
 * @param {{ result: { at: number, failed?: boolean } | null, page?: Record<string, unknown> | null, now?: number }} input
 * @returns {{ run: boolean, reason: "missing" | "failed" | "forced" | "changed" | "max_age" | null, unchangedSince: number | null }}
 * Returns { run, reason, unchangedSince }:
 *   run false: reuse it; unchangedSince is when a later fingerprint check
 *     found the page unchanged (null when none ran since)
 *   run true, reason one of missing, failed (its retry window passed),
 *     forced (Re-measure or a re-grade), changed, max_age
 */
export function decide(kind, { result, page = null, now = Date.now() }) {
  const k = CHECK_KINDS[kind];
  if (!k) throw new Error(`unknown check kind: ${kind}`);
  if (!result || result.at == null) return { run: true, reason: "missing", unchangedSince: null };
  const at = Number(result.at);
  const forcedAt = num(page?.forced_at ?? page?.forcedAt);
  const changedAt = num(page?.changed_at ?? page?.changedAt);
  const checkedAt = num(page?.checked_at ?? page?.checkedAt);
  if (forcedAt != null && forcedAt > at) return { run: true, reason: "forced", unchangedSince: null };
  if (result.failed) {
    return now - at >= k.failureRetryMs ? { run: true, reason: "failed", unchangedSince: null } : { run: false, reason: null, unchangedSince: null };
  }
  if (changedAt != null && changedAt > at) return { run: true, reason: "changed", unchangedSince: null };
  if (now - at >= k.maxAgeMs) return { run: true, reason: "max_age", unchangedSince: null };
  return { run: false, reason: null, unchangedSince: checkedAt != null && checkedAt > at ? checkedAt : null };
}

/**
 * The same rule as a SQL condition, for the jobs that pick what to re-run
 * (prewarm, the nightly re-capture and link checks). `at` is an SQL
 * expression for the result's time in milliseconds (NULL when there is
 * none), `failed` one for "the stored result is a failure", `f` the alias
 * of the joined site_freshness row. Only numbers are interpolated.
 */
export function dueSql(kind, { at, failed = "0", f = "f", now = Date.now() }) {
  const k = CHECK_KINDS[kind];
  const t = Math.floor(Number(now));
  return `(${at} IS NULL
    OR COALESCE(${f}.forced_at, 0) > ${at}
    OR ((${failed}) AND ${at} <= ${t - k.failureRetryMs})
    OR (NOT (${failed}) AND (COALESCE(${f}.changed_at, 0) > ${at} OR ${at} <= ${t - k.maxAgeMs})))`;
}

/** An ISO 8601 text column as milliseconds in SQL (NULL stays NULL). */
export const isoMs = (col) => `(CAST(strftime('%s', ${col}) AS INTEGER) * 1000)`;

// ---------------------------------------------------------------------------
// Storage: site_freshness (lib/schema.mjs)
// ---------------------------------------------------------------------------

export const FRESHNESS_TABLES = [
  // One row per portfolio address: its last change fingerprint and when it
  // was checked, when it last changed, and when the admin or its owner asked
  // for everything to be measured again. Times are milliseconds.
  `CREATE TABLE IF NOT EXISTS site_freshness (
    url TEXT PRIMARY KEY,
    hash TEXT,
    raw TEXT,
    etag TEXT,
    last_modified TEXT,
    assets INTEGER,
    checked_at INTEGER,
    attempted_at INTEGER,
    changed_at INTEGER,
    change_reason TEXT,
    forced_at INTEGER,
    error TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS site_freshness_attempted_idx ON site_freshness (attempted_at)",
  "CREATE INDEX IF NOT EXISTS site_freshness_changed_idx ON site_freshness (changed_at)",
];

export async function ensureFreshnessSchema(db) {
  await db.batch(FRESHNESS_TABLES, "write");
}

/** The stored row for one address, or null. */
export async function readFreshness(db, url) {
  const r = (await db.execute({ sql: "SELECT * FROM site_freshness WHERE url = ?", args: [url] })).rows[0];
  return r ? { ...r } : null;
}

/**
 * Records fetched pages: `checks` is [{ url, fp }] for pages that loaded or
 * [{ url, error }] for ones that didn't (only the attempt is noted, the
 * fingerprint stays). One read and one write batch for the lot. Returns
 * [{ url, changed, first, reason }] for the pages that loaded.
 */
export async function recordChecks(db, checks, { now = Date.now() } = {}) {
  if (!checks.length) return [];
  const urls = [...new Set(checks.map((c) => c.url))];
  const prev = new Map(
    (await db.execute({ sql: `SELECT url, hash, raw, etag, last_modified FROM site_freshness WHERE url IN (${urls.map(() => "?").join(",")})`, args: urls })).rows.map((r) => [
      String(r.url),
      { hash: r.hash == null ? null : String(r.hash), raw: r.raw == null ? null : String(r.raw), etag: r.etag == null ? null : String(r.etag), lastModified: r.last_modified == null ? null : String(r.last_modified) },
    ])
  );
  const out = [];
  const stmts = [];
  for (const c of checks) {
    if (!c.fp) {
      stmts.push({
        sql: `INSERT INTO site_freshness (url, attempted_at, error) VALUES (?, ?, ?)
              ON CONFLICT(url) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error`,
        args: [c.url, now, String(c.error ?? "failed").slice(0, 80)],
      });
      continue;
    }
    const cmp = compareFingerprints(prev.get(c.url), c.fp);
    prev.set(c.url, c.fp);
    out.push({ url: c.url, ...cmp });
    stmts.push({
      sql: `INSERT INTO site_freshness (url, hash, raw, etag, last_modified, assets, checked_at, attempted_at, changed_at, change_reason, error)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(url) DO UPDATE SET hash = excluded.hash, raw = excluded.raw, etag = excluded.etag,
              last_modified = excluded.last_modified, assets = excluded.assets, checked_at = excluded.checked_at,
              attempted_at = excluded.attempted_at, error = NULL,
              changed_at = COALESCE(excluded.changed_at, site_freshness.changed_at),
              change_reason = COALESCE(excluded.change_reason, site_freshness.change_reason)`,
      args: [c.url, c.fp.hash, c.fp.raw, c.fp.etag, c.fp.lastModified, c.fp.assets, now, now, cmp.changed ? now : null, cmp.changed ? cmp.reason : null],
    });
  }
  await db.batch(stmts, "write");
  return out;
}

/** Records one fetched page (the polish check and the grader's free checks reuse their own fetch). */
export async function recordCheck(db, url, fp, { now = Date.now() } = {}) {
  return (await recordChecks(db, [{ url, fp }], { now }))[0];
}

/** The admin's "Re-measure", or an owner's re-grade request: every check of the site runs again. */
export async function markForced(db, url, { now = Date.now() } = {}) {
  await db.execute({
    sql: `INSERT INTO site_freshness (url, forced_at) VALUES (?, ?)
          ON CONFLICT(url) DO UPDATE SET forced_at = excluded.forced_at`,
    args: [url, now],
  });
  return now;
}

/** Sites per hourly tick so every listed site is checked once a week (plus one for slack). */
export const perTick = (listed) => Math.min(60, Math.ceil(Math.max(0, listed) / (FINGERPRINT_EVERY_MS / HOUR)) + 1);

/**
 * Listed, live sites whose fingerprint is due: never checked, or last
 * attempted a week ago or more; oldest first. A site attempted within the
 * last day is never due, whatever else asks.
 * `active` is the roster's SQL filter (pipeline/roster.mjs ACTIVE).
 */
export async function dueForFingerprint(db, { now = Date.now(), limit, active }) {
  const due = Math.min(now - FINGERPRINT_EVERY_MS, now - FINGERPRINT_MIN_GAP_MS);
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")} AND (f.attempted_at IS NULL OR f.attempted_at <= ?)
          ORDER BY COALESCE(f.attempted_at, 0), p.url
          LIMIT ?`,
    args: [due, limit],
  });
  return res.rows.map((r) => String(r.url));
}

/**
 * Checks fingerprints for up to `limit` due sites. `fetchPage(url)` makes
 * the one ordinary page fetch and returns { fp } or { error }. Pages are
 * fetched `concurrency` at a time. Returns the counts.
 */
export async function checkFingerprints(db, { fetchPage, now = Date.now(), limit, active, concurrency = 4 }) {
  const urls = await dueForFingerprint(db, { now, limit, active });
  const checks = new Array(urls.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
      while (next < urls.length) {
        const i = next++;
        try {
          checks[i] = { url: urls[i], ...(await fetchPage(urls[i])) };
        } catch (e) {
          checks[i] = { url: urls[i], error: String(e?.message ?? e).slice(0, 80) };
        }
      }
    })
  );
  const recorded = await recordChecks(db, checks, { now });
  return {
    due: urls.length,
    checked: recorded.length,
    failed: checks.filter((c) => !c.fp).length,
    changed: recorded.filter((r) => r.changed).length,
    first: recorded.filter((r) => r.first).length,
  };
}

/** Midnight Pacific (the site's day) before `now`, in milliseconds. */
export function pacificDayStart(now = Date.now()) {
  const d = new Date(now);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const sinceMidnight = ((Number(parts.hour) * 60 + Number(parts.minute)) * 60 + Number(parts.second)) * 1000 + d.getUTCMilliseconds();
  return now - sinceMidnight;
}

/**
 * The admin's line (/admin/usage): listed sites whose page is unchanged
 * (checked, no change in the last week), changed this week, never checked,
 * fingerprints checked today, and checks re-measured today (Lighthouse,
 * polish, captures and link checks since midnight Pacific).
 */
export async function freshnessSummary(db, { now = Date.now(), active }) {
  const week = now - 7 * DAY;
  const today = pacificDayStart(now);
  const pages = (
    await db.execute({
      sql: `SELECT
              SUM(CASE WHEN f.checked_at IS NOT NULL AND COALESCE(f.changed_at, 0) < ? THEN 1 ELSE 0 END) AS unchanged,
              SUM(CASE WHEN f.changed_at >= ? THEN 1 ELSE 0 END) AS changed,
              SUM(CASE WHEN f.checked_at IS NULL THEN 1 ELSE 0 END) AS unchecked,
              SUM(CASE WHEN f.attempted_at >= ? THEN 1 ELSE 0 END) AS checked_today
            FROM portfolios p LEFT JOIN site_freshness f ON f.url = p.url
            WHERE p.status = 'live' AND ${active("p")}`,
      args: [week, week, today],
    })
  ).rows[0];
  // A database without the pipeline's columns (a local test run) counts 0 for them.
  const count = async (sql, args) => {
    try {
      return Number((await db.execute({ sql, args })).rows[0]?.n ?? 0);
    } catch (e) {
      if (/no such (column|table)/i.test(String(e?.message ?? e))) return 0;
      throw e;
    }
  };
  // Cache keys are "<kind>:<url>": a range on the primary key, not a scan.
  const [lighthouse, polish, screenshots, links] = await Promise.all([
    count("SELECT COUNT(*) AS n FROM cache WHERE k >= 'psi:' AND k < 'psi;' AND at >= ?", [today]),
    count("SELECT COUNT(*) AS n FROM cache WHERE k >= 'inspect:' AND k < 'inspect;' AND at >= ?", [today]),
    // captured_at is SQLite's "YYYY-MM-DD HH:MM:SS", facts_at ISO 8601: compare as times.
    count(`SELECT COUNT(*) AS n FROM portfolios WHERE ${isoMs("captured_at")} >= ?`, [today]),
    count(`SELECT COUNT(*) AS n FROM portfolios WHERE ${isoMs("facts_at")} >= ?`, [today]),
  ]);
  return {
    unchanged: Number(pages?.unchanged ?? 0),
    changedThisWeek: Number(pages?.changed ?? 0),
    unchecked: Number(pages?.unchecked ?? 0),
    checkedToday: Number(pages?.checked_today ?? 0),
    remeasuredToday: { lighthouse, polish, screenshots, links, total: lighthouse + polish + screenshots + links },
  };
}

// ---------------------------------------------------------------------------
// What the scheduled jobs re-run (the same rule as SQL)
// ---------------------------------------------------------------------------

/** First the sites that changed or were asked for, then the oldest results. */
const urgentFirst = (at, f = "f") => `CASE WHEN COALESCE(${f}.forced_at, 0) > COALESCE(${at}, 0) OR COALESCE(${f}.changed_at, 0) > COALESCE(${at}, 0) THEN 0 ELSE 1 END`;

/**
 * Listed, live sites graded in `tiers` whose Lighthouse or polish result is
 * due (prewarm.yml, scripts/prewarm-metrics.mjs): never measured first,
 * then changed or asked for, then the oldest.
 */
export async function lighthouseDue(db, { now = Date.now(), limit, active, tiers = ["S", "A", "B"] }) {
  const psiDue = dueSql("lighthouse", { at: "c.at", failed: "COALESCE(json_extract(c.v, '$.ok'), 0) = 0", now });
  const polishDue = dueSql("polish", { at: "i.at", failed: "COALESCE(json_extract(i.v, '$.ok'), 0) = 0", now });
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p
          LEFT JOIN cache c ON c.k = 'psi:' || p.url
          LEFT JOIN cache i ON i.k = 'inspect:' || p.url
          LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")}
            AND json_valid(p.ai_rubric)
            AND json_extract(p.ai_rubric, '$.tier') IN (${tiers.map(() => "?").join(", ")})
            AND (${psiDue} OR ${polishDue})
          ORDER BY c.at IS NOT NULL, ${urgentFirst("c.at")}, COALESCE(c.at, 0), p.url
          LIMIT ?`,
    args: [...tiers, limit],
  });
  return res.rows.map((r) => String(r.url));
}

/**
 * Listed, live, captured sites whose screenshots are due (pipeline/capture.mjs
 * --refresh): changed or asked for first, then captures past 90 days.
 */
export async function screenshotsDue(db, { now = Date.now(), limit, active }) {
  const at = isoMs("p.captured_at");
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${active("p")}
            AND ${dueSql("screenshots", { at, now })}
          ORDER BY ${urgentFirst(at)}, p.captured_at, p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => String(r.url));
}

/**
 * Listed, live, captured sites with stored facts whose project link checks
 * are due (pipeline/evidence.mjs --links): changed or asked for first, then
 * checks past 30 days. A site re-captured tonight has fresh facts already.
 */
export async function linksDue(db, { now = Date.now(), limit, active }) {
  const at = isoMs("p.facts_at");
  const res = await db.execute({
    sql: `SELECT p.url, p.name, p.meta, p.page_text, p.facts FROM portfolios p LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND p.facts IS NOT NULL AND ${active("p")}
            AND ${dueSql("links", { at, now })}
          ORDER BY ${urgentFirst(at)}, p.facts_at, p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows;
}
