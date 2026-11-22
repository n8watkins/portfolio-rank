// PortfolioRank's own health check (free: no Gemini, no paid APIs), run on
// every listed site every night (owner, 2026-11-16: daily, not weekly), and
// hourly on the sites whose re-check is due (./recheck.mjs).
// For every site on the list it checks that the site loads, isn't parked or
// for sale, isn't blank, isn't a duplicate of another entry, and wasn't graded
// "not a portfolio"; redirects to another domain are reported as moves (and
// possible hijacks) for a person to look at. One bad check never removes
// anything:
//
//   a site that does not answer (./not-working.mjs notAnswering: paused
//   hosting, a deleted deployment, a dead domain, a refused connection):
//   the not-working ladder of ./not-working.mjs (out of the AI's work at the
//   first failure, hidden when the next day's re-check fails too, off the
//   list after 90 days). The nightly run leaves a site on that ladder to the
//   hourly re-check, so a site is never checked twice in an hour and a stage
//   is never counted twice
//   a site that answers with the wrong thing (parked, blank, a redirect to a
//   social profile, a duplicate, a blocked capture):
//   live --fail--> suspect --fail--> ... --fail (FAILS_TO_DOWN failed checks
//   in a row, on distinct weeks, spanning at least DOWN_AFTER_DAYS)--> down
//   any state --pass--> live (fail count reset, the ladder cleared)
//   inconclusive: the state stays as it was. That is a bot wall (403/429, or
//   a page the capture's own rule calls a bot check, ./capture-blocked.mjs),
//   and anything that says nothing about the site: a timeout, a dropped
//   connection, a temporary DNS failure on the runner, a browser that could
//   not start or crashed, or the check itself crashing, each after a retry
//   and the browser's second opinion. A definite answer from either opinion
//   (refused, a connect timeout, an HTTP error) is still a failure
//   a run that could not tell for over MAX_UNKNOWN_SHARE of the sites, or
//   whose browser never started, records nothing and fails; a site unknown
//   for UNKNOWN_DAYS_TO_OWNER days running goes to the owner (/admin/alerts)
//   a site whose stored capture reason is the bot wall is never failed: every
//   result is inconclusive while that reason stands (owner, 2026-11-16:
//   bot-walled sites wait for his review)
//   a site that never had a good capture fails while its last capture was
//   blocked by a gate or an empty page (./capture-blocked.mjs)
//
// A "not a portfolio" grade is never a failed check. A removal decided in the
// review queue (lib/reviews) keeps the site down; a grade from before the
// queue existed, with no decision on record, is handed to the door
// (lib/reviews/door.mjs atTheDoor), which removes it by its rule with a record
// and Undo, or holds it for the owner.
//
// Each site's row is read after the checks and every write is conditional on
// it, so a capture, a grade or a decision made in /admin/review while the run
// was checking is never overwritten; that site waits for the next check. The
// nightly capture starts in the same minute as the nightly run, so this
// happens on ordinary nights too.
//
// Down sites are added to data/excluded.json (pipeline/exclusions.mjs), so the
// list drops them; until then the site and the background jobs skip them.

import { httpGate, isParkingDomain, netloc, parkingPhrase, titleOf, visibleText } from "./gate.mjs";
import { BOT_WALL, capturedBlocked, isBlockedReason, isBotWallReason } from "./capture-blocked.mjs";
import { ensureRosterSchema, NOT_PORTFOLIO } from "./roster.mjs";
import { portfolioSignals } from "./signals.mjs";
import { AI_SAYS_NOT_PORTFOLIO, HELD_SQL } from "./portfolio-guard.mjs";
import { replaceGradeStatements } from "./rubric-history.mjs";
import { atTheDoor } from "../lib/reviews/door.mjs";
import { APPLIED, OPEN_CASE_SQL, ensureReviewSchema } from "../lib/reviews/store.mjs";
import { rankForWrite } from "../lib/tiers-store.mjs";
import { assignShownRanks } from "../lib/ranking/store.mjs";
import { reconcileAlerts } from "./alerts.mjs";
import {
  LADDER_UNKNOWN_SQL,
  LEAVE_AFTER_DAYS,
  NOT_WORKING,
  ON_LADDER_SQL,
  PURGE_BACK,
  PURGE_GONE,
  VALID_MARKS,
  columnsOf,
  failOnLadder,
  holdOnLadder,
  leavesList,
  notAnswering,
  poolOf,
} from "./not-working.mjs";
import { listKey } from "./list-key.mjs";
import { isHiddenRow } from "../lib/hidden.mjs";
import { GRADER_POOL_KEY } from "../lib/grader/report.mjs";
import { clearPoolStatement } from "../lib/games/pool.mjs";

/**
 * Drops the cached pools a visitor's games and grade reports draw from, so a
 * site the run hid or showed leaves or joins them at once: the games pool as
 * every other hide path does (lib/games/pool.mjs), and the grader's pool.
 */
const CLEAR_POOLS = [clearPoolStatement(), { sql: "DELETE FROM cache WHERE k = ?", args: [GRADER_POOL_KEY] }];

// Thresholds of the ladder for sites that answer with the wrong thing (a
// site that does not answer has ./not-working.mjs's). Failures count once a
// week whatever the number of runs, so 3 counted failures span 14 days even
// with a run every night.
export const FAILS_TO_DOWN = 3;
export const DOWN_AFTER_DAYS = 13;
// A failed check counts only on a week of its own: the n-th counted failure
// comes at least (n - 1) * FAIL_WEEK_DAYS after the first. Two runs on one bad
// day count once. Six days, not seven, so a weekly run that starts a little
// early still counts.
export const FAIL_WEEK_DAYS = 6;
// When the check could not tell (timeouts, dropped connections, DNS, a broken
// browser) for more than this share of sites in one run, the runner is the
// likelier culprit: the run records nothing and fails, like MAX_FAIL_SHARE.
export const MAX_UNKNOWN_SHARE = 0.15;
// A site the check could not tell about for this many days running (every
// check since then inconclusive: about four weeks, whatever the number of
// runs) goes to the owner (an alert on /admin/alerts) instead of staying
// unknown forever.
export const UNKNOWN_DAYS_TO_OWNER = 28;
// Of the control sites a re-check run loads beside the due ones (./recheck.mjs),
// at least this share must pass, or the runner's network is the likelier
// culprit and the run records nothing (MAX_FAIL_SHARE needs 20 sites).
export const CONTROL_PASS_SHARE = 0.6;
// At most this many "not a portfolio" grades from before the review queue are
// handed to the door in one run; the rest go with the next run.
export const DOOR_LIMIT = 50;
// When more than this share of sites fails in one run, the runner's network
// is the likelier culprit: the run records nothing and fails. (A full check on
// 2026-11-10 found about 1% of the roster really broken.)
export const MAX_FAIL_SHARE = 0.3;
// Fewer visible characters than this is a blank page (same as capture.mjs).
export const BLANK_TEXT = 30;

