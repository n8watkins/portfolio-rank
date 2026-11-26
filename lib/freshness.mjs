// When checks re-run (AUTOMATION.md "When checks re-run", docs/DECISIONS.md
// "A check is due by age or by request"): one rule for every check
// PortfolioRank measures on a portfolio (Lighthouse, polish, the grader's
// free checks, project link checks, screenshots).
//
// The rule (decide below): reuse a stored result until it is older than its
// kind's maximum age, or until the admin pressed "Re-measure" or the owner
// asked for a new capture (site_freshness.forced_at) after it was measured.
// A failure is retried after its short window. A change to the page is not a
// reason: nothing watches for one (the hourly page fingerprints were removed
// on 2026-11-22), and an old row's changed_at is ignored.
//
// pageFingerprint below is the grader's: "Grade my portfolio" hashes the
// page it just fetched (lib/grader/quick.ts) to tell whether a re-grade
// request is for a changed page (lib/grader/jobs.mjs regradeCheck).
//
// Plain JavaScript so the app (Workers) and the pipeline scripts on GitHub
// Actions share it.
import { createHash } from "node:crypto";
import { GEMINI_SAYS_PORTFOLIO_SQL } from "../pipeline/rubric.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Every check kind and its rule's numbers.
 *   maxAgeMs        re-run past this age
 *   failureRetryMs  a failed result is reused this long, then tried again
 *   where           what holds it (for the docs and the admin view)
 */
export const CHECK_KINDS = {
  // Google PageSpeed (cache "psi:<url>"), measured only by the daily prewarm (app/api/psi).
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
  // reused (the links rule). A failure keeps its own 10 minutes, so someone
  // who just fixed their site can try again soon.
  freeChecks: { label: "Free checks", maxAgeMs: 30 * DAY, failureRetryMs: 10 * 60 * 1000 },
};

/** @typedef {keyof typeof CHECK_KINDS} CheckKind */

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

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

const num = (v) => (v == null || v === "" ? null : Number(v));

/**
 * Reuse or re-run one stored result.
 *   kind    a key of CHECK_KINDS
 *   result  { at: ms, failed: boolean } or null when nothing is stored
 *   page    the site's site_freshness row ({ forced_at }) or null; any other
 *           column (an old row's changed_at) is ignored
 * @param {CheckKind} kind
 * @param {{ result: { at: number, failed?: boolean } | null, page?: Record<string, unknown> | null, now?: number }} input
 * @returns {{ run: boolean, reason: "missing" | "failed" | "forced" | "max_age" | null }}
 * Returns { run, reason }:
 *   run false: reuse it
 *   run true, reason one of missing, forced (Re-measure or the owner asked
 *     after it was measured), failed (its retry window passed), max_age
 */