// Hosting platforms where each subdomain belongs to a different person, and
// two-level country suffixes: both count as public suffixes.
const SHARED_SUFFIXES = [
  "vercel.app", "netlify.app", "github.io", "gitlab.io", "pages.dev",
  "workers.dev", "web.app", "firebaseapp.com", "framer.website", "framer.app",
  "framer.ai", "onrender.com", "herokuapp.com", "surge.sh", "glitch.me",
  "repl.co", "replit.app", "railway.app", "up.railway.app", "fly.dev",
  "azurewebsites.net", "azurestaticapps.net", "amplifyapp.com", "webflow.io",
  "wixsite.com", "carrd.co", "notion.site", "super.site", "is-a.dev",
  "js.org", "bitbucket.io", "readthedocs.io", "blogspot.com", "wordpress.com",
  "streamlit.app",
  "co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.nz", "co.in",
  "co.jp", "co.kr", "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.ng",
  "com.pk", "com.bd", "com.sg", "com.my", "com.ph", "co.za", "co.id", "com.vn",
  "com.ua", "com.eg", "com.np", "com.lk", "com.co", "com.pe", "co.il",
];

/** eTLD+1, approximately: "me.vercel.app" -> "me.vercel.app", "www.a.co.uk" -> "a.co.uk". */
export function registrableDomain(hostOrUrl) {
  let host = String(hostOrUrl ?? "").toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host).hostname;
  } catch {
    return "";
  }
  host = host.replace(/\.$/, "");
  const suffix = SHARED_SUFFIXES.filter((s) => host === s || host.endsWith("." + s)).sort(
    (a, b) => b.length - a.length
  )[0];
  const parts = host.split(".");
  const keep = suffix ? suffix.split(".").length + 1 : 2;
  return parts.slice(-keep).join(".");
}

// Redirect targets that are never a personal portfolio.
const NOT_A_PORTFOLIO_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com"];

const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

/** Name words that must appear on a redirect target for it to count as the same person's site. */
const nameTokens = (name) => fold(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

/**
 * Judge a redirect to another registrable domain. Most are a person moving
 * from a free host to their own domain (73 of 2,103 roster sites on
 * 2026-11-10), so a move is not a failure: it is reported so the stored URL
 * can be updated. Returns null (no cross-domain redirect),
 * { fail: reason } (a social profile, not a portfolio) or
 * { moved: true, hijack, to } where hijack means the target carries none of
 * the person's name (flagged for a person to look at, never removed on its own).
 */
export function redirectVerdict(url, finalUrl, name, text) {
  if (!finalUrl) return null;
  const from = registrableDomain(url);
  const to = registrableDomain(finalUrl);
  if (!from || !to || from === to) return null;
  if (NOT_A_PORTFOLIO_HOSTS.includes(to)) return { fail: `redirects to ${to}, not a portfolio` };
  const haystack = fold(`${finalUrl} ${String(text ?? "").slice(0, 20000)}`);
  const hijack = !nameTokens(name).some((t) => haystack.includes(t));
  return { moved: true, hijack, to };
}

// Bot walls (Vercel Security Checkpoint, Cloudflare "Just a moment...") answer
// automated checks while the site works for people. They say nothing about
// the site, so the check is inconclusive and the state stays. A wall is a 403
// or 429, or a page the capture's own rule calls a bot or security check
// (isBotWallPage), whatever its status (a 406 or a 200 challenge too).
const BOT_WALL_STATUS = new Set([403, 429]);

/**
 * Whether a page is a bot or security check standing in for the site: the
 * capture's own verdict (./capture-blocked.mjs capturedBlocked returns
 * BOT_WALL) on the page's title and visible text, so the capture and this
 * check never disagree about what a wall is. Only the title and the text are
 * passed: whatever else capturedBlocked weighs (links, gates, media), a page
 * it calls a bot wall is a wall here. tests/health-false-failures.test.mjs
 * pins which pages that is, so a change to the capture's rule shows there.
 */
export const isBotWallPage = ({ title = "", text = "" } = {}) => capturedBlocked({ title: String(title ?? ""), text: String(text ?? "") }) === BOT_WALL;

/** The plain answer was a bot wall: its status, or its page (an error answer carries its page in gate.html). */
const gateWall = (gate) =>
  BOT_WALL_STATUS.has(gate.httpStatus) || (gate.status !== "dead" && Boolean(gate.html) && isBotWallPage({ title: titleOf(gate.html), text: visibleText(gate.html) }));

// The browser's answers that say nothing about the site: its own timeout, or a
// connection dropped or reset (bot filters do this, as with ERR_HTTP2_PROTOCOL_ERROR
// for an old User-Agent). net::ERR_CONNECTION_TIMED_OUT and ERR_CONNECTION_REFUSED
// are not on the list: nothing answers at the address.
const BROWSER_TRANSIENT =
  /Timeout \d+ms exceeded|net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|SPDY_PROTOCOL_ERROR|TIMED_OUT|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|ABORTED)\b/i;
// The browser itself failing, not the site: it could not start (render.mjs
// BrowserUnavailableError, Playwright's "browserType.launch: Executable doesn't
// exist"), the tab or the browser crashed or closed, or the check's own code
// threw (a TypeError and the like).
const BROWSER_BROKE = /browserType\.launch|Executable doesn't exist|Page crashed|Target crashed|Target (page, context or browser )?(has been )?closed|browser has been closed|Browser closed|the browser could not start/i;

/** Whether a render error is the browser's (or the check's) own failure. `launch` when it never started. */
export function browserFailure(e) {
  if (e?.name === "BrowserUnavailableError" || /browserType\.launch|Executable doesn't exist|the browser could not start/i.test(String(e?.message ?? e))) return { launch: true };
  if (e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError) return { launch: false };
  if (BROWSER_BROKE.test(String(e?.message ?? e))) return { launch: false };
  return null;
}

// Sleeping free-tier apps answer these while they wake up.
const COLD_START_STATUS = new Set([502, 503, 504]);
export const COLD_START_WAIT_MS = 30000;

const blocked = (status, finalUrl) => ({
  ok: null,
  reason: `blocked by a bot check${status ? ` (HTTP ${status})` : ""}`,
  finalUrl,
});

/** Inconclusive for a reason that says nothing about the site (a timeout, a dropped connection, a crash). */
const unknown = (reason, finalUrl, extra = {}) => ({ ok: null, unknown: true, reason: `could not tell: ${reason}`, finalUrl, ...extra });

/**
 * Check one site. `render(url)` loads it in a real browser and returns
 * { status, finalUrl, text, title, media } (or throws; media: the page shows
 * a canvas or large images, as canvas apps without DOM text do); it is the second opinion for
 * pages that fail over plain HTTP (flaky TLS, cold starts, dropped
 * connections, timeouts), have no server-rendered text (single-page apps,
 * JavaScript redirects) or answer with a bot wall.
 * Returns { ok, reason, finalUrl, moved?, hijack? } where ok is true, false,
 * or null for inconclusive (a bot wall, or nothing learned about the site).
 */
export async function checkSite(
  entry,
  { fetchImpl = globalThis.fetch, render, timeoutMs = 20000, coldStartWaitMs = COLD_START_WAIT_MS } = {}
) {
  const { url, name } = entry;
  let gate = await httpGate(url, { fetchImpl, timeoutMs });
  if (gate.status === "error" && !gateWall(gate)) {
    // One retry for transient trouble before asking the browser.
    gate = await httpGate(url, { fetchImpl, timeoutMs });
  }
  if (gate.status === "dead" || gate.status === "parked") {
    return { ok: false, reason: gate.reason, finalUrl: gate.finalUrl ?? null };
  }
  let finalUrl = gate.finalUrl ?? url;
  let html = gate.status === "live" ? gate.html : "";
  let rendered = false;
  let text = visibleText(html);
  const wall = gateWall(gate);
  if (gate.status === "error" || text.length < BLANK_TEXT || wall) {
    if (!render) {
      if (wall) return blocked(gate.httpStatus, finalUrl);
      if (gate.transient) return unknown(gate.reason, finalUrl);
      return { ok: false, reason: gate.status === "error" ? gate.reason : "renders blank", finalUrl };
    }
    let page;
    rendered = true;
    try {
      page = await render(url);
      if (COLD_START_STATUS.has(page.status)) {
        // Free hosts (Render, Railway, Heroku) answer 502/503 while a
        // sleeping app wakes up: give it time, then look again.
        await new Promise((r) => setTimeout(r, coldStartWaitMs));
        page = await render(url);
      }
    } catch (e) {
      if (wall) return blocked(gate.httpStatus, finalUrl);
      const browserSaid = String(e?.message ?? e).split("\n")[0].slice(0, 80);
      const broke = browserFailure(e);
      // A definite answer from either opinion decides: the browser's (refused, timed out connecting, a
      // name that does not resolve) even over a plain request that only timed out or was dropped, and
      // the plain request's (refused, connect timeout, TLS, an HTTP error) when the browser told nothing.
      // A browser that broke gave no second opinion at all: the check is incomplete, so inconclusive.
      if (!broke && !BROWSER_TRANSIENT.test(String(e?.message ?? e))) return { ok: false, reason: `does not load (${browserSaid})`, finalUrl };
      if (!broke && gate.status === "error" && !gate.transient) return { ok: false, reason: `does not load (${gate.reason})`, finalUrl };
      // Neither opinion learned anything about the site: inconclusive, never a failed check.
      return unknown(`${gate.status === "error" ? gate.reason : "plain request answered"}; browser: ${browserSaid}`, finalUrl, broke?.launch ? { browserDown: true } : {});
    }
    finalUrl = page.finalUrl || finalUrl;
    if (BOT_WALL_STATUS.has(page.status) || isBotWallPage({ title: page.title, text: page.text })) {
      return blocked(page.status, finalUrl);
    }
    // The plain answer's reason when it saw the same status: it names a paused or missing deployment.
    if (page.status >= 400) return { ok: false, reason: page.status === gate.httpStatus && gate.reason ? gate.reason : `HTTP ${page.status}`, finalUrl };
    text = String(page.text ?? "").trim();
    if (page.html) html = page.html;
    if (isParkingDomain(finalUrl)) return { ok: false, reason: `redirects to ${netloc(finalUrl)}`, finalUrl };
    const phrase = parkingPhrase({ text, title: String(page.title ?? "") });
    if (phrase) return { ok: false, reason: `parking phrase: "${phrase}"`, finalUrl };
    if (text.length < BLANK_TEXT && !page.media) return { ok: false, reason: "renders blank", finalUrl };
  }
  const redirect = redirectVerdict(url, finalUrl, name, text);
  if (redirect?.fail) return { ok: false, reason: redirect.fail, finalUrl };
  let signals = portfolioSignals(html, name);
  if (signals.needsReview && render && !rendered) {
    // Server HTML of a single-page app shows little; judge the rendered page.
    const page = await render(url).catch(() => null);
    if (page?.html && page.status < 400) {
      const again = portfolioSignals(page.html, name);
      if (again.score > signals.score) signals = again;
    }
  }
  if (redirect?.moved) return { ok: true, reason: "", finalUrl, moved: true, hijack: redirect.hijack, signals };
  return { ok: true, reason: "", finalUrl, signals };
}

/** Normalized URL for duplicate detection: the list's one key (pipeline/list-key.mjs, same rule as generate_feed.py norm_key). */
export const normKey = listKey;

/**
 * Entries that duplicate an earlier one: same normalized URL, or the same
 * final URL after redirects. The first entry in list order is kept.
 * Returns Map(url -> url it duplicates).
 */
export function findDuplicates(entries) {
  const firstByKey = new Map();
  const dupes = new Map();
  for (const e of entries) {
    const keys = [normKey(e.url)];
    if (e.finalUrl) keys.push(normKey(e.finalUrl));
    const original = keys.map((k) => firstByKey.get(k)).find(Boolean);
    if (original && original !== e.url) {
      dupes.set(e.url, original);
      continue;
    }
    for (const k of keys) if (!firstByKey.has(k)) firstByKey.set(k, e.url);
  }
  return dupes;
}

/**
 * The state machine. prev: { health, fails, firstFailAt, lastFailAt, pool }
 * from the row and health_marks (or null); result: { ok, reason } with ok
 * true, false or null (inconclusive). Five rules, in order: a pass restores;
 * could-not-tell changes nothing; not answering is the not-working ladder;
 * down stays down; a page with the wrong thing is the weekly-counted rule.
 * In that rule a failure counts only on a week of its own: at least FAIL_WEEK_DAYS after
 * the last counted one (lastFailAt; for a row from before it was kept, the
 * n-th counted failure at least (n - 1) * FAIL_WEEK_DAYS after the first).
 * One in the same week updates the reason and nothing else.
 * Returns the new { health, fails, firstFailAt, lastFailAt, reason }.
 */
export function nextHealth(prev, result, now = new Date()) {
  const keptReason = () => (prev?.health && prev.health !== "live" ? prev.reason ?? result.reason : result.reason);
  // 1. A pass restores, from any state.
  if (result.ok === true) return { health: "live", fails: 0, firstFailAt: null, lastFailAt: null, reason: "", pool: null };
  // 2. A check that could not tell changes nothing (a re-check on the ladder backs off: ./not-working.mjs).
  if (result.ok === null) {
    if (prev?.pool) return holdOnLadder(prev, keptReason(), now);
    return { health: prev?.health ?? null, fails: Number(prev?.fails ?? 0), firstFailAt: prev?.firstFailAt ?? null, lastFailAt: prev?.lastFailAt ?? null, reason: keptReason(), pool: null };
  }
  // 3. The not-working ladder (./not-working.mjs): a site that does not answer, and a not-working site
  //    that fails in any way. A row already down that does not answer and has no ladder (from before the
  //    pool, or its marks voided) is not working since its first failure, so it never shows again and
  //    still leaves the list only on a fresh failed check.
  const answers = !notAnswering(result.reason);
  if (prev?.pool && (!answers || prev.pool.stage >= NOT_WORKING)) return failOnLadder(prev, result, now);
  if (!prev?.pool && !answers) {
    if (prev?.health !== "down") return failOnLadder(prev, result, now);
    const since = prev.firstFailAt ?? now.toISOString();
    return failOnLadder({ ...prev, pool: { stage: NOT_WORKING, startedAt: since, since, nextAt: null, unclear: 0 } }, result, now);
  }
  // 4. Down stays down until a check passes (confirmed by the weekly-counted rule, decided in the review
  //    queue, or not working with marks a later change voided): a failure never shows it again.
  if (prev?.health === "down") {
    return { health: "down", fails: Number(prev.fails ?? 0), firstFailAt: prev.firstFailAt ?? now.toISOString(), lastFailAt: prev.lastFailAt ?? null, reason: result.reason, pool: null };
  }
  // 5. A page that answers with the wrong thing: the weekly-counted rule. A failing site that leaves the
  //    not-answering ladder this way (it answers now) counts from this failure.
  if (prev?.pool) prev = { ...prev, fails: 0, firstFailAt: null, lastFailAt: null, pool: null };
  const before = Number(prev?.fails ?? 0);
  const firstFailAt = prev?.firstFailAt ?? now.toISOString();
  const days = (from) => (now.getTime() - new Date(from).getTime()) / 86400000;
  const span = days(firstFailAt);
  const last = before > 0 ? prev?.lastFailAt ?? null : null;
  const newWeek = before === 0 || (last ? days(last) >= FAIL_WEEK_DAYS : span >= before * FAIL_WEEK_DAYS);
  const fails = newWeek ? before + 1 : before;
  const down = fails >= FAILS_TO_DOWN && span >= DOWN_AFTER_DAYS;
  return { health: down ? "down" : "suspect", fails, firstFailAt, lastFailAt: newWeek ? now.toISOString() : last, reason: result.reason, pool: null };
}

/**
 * How long a site's check has been unable to tell (prev: { unknownSince }
 * from health_marks): the first inconclusive check starts the clock, any
 * pass or failure stops it. Time, not a count of runs, so a nightly run and
 * the hourly re-checks alert no sooner than a weekly one would. Returns
 * { unknownSince, unknownLastAt, unknownDays, unknownWeeks } (whole weeks,
 * kept in health_marks.unknown_weeks for a reader of the table).
 */
export function nextUnknown(prev, result, now = new Date()) {
  if (result.ok !== null) return { unknownSince: null, unknownLastAt: null, unknownDays: 0, unknownWeeks: 0 };
  const since = prev?.unknownSince && Number.isFinite(Date.parse(prev.unknownSince)) ? String(prev.unknownSince) : now.toISOString();
  const days = (now.getTime() - Date.parse(since)) / 86400000;
  return { unknownSince: since, unknownLastAt: now.toISOString(), unknownDays: days, unknownWeeks: Math.floor(days / 7) };
}

/**
 * Runs `fn` over `items`, `concurrency` at a time. With `stop()`, no new item
 * starts once it says so (a time budget): those items are left undefined in
 * the result, for the next run.
 */
export async function mapPool(items, concurrency, fn, { stop = () => false } = {}) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length && !stop()) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