export function decide(kind, { result, page = null, now = Date.now() }) {
  const k = CHECK_KINDS[kind];
  if (!k) throw new Error(`unknown check kind: ${kind}`);
  if (!result || result.at == null) return { run: true, reason: "missing" };
  const at = Number(result.at);
  const forcedAt = num(page?.forced_at ?? page?.forcedAt);
  if (forcedAt != null && forcedAt > at) return { run: true, reason: "forced" };
  if (result.failed) return now - at >= k.failureRetryMs ? { run: true, reason: "failed" } : { run: false, reason: null };
  if (now - at >= k.maxAgeMs) return { run: true, reason: "max_age" };
  return { run: false, reason: null };
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
    OR (NOT (${failed}) AND ${at} <= ${t - k.maxAgeMs}))`;
}

/** An ISO 8601 text column as milliseconds in SQL (NULL stays NULL). */
export const isoMs = (col) => `(CAST(strftime('%s', ${col}) AS INTEGER) * 1000)`;

// ---------------------------------------------------------------------------
// Storage: site_freshness (lib/schema.mjs)
// ---------------------------------------------------------------------------

export const FRESHNESS_TABLES = [
  // One row per portfolio address: forced_at, when the admin or its owner
  // asked for everything to be measured again (milliseconds). The other
  // columns held the hourly page fingerprints, removed on 2026-11-22: they
  // are no longer written or read, and stay so no data is dropped.
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
  // A nightly re-capture (pipeline/capture.mjs --refresh) that failed: the
  // good stored capture stays as it was, and the site waits out a growing
  // backoff (pipeline/capture.mjs recordRefreshFailure, the capture's own
  // roster.captureRetryAt) before it is tried again, instead of heading the
  // refresh queue every night. Cleared by the next good capture. Times are
  // milliseconds.
  `CREATE TABLE IF NOT EXISTS refresh_failures (
    url TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL,
    failed_at INTEGER NOT NULL,
    retry_at INTEGER NOT NULL,
    reason TEXT
  )`,
];

/**
 * A retry counts as due this close to its time: the nightly run starts at
 * the same hour, so a retry set during last night's run would otherwise miss
 * tonight's by minutes. One constant for the failed-capture retries
 * (pipeline/roster.mjs dueForCapture imports it) and the refresh backoff
 * (screenshotsDue below).
 */
export const RETRY_SLACK_MS = 6 * HOUR;

export async function ensureFreshnessSchema(db) {
  await db.batch(FRESHNESS_TABLES, "write");
}

/** The stored row for one address, or null. */
export async function readFreshness(db, url) {
  const r = (await db.execute({ sql: "SELECT * FROM site_freshness WHERE url = ?", args: [url] })).rows[0];
  return r ? { ...r } : null;
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

// ---------------------------------------------------------------------------
// What the scheduled jobs re-run (the same rule as SQL)
// ---------------------------------------------------------------------------

/** First the sites a person asked for, then the oldest results. */
const urgentFirst = (at, f = "f") => `CASE WHEN COALESCE(${f}.forced_at, 0) > COALESCE(${at}, 0) THEN 0 ELSE 1 END`;

/**
 * Listed, live sites Gemini graded and did not call "not a portfolio" whose
 * Lighthouse or polish result is due (prewarm.yml, scripts/prewarm-metrics.mjs):
 * never measured first, then asked for, then the oldest. Gemini's letter is
 * never read (owner, 2026-11-22: it is no longer asked for, and older grades'
 * letters are not used).
 */
export async function lighthouseDue(db, { now = Date.now(), limit, active }) {
  const psiDue = dueSql("lighthouse", { at: "c.at", failed: "COALESCE(json_extract(c.v, '$.ok'), 0) = 0", now });
  const polishDue = dueSql("polish", { at: "i.at", failed: "COALESCE(json_extract(i.v, '$.ok'), 0) = 0", now });
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p
          LEFT JOIN cache c ON c.k = 'psi:' || p.url
          LEFT JOIN cache i ON i.k = 'inspect:' || p.url
          LEFT JOIN site_freshness f ON f.url = p.url
          WHERE p.status = 'live' AND ${active("p")}
            AND ${GEMINI_SAYS_PORTFOLIO_SQL("p.ai_rubric")}
            AND (${psiDue} OR ${polishDue})
          ORDER BY c.at IS NOT NULL, ${urgentFirst("c.at")}, COALESCE(c.at, 0), p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => String(r.url));
}

/**
 * Listed, live, captured sites whose screenshots are due (pipeline/capture.mjs
 * --refresh): asked for first, then captures past 90 days. A site
 * whose last refresh failed waits out its backoff (refresh_failures), unless
 * the admin or its owner asked again after that failure.
 */
export async function screenshotsDue(db, { now = Date.now(), limit, active }) {
  const at = isoMs("p.captured_at");
  const t = Math.floor(Number(now));
  const res = await db.execute({
    sql: `SELECT p.url FROM portfolios p LEFT JOIN site_freshness f ON f.url = p.url
          LEFT JOIN refresh_failures r ON r.url = p.url
          WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${active("p")}
            AND (r.url IS NULL OR r.retry_at <= ${t + RETRY_SLACK_MS} OR COALESCE(f.forced_at, 0) > r.failed_at)
            AND ${dueSql("screenshots", { at, now })}
          ORDER BY ${urgentFirst(at)}, p.captured_at, p.url
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((r) => String(r.url));
}

/**
 * Listed, live, captured sites with stored facts whose project link checks
 * are due (pipeline/evidence.mjs --links): asked for first, then
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