/** Every table the health check writes to (idempotent): the roster, the review queue's, health_marks. */
export async function ensureHealthTables(db) {
  // The roster's schema includes health_marks (./roster.mjs ensureRosterSchema).
  await ensureRosterSchema(db);
  await ensureReviewSchema(db);
}

/**
 * Check every listed site and advance its health state. `feed` is the roster
 * (data/feed.json); rows must already be roster-synced. Returns a summary.
 *
 * The nightly full run leaves the sites on the not-working ladder to the
 * hourly re-check (`scheduled: "skip"`, the default): their next check is
 * pool_next_at, honoured by both. The re-check (./recheck.mjs) passes the
 * due sites as `feed` with `scheduled: "check"`, a few `controls` (live
 * sites whose results are only a test of the runner, never recorded),
 * `doorLimit: 0` and `alerts: false` (the unknown-sites alert from one run's
 * results is the nightly run's; the ladder's own is read from the marks by both).
 * Its self-protection is the control sites, never the share of due sites that
 * fail: those are expected to fail.
 *
 * `dryRun` checks and plans exactly the same and writes nothing: no schema
 * change, no row, no door, no alert. The result carries `changes` ([{ url,
 * from, to, stage, reason }]) for each site whose health or ladder stage
 * would change. It works on a database from before this release (the pool's
 * columns read as empty).
 */
export async function runHealthCheck({
  db,
  feed,
  fetchImpl = globalThis.fetch,
  render,
  now: nowIn,
  concurrency = 8,
  log = console.log,
  limit = Infinity,
  doorLimit = DOOR_LIMIT,
  scheduled = "skip",
  controls = [],
  alerts = true,
  dryRun = false,
  schemaReady = false,
  // The time a site's check finished, as ms: the real clock in a real run; a run given its own `now` (a
  // simulated clock) stays at that time unless it passes a clock of its own.
  clock = nowIn ? () => nowIn.getTime() : Date.now,
}) {
  const now = nowIn ?? new Date();
  if (!dryRun && !schemaReady) await ensureHealthTables(db);
  const marksCols = await columnsOf(db, "health_marks");
  const hasPool = marksCols.has("pool_health");
  let entries = feed.slice(0, limit);
  let leftToRecheck = 0;
  if (scheduled === "skip") {
    // The same rule as the re-check's (./not-working.mjs ON_LADDER_SQL): a site whose row changed under
    // its marks (set back to live by hand, confirmed or removed in the review queue) is the nightly run's again.
    const onLadder = new Set(hasPool ? (await db.execute(ON_LADDER_SQL)).rows.map((r) => String(r.url)) : []);
    const before = entries.length;
    entries = entries.filter((e) => !onLadder.has(e.url));
    leftToRecheck = before - entries.length;
  }
  const controlSet = new Set(controls.map((c) => c.url));
  const checkList = [...entries, ...controls.filter((c) => !entries.some((e) => e.url === c.url))];
  // How the browser fared: a browser that never starts makes every second opinion missing.
  const browser = { rendered: 0, launchFailures: 0, lastLaunchError: "" };
  const counted = render
    ? async (u) => {
        try {
          const page = await render(u);
          browser.rendered++;
          return page;
        } catch (e) {
          if (browserFailure(e)?.launch) {
            browser.launchFailures++;
            browser.lastLaunchError = String(e?.message ?? e).split("\n")[0].slice(0, 200);
          }
          throw e;
        }
      }
    : undefined;
  const checked = await mapPool(checkList, concurrency, async (entry, idx) => {
    // The check itself crashing says nothing about the site.
    const r = await checkSite(entry, { fetchImpl, render: counted }).catch((e) => unknown(`the check crashed: ${String(e?.message ?? e).slice(0, 80)}`, null));
    const label = r.ok === null ? `inconclusive: ${r.reason}` : r.ok ? (r.moved ? `ok, moved to ${r.finalUrl}` : "ok") : r.reason;
    log(`[${idx + 1}/${checkList.length}] ${entry.url}${controlSet.has(entry.url) ? " (control)" : ""} - ${label}`);
    // When this site's check finished: its failure time and the base of its next re-check.
    return { ...entry, ...r, at: new Date(clock()) };
  });
  const results = checked.slice(0, entries.length);
  const controlResults = checked.slice(entries.length);

  const abort = (message, extra = {}) => ({ aborted: true, checked: entries.length, message, ...extra });
  // The runner, not the sites: nothing is recorded, and the job fails so the owner hears of it.
  if (render && browser.launchFailures > 0 && browser.rendered === 0) {
    return abort(`the browser could not start (${browser.lastLaunchError}); without the second opinion nothing was recorded`);
  }
  // Too few sites for the shares below: the control sites (live a day ago) must load.
  const controlsPassed = controlResults.filter((r) => r.ok === true).length;
  if (controlResults.length && controlsPassed < Math.ceil(controlResults.length * CONTROL_PASS_SHARE)) {
    return abort(
      `only ${controlsPassed} of ${controlResults.length} control sites (live at their last check) loaded; the runner's network or browser is the likelier culprit, so nothing was recorded`,
      { controls: controlResults.map((r) => ({ url: r.url, ok: r.ok, reason: r.reason })) }
    );
  }
  // The share guards are for the nightly run of every listed site, where most sites work. The re-check's
  // sites are failing by definition (a free host shutting down puts 20+ on it at once): its guard is the
  // control sites above, so a cohort of due sites that still fail is recorded, not frozen.
  const shareGuards = scheduled !== "check" && entries.length >= 20;
  const loadFailures = results.filter((r) => r.ok === false).length;
  if (shareGuards && loadFailures > entries.length * MAX_FAIL_SHARE) {
    return abort(`${loadFailures} of ${entries.length} sites failed to load; more than ${MAX_FAIL_SHARE * 100}% points at the runner, so nothing was recorded`, { failed: loadFailures });
  }
  const unknowns = results.filter((r) => r.unknown).length;
  if (shareGuards && unknowns > entries.length * MAX_UNKNOWN_SHARE) {
    return abort(
      `the check could not tell for ${unknowns} of ${entries.length} sites (timeouts, dropped connections, DNS, a broken browser); more than ${MAX_UNKNOWN_SHARE * 100}% points at the runner, so nothing was recorded`,
      { unknown: unknowns }
    );
  }

  // The rows as they are now, after the checks (which take most of an hour): the nightly capture, a
  // grade or a decision in /admin/review may have changed a site meanwhile. Every write below is
  // conditional on these values (STILL_AS_READ), so a change made after this read is never overwritten.
  // The re-check reads only its own sites, not the whole list.
  const mark = (c) => (marksCols.has(c) ? `m.${c}` : "NULL");
  const rowSql = (where) =>
    `SELECT p.url, p.status, p.reason, p.health, p.health_reason, p.health_fails, p.health_first_fail_at, p.health_checked_at,
            ${RUBRIC_TOKEN("p")} AS rubric_token,
            CASE WHEN ${NOT_PORTFOLIO("p")} THEN 1 ELSE 0 END AS not_portfolio,
            CASE WHEN ${OPEN_CASE_SQL("p")} THEN 1 ELSE 0 END AS open_case,
            CASE WHEN ${REMOVAL_ON_RECORD_SQL("p")} THEN 1 ELSE 0 END AS decided_removal,
            ${["last_fail_at", "unknown_weeks", "unknown_last_at", "unknown_since", "pool_stage", "pool_started_at", "pool_next_at", "pool_since", "pool_unclear"].map((c) => `${mark(c)} AS ${c}`).join(", ")},
            ${hasPool ? `CASE WHEN ${VALID_MARKS()} THEN 1 ELSE 0 END` : "0"} AS pool_valid,
            ${marksCols.size ? "CASE WHEN m.url IS NULL THEN 0 ELSE 1 END" : "0"} AS has_marks
     FROM portfolios p ${marksCols.size ? "LEFT JOIN health_marks m ON m.url = p.url" : ""} WHERE p.delisted_at IS NULL ${where}`;
  const readRows = [];
  if (scheduled === "check") {
    const urls = results.map((r) => r.url);
    for (let i = 0; i < urls.length; i += 400) {
      const part = urls.slice(i, i + 400);
      readRows.push(...(await db.execute({ sql: rowSql(`AND p.url IN (${part.map(() => "?").join(",")})`), args: part })).rows);
    }
  } else {
    readRows.push(...(await db.execute(rowSql(""))).rows);
  }
  const rows = new Map(readRows.map((r) => [String(r.url), r]));

  // Duplicates are failures too, only after loading. A "not a portfolio" grade never is.
  const dupes = findDuplicates(results.filter((r) => r.ok));
  const toDoor = [];
  for (const r of results) {
    const was = rows.get(r.url);
    const notPortfolio = Number(was?.not_portfolio ?? 0) === 1;
    // A removal decided in the review queue (the owner's, or the door's rule; a row on record that
    // nobody undid) stays down with its reason, whatever this check sees, until an Undo or an owner
    // decision changes the grade or the health: it was decided, not seen failing.
    if (notPortfolio && Number(was?.decided_removal ?? 0) === 1 && String(was?.health ?? "") === "down" && String(was?.health_reason ?? "").startsWith(AI_SAYS_NOT_PORTFOLIO)) {
      r.ok = false;
      r.decidedDown = true;
      r.reason = String(was.health_reason);
      continue;
    }
    if (!r.ok) continue;
    if (dupes.has(r.url)) {
      r.ok = false;
      r.reason = `duplicate of ${dupes.get(r.url)}`;
    } else if (notPortfolio && Number(was?.open_case ?? 0) === 0 && Number(was?.decided_removal ?? 0) === 0) {
      // A "not a portfolio" grade with no decision on record (from before the review queue): the
      // door decides it, with a record and Undo (below). The site itself loaded, so this check passes.
      toDoor.push(r.url);
    }
  }
  // A site that has never had a good capture and whose last one was blocked
  // (./capture-blocked.mjs). A good capture since then (status 'live')
  // clears both cases.
  // - A gate, a picker or a nearly empty page that this check sees as up
  //   fails, with the capture's reason, so a site that stays blocked ends up
  //   confirmed down and excluded as broken (exclusions.mjs kind "down"),
  //   never as "not a portfolio".
  // - A bot wall is never a failure (owner, 2026-11-16: bot-walled sites go
  //   to him for review): whatever this check sees (a pass, a failure, a
  //   wall of its own), the result is inconclusive, so the state stays as it
  //   was and the site stays hidden (lib/hidden.mjs) instead of being shown
  //   uncaptured or counted down; its needs_review mark is kept below.
  // A bot wall this check meets itself stays inconclusive in both cases.
  const botWalled = new Set();
  for (const r of results) {
    const row = rows.get(r.url);
    if (!row) continue;
    if (isBotWallReason(row.reason)) {
      botWalled.add(r.url);
      if (r.ok !== null && !r.decidedDown) {
        r.ok = null;
        r.reason = String(row.reason);
      }
      continue;
    }
    if (String(row.status) !== "error" || !isBlockedReason(row.reason)) continue;
    if (r.ok === true) {
      r.ok = false;
      r.reason = String(row.reason);
    }
  }

  const summary = {
    live: 0,
    suspect: 0,
    down: 0,
    unchecked: 0,
    inconclusive: [],
    newlyDown: [],
    recovered: 0,
    moved: [],
    needsReview: [],
    changedDuringRun: [],
    toOwnerReview: [],
    settledAtDoor: [],
    unknownForWeeks: [],
    // The not-working pool: first failures (out of the AI's work), sites hidden by this run, sites
    // back from the ladder, sites not working LEAVE_AFTER_DAYS (the weekly export takes them off the list).
    newlyFailing: [],
    newlyHidden: [],
    returned: [],
    leavingList: [],
    leftToRecheck,
  };
  const plans = [];
  const str = (v) => (v == null ? null : String(v));
  for (const r of results) {
    const row = rows.get(r.url);
    const prev = row
      ? {
          health: str(row.health),
          fails: row.health_fails,
          firstFailAt: str(row.health_first_fail_at),
          lastFailAt: str(row.last_fail_at),
          reason: row.health_reason == null ? "" : String(row.health_reason),
          // Marks count only while they still describe the row (./not-working.mjs VALID_MARKS).
          pool: poolOf(row),
        }
      : null;
    // This site's own time: when its check finished, not when the run started (a nightly run takes most
    // of an hour; the ladder's next re-check counts from the failure it saw).
    const at = r.at ?? now;
    const stamp = at.toISOString();
    // A removal decided in the review queue is down with its reason (rule 4 of nextHealth), off the ladder.
    const next = nextHealth(r.decidedDown ? { ...prev, pool: null } : prev, r, at);
    const marks = nextUnknown(row ? { unknownSince: str(row.unknown_since) } : null, r, at);
    const pool = next.pool ?? null;
    // Whether this write changes what visitors see (lib/hidden.mjs, the rule itself, before and after) and
    // whether it takes the profile away (its cached copy must go: worker/index.ts, purge_pending).
    const hiddenBefore = isHiddenRow({ status: row?.status, health: row?.health });
    const hiddenAfter = isHiddenRow({ status: row?.status, health: next.health });
    const goneNow = next.health === "down" && str(row?.health) !== "down";
    const backNow = next.health !== "down" && str(row?.health) === "down";
    const purgeState = goneNow ? PURGE_GONE : backNow ? PURGE_BACK : 0;
    // A passing site whose last capture failed gets recaptured on the next sync.
    const retryNow = r.ok === true && row && String(row.status) !== "live";
    // Signals only from a page that loaded; otherwise the last ones stay.
    const signals = r.signals
      ? JSON.stringify({
          ...r.signals,
          checked_at: stamp,
          // A move to another domain, and whether it looks like a hijack.
          ...(r.moved ? { moved_to: r.finalUrl, hijack: Boolean(r.hijack) } : {}),
        })
      : null;
    const stmt = {
      sql: `INSERT INTO portfolios (url, name, health, health_reason, health_fails,
                                    health_first_fail_at, health_checked_at, final_url,
                                    signals, needs_review)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(url) DO UPDATE SET health = excluded.health,
              health_reason = excluded.health_reason, health_fails = excluded.health_fails,
              health_first_fail_at = excluded.health_first_fail_at,
              health_checked_at = excluded.health_checked_at,
              final_url = COALESCE(excluded.final_url, portfolios.final_url),
              signals = COALESCE(excluded.signals, portfolios.signals),
              needs_review = CASE WHEN excluded.signals IS NULL THEN portfolios.needs_review
                                  -- A "not a portfolio" held for the owner (lib/reviews/door.mjs) stays marked until he decides.
                                  WHEN ${HELD_SQL("portfolios.ai_rubric")} THEN 1
                                  ELSE excluded.needs_review END
              ${retryNow ? ", retry_at = excluded.health_checked_at" : ""}
            -- Only while the row is as it was read after the checks (finding d of the 2026-11-16 audit).
            WHERE ${STILL_AS_READ}`,
      args: [
        r.url,
        r.name,
        next.health,
        next.reason,
        next.fails,
        next.firstFailAt,
        stamp,
        r.finalUrl ?? null,
        signals,
        // The signals' verdict, but a bot-walled capture's mark for the owner's review is never cleared here.
        r.signals?.needsReview || botWalled.has(r.url) ? 1 : 0,
        ...stillAsReadArgs(row),
      ],
    };
    // The check's own memory, written only when the row above was (changes() is that statement's count).
    const mark = {
      sql: `INSERT INTO health_marks (url, last_fail_at, unknown_weeks, unknown_last_at, unknown_since,
                                      pool_stage, pool_started_at, pool_next_at, pool_since, pool_unclear,
                                      pool_health, pool_checked_at, purge_pending)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0
            ON CONFLICT(url) DO UPDATE SET last_fail_at = excluded.last_fail_at, unknown_weeks = excluded.unknown_weeks,
              unknown_last_at = excluded.unknown_last_at, unknown_since = excluded.unknown_since,
              pool_stage = excluded.pool_stage, pool_started_at = excluded.pool_started_at,
              pool_next_at = excluded.pool_next_at, pool_since = excluded.pool_since, pool_unclear = excluded.pool_unclear,
              pool_health = excluded.pool_health, pool_checked_at = excluded.pool_checked_at,
              -- Set when this write takes the profile away (1) or brings it back (2); cleared by the hourly purge
              -- once the cached copies agree (./not-working.mjs purgeGoneProfiles).
              purge_pending = CASE WHEN excluded.purge_pending > 0 THEN excluded.purge_pending ELSE health_marks.purge_pending END`,
      args: [
        r.url,
        next.lastFailAt,
        marks.unknownWeeks,
        marks.unknownLastAt,
        marks.unknownSince,
        pool?.stage ?? null,
        pool?.startedAt ?? null,
        pool?.nextAt ?? null,
        pool?.since ?? null,
        pool?.unclear ?? 0,
        // What the marks describe: the row as this write leaves it (./not-working.mjs VALID_MARKS).
        pool ? next.health : null,
        pool ? stamp : null,
        purgeState,
      ],
    };
    // A marks row only when there is something to keep or to clear: a ladder, a counted failure, a streak
    // of could-not-tell, a profile to purge, or a row already there. A healthy site without one gets none.
    const needMark = Number(row?.has_marks ?? 0) === 1 || Boolean(pool) || Boolean(next.lastFailAt) || Boolean(marks.unknownSince) || purgeState > 0;
    plans.push({ r, prev, next, marks, hiddenBefore, hiddenAfter, stmts: needMark ? [stmt, mark] : [stmt] });
  }
  const written = [];
  if (dryRun) {
    // Nothing is written: every plan counts as written, for the summary and the changes below.
    written.push(...plans.map(() => true));
  } else {
    for (let i = 0; i < plans.length; i += 100) {
      const chunk = plans.slice(i, i + 100);
      const stmts = chunk.flatMap((p) => p.stmts);
      // A site hidden or shown leaves the cached games pool and grader pool in the same write, as every
      // other hide path does (CLEAR_POOLS).
      if (chunk.some((p) => p.hiddenBefore !== p.hiddenAfter)) stmts.push(...CLEAR_POOLS);
      const res = await db.batch(stmts, "write");
      let at = 0;
      for (const p of chunk) {
        written.push(Number(res[at]?.rowsAffected ?? 0) > 0);
        at += p.stmts.length;
      }
    }
  }
  plans.forEach(({ r, prev, next, marks }, i) => {
    if (!written[i]) {
      // Changed while the run was checking: nothing recorded, the next check looks again.
      summary.changedDuringRun.push(r.url);
      return;
    }
    // Weeks with nothing learned: the owner looks (a bot-walled capture already has its review row).
    if (marks.unknownDays >= UNKNOWN_DAYS_TO_OWNER && !botWalled.has(r.url)) summary.unknownForWeeks.push({ url: r.url, weeks: marks.unknownWeeks, reason: r.reason });
    if (next.health) summary[next.health]++;
    else summary.unchecked++;
    if (r.ok === null) summary.inconclusive.push({ url: r.url, reason: r.reason });
    if (r.moved) summary.moved.push({ url: r.url, to: r.finalUrl, hijack: r.hijack });
    if (r.signals?.needsReview) summary.needsReview.push({ url: r.url, score: r.signals.score });
    if (next.health === "down" && prev?.health !== "down") summary.newlyDown.push({ url: r.url, reason: next.reason });
    if (next.health === "live" && (prev?.health === "suspect" || prev?.health === "down")) summary.recovered++;
    // The not-working pool (./not-working.mjs).
    const wasOnLadder = Boolean(prev?.pool) || prev?.health === "suspect" || prev?.health === "down";
    if (next.pool && !wasOnLadder) summary.newlyFailing.push({ url: r.url, reason: next.reason });
    if (next.pool?.stage === NOT_WORKING && prev?.pool?.stage !== NOT_WORKING && prev?.health !== "down") summary.newlyHidden.push({ url: r.url, reason: next.reason });
    if (r.ok === true && prev?.pool) summary.returned.push({ url: r.url, wasNotWorking: prev.pool.stage === NOT_WORKING });
    if (next.pool?.stage === NOT_WORKING && leavesList(next.pool.since, now)) summary.leavingList.push({ url: r.url, since: next.pool.since });
  });

  if (dryRun) {
    // What would change, site by site; nothing below runs (no door, no ranks, no alert).
    const changes = plans
      .filter((p) => p.prev?.health !== p.next.health || (p.prev?.pool?.stage ?? null) !== (p.next.pool?.stage ?? null))
      // A site checked for the first time and fine is not news.
      .filter((p) => !(p.prev?.health == null && p.next.health === "live"))
      .map((p) => ({ url: p.r.url, from: p.prev?.health ?? null, to: p.next.health, stage: p.next.pool?.stage ?? null, hidden: p.hiddenAfter, reason: p.next.reason }));
    return { aborted: false, dryRun: true, checked: results.length, controls: controlResults.length, changes, ...summary };
  }

  // "Not a portfolio" grades with no decision on record go to the door, at most doorLimit a run.
  const passed = new Set(plans.filter((p, i) => written[i] && p.r.ok === true).map((p) => p.r.url));
  for (const url of toDoor.filter((u) => passed.has(u)).slice(0, doorLimit)) {
    try {
      const out = await toTheDoor(db, url, now);
      // A row in the review queue, or settled without one by an earlier decision (the owner's verdict, a grade that says portfolio).
      if (out?.reviewId != null) summary.toOwnerReview.push({ url, outcome: out.outcome, reviewId: out.reviewId });
      else if (out) summary.settledAtDoor.push({ url, outcome: out.outcome });
    } catch (e) {
      log(`door: ${url} - left for the next run: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  // The boards' shown ranks (lib/ranking/store.mjs assignShownRanks) follow what the check hid or showed
  // now, not at the next recompute: a hidden site leaves its place and the ranks close up.
  const shownChanged = plans.some((p, i) => written[i] && p.hiddenBefore !== p.hiddenAfter);
  if (shownChanged) {
    try {
      await assignShownRanks(db);
    } catch (e) {
      if (!/no such table/i.test(String(e?.message ?? e))) log(`shown ranks: not updated (${String(e?.message ?? e).slice(0, 160)}); the next recompute does it`);
    }
  }
  // The owner's alert (/admin/alerts): sites the check has not been able to judge for weeks. The nightly
  // full run owns it; a re-check of a few sites would clear it for the rest.
  if (alerts) {
    await reconcileAlerts(db, {
      conditions: summary.unknownForWeeks.length
        ? [
            {
              key: UNKNOWN_ALERT_KEY,
              kind: "problem",
              title: `The health check could not tell about ${summary.unknownForWeeks.length} listed site(s) for ${UNKNOWN_DAYS_TO_OWNER}+ days`,
              detail: summary.unknownForWeeks.map((u) => `${u.url}: ${u.weeks} weeks (${u.reason})`).join("\n"),
            },
          ]
        : [],
      scope: (key) => key === UNKNOWN_ALERT_KEY,
      now,
      log,
    });
  }
  // The same alert for sites on the not-working ladder, which the nightly run skips: read from the marks
  // (every ladder site, not only this run's), so both runs keep it right.
  const ladderUnknown = (await db.execute({ sql: LADDER_UNKNOWN_SQL, args: [new Date(now.getTime() - UNKNOWN_DAYS_TO_OWNER * 86400000).toISOString()] })).rows;
  summary.ladderUnknown = ladderUnknown.map((r) => ({ url: String(r.url), since: String(r.unknown_since), reason: String(r.health_reason ?? "") }));
  await reconcileAlerts(db, {
    conditions: ladderUnknown.length
      ? [
          {
            key: UNKNOWN_LADDER_ALERT_KEY,
            kind: "problem",
            title: `The health check could not tell for ${UNKNOWN_DAYS_TO_OWNER}+ days whether ${ladderUnknown.length} failing site(s) work again`,
            detail: summary.ladderUnknown.map((u) => `${u.url}: since ${u.since.slice(0, 10)} (${u.reason})`).join("\n"),
          },
        ]
      : [],
    scope: (key) => key === UNKNOWN_LADDER_ALERT_KEY,
    now,
    log,
  });
  return { aborted: false, checked: results.length, controls: controlResults.length, ...summary };
}

/** The owner alert for sites the check could not judge for UNKNOWN_DAYS_TO_OWNER days (pipeline/alerts.mjs). */
export const UNKNOWN_ALERT_KEY = "health-unknown";
/** The same for sites on the not-working ladder (./not-working.mjs), read from the marks. */
export const UNKNOWN_LADDER_ALERT_KEY = "health-unknown-ladder";

/**
 * SQL (never NULL): a removal of the portfolios row aliased `p` is on record
 * in the review queue: a "remove" row the owner confirmed or a rule applied,
 * and nobody undid (an Undo puts the row back to pending). The one definition
 * here and in ./exclusions.mjs; it belongs in lib/reviews/store.mjs beside
 * OPEN_CASE_SQL, from its APPLIED list, once that lane can take it.
 */
export const REMOVAL_ON_RECORD_SQL = (p) =>
  `EXISTS (SELECT 1 FROM status_reviews d WHERE d.url = ${p}.url AND ${APPLIED_REMOVAL_WHERE("d.")})`;
/** The same rule as a WHERE clause on status_reviews, columns prefixed with `a` ("d." or ""). */
export const APPLIED_REMOVAL_WHERE = (a = "") => `${a}proposed = 'remove' AND ${a}status IN (${APPLIED.map((s) => `'${s}'`).join(", ")})`;

/**
 * SQL: a cheap token for the grade in `p`.ai_rubric, enough to see that it
 * changed (a new grade, a hold, a decision or an Undo rewrites it): its
 * length and its last 200 characters, where a decision's review record and
 * a new grade's dates land. The run compares it instead of the whole JSON.
 */
const RUBRIC_TOKEN = (p) => `(COALESCE(length(${p}.ai_rubric), -1) || ':' || COALESCE(substr(${p}.ai_rubric, -200), ''))`;

// The columns a capture, a grade, a review decision or an Undo changes, compared with the values read
// after the checks (the grade by its token). SQLite's IS compares NULLs as equal.
const GUARDED = ["status", "reason", "health", "health_reason", "health_fails", "health_first_fail_at"];
const STILL_AS_READ = `portfolios.delisted_at IS NULL AND ${GUARDED.map((c) => `portfolios.${c} IS ?`).join(" AND ")} AND ${RUBRIC_TOKEN("portfolios")} IS ?`;
const stillAsReadArgs = (row) => [...GUARDED, "rubric_token"].map((c) => (row?.[c] == null ? null : typeof row[c] === "bigint" ? Number(row[c]) : row[c]));

/**
 * Hands one "not a portfolio" grade with no decision on record to the door
 * (lib/reviews/door.mjs atTheDoor), as if the nightly grade had just made it:
 * the door removes it by its rule (a pending row the hourly rule applies,
 * with Undo) or holds it for the owner, and writes the record. The row is
 * read again first, and nothing happens unless it is still such a grade with
 * no open case and no decided removal. Returns the door's result, or null.
 */
async function toTheDoor(db, url, now) {
  const row = (
    await db.execute({
      sql: `SELECT p.url, p.name, p.shot_key, p.page_text, p.facts, p.signals, p.ai_rubric FROM portfolios p
            WHERE p.url = ? AND p.delisted_at IS NULL AND ${NOT_PORTFOLIO("p")} AND NOT ${OPEN_CASE_SQL("p")}
              AND NOT ${REMOVAL_ON_RECORD_SQL("p")}`,
      args: [url],
    })
  ).rows[0];
  if (!row) return null;
  const grade = JSON.parse(String(row.ai_rubric));
  return atTheDoor(db, {
    grade,
    row,
    now,
    // The hourly rule on the Worker applies a removal (REVIEW_AUTO_APPLY), as for the grading fallback (judge.mjs).
    autoApply: false,
    gradeStatements: async (g) => replaceGradeStatements(url, row.ai_rubric, await rankForWrite(db, g, { url, now: now.getTime() }), now),
  });
}

const cell = (s) => String(s ?? "").replace(/\|/g, "/");

/** The not-working pool's one line for a job summary: re-checked, back, failing for the first time, hidden, leaving the list. */
export function poolLine(s) {
  const n = (a) => (Array.isArray(a) ? a.length : Number(a ?? 0));
  return `Not-working pool: ${s.due != null ? `${s.checked} re-checked, ` : ""}${n(s.returned)} back, ${n(s.newlyFailing)} failing for the first time (out of AI work), ${n(s.newlyHidden)} newly hidden, ${n(s.leavingList)} not working ${LEAVE_AFTER_DAYS}+ days (leave the list with the weekly export).`;
}

/** Markdown summary for GITHUB_STEP_SUMMARY. */
export function healthSummary(s) {
  if (s.aborted) return `## Health check\n\nFAILED: ${s.message}.\n`;
  const lines = [
    `## Health check${s.dryRun ? " (dry run: nothing written)" : ""}`,
    "",
    `Checked ${s.checked} listed site(s): ${s.live} live, ${s.suspect} suspect, ${s.down} down, ${s.recovered} recovered, ${s.inconclusive.length} inconclusive (bot checks, timeouts, dropped connections), ${s.needsReview.length} need review.`,
    "",
    poolLine(s),
    "",
    `A site that does not answer leaves the AI's work at its first failed check and is hidden when its re-check the next day fails too (the not-working pool, pipeline/not-working.mjs); ${s.leftToRecheck ? `${s.leftToRecheck} site(s) on that ladder were left to the hourly re-check. ` : ""}A site that answers with the wrong thing (parked, blank, a duplicate) is confirmed down after ${FAILS_TO_DOWN} failed checks on different weeks, spanning at least ${DOWN_AFTER_DAYS} days. An inconclusive check leaves the state unchanged, and a site whose capture met a bot wall is never counted down.`,
    "",
  ];
  if (s.dryRun && s.changes) {
    lines.push(`### Would change (${s.changes.length})`, "", "| URL | From | To | Stage | Hidden | Reason |", "| --- | --- | --- | ---: | --- | --- |");
    for (const c of s.changes) lines.push(`| ${cell(c.url)} | ${cell(c.from ?? "unchecked")} | ${cell(c.to ?? "unchecked")} | ${c.stage ?? ""} | ${c.hidden ? "yes" : "no"} | ${cell(c.reason)} |`);
    lines.push("");
  }
  if (s.newlyHidden?.length) {
    lines.push(`### Not working (hidden ${s.dryRun ? "if written" : "now"})`, "", "| URL | Reason |", "| --- | --- |");
    for (const d of s.newlyHidden) lines.push(`| ${cell(d.url)} | ${cell(d.reason)} |`);
    lines.push("");
  }
  if (s.returned?.length) {
    lines.push("### Back (passed the full check)", "", ...s.returned.map((d) => `- ${cell(d.url)}${d.wasNotWorking ? " (was hidden)" : ""}`), "");
  }
  if (s.changedDuringRun?.length) {
    lines.push(
      "### Changed during the run",
      "",
      `Nothing recorded for ${s.changedDuringRun.length} site(s): a capture, a grade or a review decision changed them while the run was checking. The next check looks again.`,
      "",
      ...s.changedDuringRun.map((u) => `- ${cell(u)}`),
      ""
    );
  }
  if (s.toOwnerReview?.length) {
    lines.push(
      "### Old \"not a portfolio\" grades sent to the review queue",
      "",
      "Graded \"not a portfolio\" before the review queue existed, with no decision on record. Each now has a row in the review queue: a removal the rule applies (with Undo), or a case held for the owner. The health check never removes them itself.",
      "",
      "| URL | Door |",
      "| --- | --- |"
    );
    for (const d of s.toOwnerReview) lines.push(`| ${cell(d.url)} | ${cell(d.outcome)} |`);
    lines.push("");
  }
  if (s.settledAtDoor?.length) {
    lines.push(
      "### Old \"not a portfolio\" grades settled without a new review row",
      "",
      "An earlier decision settled these at the door (the owner's verdict, or a grade that says portfolio); nothing was added to the queue.",
      "",
      ...s.settledAtDoor.map((d) => `- ${cell(d.url)} (${cell(d.outcome)})`),
      ""
    );
  }
  if (s.unknownForWeeks?.length) {
    lines.push(
      `### Unknown for ${UNKNOWN_DAYS_TO_OWNER}+ days (sent to the owner)`,
      "",
      `The check could not tell whether these sites work for ${UNKNOWN_DAYS_TO_OWNER} days or more; they are on /admin/alerts for a look by hand.`,
      "",
      ...s.unknownForWeeks.map((u) => `- ${cell(u.url)}: ${u.weeks} weeks (${cell(u.reason)})`),
      ""
    );
  }
  if (s.newlyDown.length) {
    lines.push("### Newly down", "", "| URL | Reason |", "| --- | --- |");
    for (const d of s.newlyDown) lines.push(`| ${cell(d.url)} | ${cell(d.reason)} |`);
    lines.push("");
  }
  if (s.needsReview.length) {
    lines.push(
      "### Needs review (looks little like a portfolio)",
      "",
      "Not removed or hidden by this check: a listed, graded site here goes to the owner's review queue (\"signals collapsed\"), and he decides. Listed sites are not graded again for it.",
      "",
      "| URL | Signals (of 6) |",
      "| --- | ---: |"
    );
    for (const n of s.needsReview) lines.push(`| ${cell(n.url)} | ${n.score} |`);
    lines.push("");
  }
  if (s.moved.length) {
    lines.push(
      "### Moved to another domain",
      "",
      "Not failures. Proposed: update the stored URL to the new address. Rows marked check have none of the person's name on the new site, so look at them by hand.",
      "",
      "| Listed URL | Now at | Check |",
      "| --- | --- | --- |"
    );
    for (const m of s.moved) lines.push(`| ${cell(m.url)} | ${cell(m.to)} | ${m.hijack ? "check" : ""} |`);
    lines.push("");
  }
  return lines.join("\n");
}
