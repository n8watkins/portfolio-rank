// PortfolioRank's own weekly health check (free: no Gemini, no paid APIs).
// For every site on the list it checks that the site loads, isn't parked or
// for sale, isn't blank, isn't a duplicate of another entry, and wasn't graded
// "not a portfolio"; redirects to another domain are reported as moves (and
// possible hijacks) for a person to look at. One bad check never removes
// anything:
//
//   live --fail--> suspect --fail--> ... --fail (FAILS_TO_DOWN failed checks
//   in a row, on distinct weeks, spanning at least DOWN_AFTER_DAYS)--> down
//   any state --pass--> live (fail count reset)
//   inconclusive: the state stays as it was. That is a bot wall (403/429, or
//   a page the capture's own rule calls a bot check, ./capture-blocked.mjs),
//   and anything that says nothing about the site: a timeout, a dropped
//   connection, a temporary DNS failure on the runner, a browser that could
//   not start or crashed, or the check itself crashing, each after a retry
//   and the browser's second opinion. A definite answer from either opinion
//   (refused, a connect timeout, an HTTP error) is still a failure
//   a run that could not tell for over MAX_UNKNOWN_SHARE of the sites, or
//   whose browser never started, records nothing and fails; a site unknown
//   UNKNOWN_WEEKS_TO_OWNER weeks running goes to the owner (/admin/alerts)
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
// was checking is never overwritten; that site waits for next week's check.
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
import { HEALTH_TABLES, applyTables } from "../lib/pipeline-schema.mjs";
import { reconcileAlerts } from "./alerts.mjs";

// Thresholds. The check runs weekly, so 3 failed checks in a row span 14 days.
// Requiring both means extra manual runs can't confirm a site down faster.
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
// A site the check could not tell about this many weeks in a row goes to the
// owner (an alert on /admin/alerts) instead of staying unknown forever.
export const UNKNOWN_WEEKS_TO_OWNER = 4;
// At most this many "not a portfolio" grades from before the review queue are
// handed to the door in one run; the rest go next week.
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

/** Normalized URL for duplicate detection (same rule as generate_feed.py norm_key). */
export function normKey(url) {
  try {
    const u = new URL(String(url).trim().toLowerCase());
    const host = u.hostname.replace(/^www\./, "");
    return `${host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

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
 * The state machine. prev: { health, fails, firstFailAt, lastFailAt } from
 * the row and health_marks (or null); result: { ok, reason } with ok true,
 * false or null (inconclusive).
 * A failure counts only on a week of its own: at least FAIL_WEEK_DAYS after
 * the last counted one (lastFailAt; for a row from before it was kept, the
 * n-th counted failure at least (n - 1) * FAIL_WEEK_DAYS after the first).
 * One in the same week updates the reason and nothing else.
 * Returns the new { health, fails, firstFailAt, lastFailAt, reason }.
 */
export function nextHealth(prev, result, now = new Date()) {
  if (result.ok === null) {
    return {
      health: prev?.health ?? null,
      fails: Number(prev?.fails ?? 0),
      firstFailAt: prev?.firstFailAt ?? null,
      lastFailAt: prev?.lastFailAt ?? null,
      reason: prev?.health && prev.health !== "live" ? prev.reason ?? result.reason : result.reason,
    };
  }
  if (result.ok) return { health: "live", fails: 0, firstFailAt: null, lastFailAt: null, reason: "" };
  const before = Number(prev?.fails ?? 0);
  const firstFailAt = prev?.firstFailAt ?? now.toISOString();
  const days = (from) => (now.getTime() - new Date(from).getTime()) / 86400000;
  const span = days(firstFailAt);
  const last = before > 0 ? prev?.lastFailAt ?? null : null;
  const newWeek = before === 0 || (last ? days(last) >= FAIL_WEEK_DAYS : span >= before * FAIL_WEEK_DAYS);
  const fails = newWeek ? before + 1 : before;
  const down = fails >= FAILS_TO_DOWN && span >= DOWN_AFTER_DAYS;
  return { health: down ? "down" : "suspect", fails, firstFailAt, lastFailAt: newWeek ? now.toISOString() : last, reason: result.reason };
}

/**
 * Weeks in a row a site's check could not tell (prev: { unknownWeeks,
 * unknownLastAt } from health_marks): an inconclusive check on a week of its
 * own adds one, any pass or failure starts over. Returns { unknownWeeks,
 * unknownLastAt }.
 */
export function nextUnknown(prev, result, now = new Date()) {
  if (result.ok !== null) return { unknownWeeks: 0, unknownLastAt: null };
  const weeks = Number(prev?.unknownWeeks ?? 0);
  const last = prev?.unknownLastAt ?? null;
  const newWeek = weeks === 0 || !last || (now.getTime() - new Date(last).getTime()) / 86400000 >= FAIL_WEEK_DAYS;
  return newWeek ? { unknownWeeks: weeks + 1, unknownLastAt: now.toISOString() } : { unknownWeeks: weeks, unknownLastAt: last };
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    })
  );
  return out;
}

/**
 * Check every listed site and advance its health state. `feed` is the roster
 * (data/feed.json); rows must already be roster-synced. Returns a summary.
 */
export async function runHealthCheck({
  db,
  feed,
  fetchImpl = globalThis.fetch,
  render,
  now = new Date(),
  concurrency = 8,
  log = console.log,
  limit = Infinity,
  doorLimit = DOOR_LIMIT,
}) {
  await ensureRosterSchema(db);
  await ensureReviewSchema(db);
  await applyTables(db, HEALTH_TABLES);
  const entries = feed.slice(0, limit);
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
  const results = await mapPool(entries, concurrency, async (entry, idx) => {
    // The check itself crashing says nothing about the site.
    const r = await checkSite(entry, { fetchImpl, render: counted }).catch((e) => unknown(`the check crashed: ${String(e?.message ?? e).slice(0, 80)}`, null));
    const label = r.ok === null ? `inconclusive: ${r.reason}` : r.ok ? (r.moved ? `ok, moved to ${r.finalUrl}` : "ok") : r.reason;
    log(`[${idx + 1}/${entries.length}] ${entry.url} - ${label}`);
    return { ...entry, ...r };
  });

  const abort = (message, extra = {}) => ({ aborted: true, checked: entries.length, message, ...extra });
  // The runner, not the sites: nothing is recorded, and the job fails so the owner hears of it.
  if (render && browser.launchFailures > 0 && browser.rendered === 0) {
    return abort(`the browser could not start (${browser.lastLaunchError}); without the second opinion nothing was recorded`);
  }
  const loadFailures = results.filter((r) => r.ok === false).length;
  if (entries.length >= 20 && loadFailures > entries.length * MAX_FAIL_SHARE) {
    return abort(`${loadFailures} of ${entries.length} sites failed to load; more than ${MAX_FAIL_SHARE * 100}% points at the runner, so nothing was recorded`, { failed: loadFailures });
  }
  const unknowns = results.filter((r) => r.unknown).length;
  if (entries.length >= 20 && unknowns > entries.length * MAX_UNKNOWN_SHARE) {
    return abort(
      `the check could not tell for ${unknowns} of ${entries.length} sites (timeouts, dropped connections, DNS, a broken browser); more than ${MAX_UNKNOWN_SHARE * 100}% points at the runner, so nothing was recorded`,
      { unknown: unknowns }
    );
  }

  // The rows as they are now, after the checks (which take most of an hour): the nightly capture, a
  // grade or a decision in /admin/review may have changed a site meanwhile. Every write below is
  // conditional on these values (STILL_AS_READ), so a change made after this read is never overwritten.
  const rows = new Map(
    (
      await db.execute(
        `SELECT p.url, p.status, p.reason, p.health, p.health_reason, p.health_fails, p.health_first_fail_at,
                ${RUBRIC_TOKEN("p")} AS rubric_token,
                CASE WHEN ${NOT_PORTFOLIO("p")} THEN 1 ELSE 0 END AS not_portfolio,
                CASE WHEN ${OPEN_CASE_SQL("p")} THEN 1 ELSE 0 END AS open_case,
                CASE WHEN ${REMOVAL_ON_RECORD_SQL("p")} THEN 1 ELSE 0 END AS decided_removal,
                m.last_fail_at, m.unknown_weeks, m.unknown_last_at
         FROM portfolios p LEFT JOIN health_marks m ON m.url = p.url WHERE p.delisted_at IS NULL`
      )
    ).rows.map((r) => [String(r.url), r])
  );

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

  const stamp = now.toISOString();
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
        }
      : null;
    const next = nextHealth(prev, r, now);
    if (r.decidedDown) next.health = "down";
    const marks = nextUnknown(row ? { unknownWeeks: row.unknown_weeks, unknownLastAt: str(row.unknown_last_at) } : null, r, now);
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
      sql: `INSERT INTO health_marks (url, last_fail_at, unknown_weeks, unknown_last_at) SELECT ?, ?, ?, ? WHERE changes() > 0
            ON CONFLICT(url) DO UPDATE SET last_fail_at = excluded.last_fail_at, unknown_weeks = excluded.unknown_weeks,
              unknown_last_at = excluded.unknown_last_at`,
      args: [r.url, next.lastFailAt, marks.unknownWeeks, marks.unknownLastAt],
    };
    plans.push({ r, prev, next, marks, stmts: [stmt, mark] });
  }
  const written = [];
  for (let i = 0; i < plans.length; i += 100) {
    const chunk = plans.slice(i, i + 100);
    const res = await db.batch(
      chunk.flatMap((p) => p.stmts),
      "write"
    );
    chunk.forEach((p, j) => written.push(Number(res[j * 2]?.rowsAffected ?? 0) > 0));
  }
  plans.forEach(({ r, prev, next, marks }, i) => {
    if (!written[i]) {
      // Changed while the run was checking: nothing recorded, next week's check looks again.
      summary.changedDuringRun.push(r.url);
      return;
    }
    // Weeks in a row with nothing learned: the owner looks (a bot-walled capture already has its review row).
    if (marks.unknownWeeks >= UNKNOWN_WEEKS_TO_OWNER && !botWalled.has(r.url)) summary.unknownForWeeks.push({ url: r.url, weeks: marks.unknownWeeks, reason: r.reason });
    if (next.health) summary[next.health]++;
    else summary.unchecked++;
    if (r.ok === null) summary.inconclusive.push({ url: r.url, reason: r.reason });
    if (r.moved) summary.moved.push({ url: r.url, to: r.finalUrl, hijack: r.hijack });
    if (r.signals?.needsReview) summary.needsReview.push({ url: r.url, score: r.signals.score });
    if (next.health === "down" && prev?.health !== "down") summary.newlyDown.push({ url: r.url, reason: next.reason });
    if (next.health === "live" && (prev?.health === "suspect" || prev?.health === "down")) summary.recovered++;
  });

  // "Not a portfolio" grades with no decision on record go to the door, at most doorLimit a run.
  const passed = new Set(plans.filter((p, i) => written[i] && p.r.ok === true).map((p) => p.r.url));
  for (const url of toDoor.filter((u) => passed.has(u)).slice(0, doorLimit)) {
    try {
      const out = await toTheDoor(db, url, now);
      // A row in the review queue, or settled without one by an earlier decision (the owner's verdict, a grade that says portfolio).
      if (out?.reviewId != null) summary.toOwnerReview.push({ url, outcome: out.outcome, reviewId: out.reviewId });
      else if (out) summary.settledAtDoor.push({ url, outcome: out.outcome });
    } catch (e) {
      log(`door: ${url} - left for next week: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  // The owner's alert (/admin/alerts): sites the check has not been able to judge for weeks.
  await reconcileAlerts(db, {
    conditions: summary.unknownForWeeks.length
      ? [
          {
            key: UNKNOWN_ALERT_KEY,
            kind: "problem",
            title: `The weekly health check could not tell about ${summary.unknownForWeeks.length} listed site(s) for ${UNKNOWN_WEEKS_TO_OWNER}+ weeks`,
            detail: summary.unknownForWeeks.map((u) => `${u.url}: ${u.weeks} weeks (${u.reason})`).join("\n"),
          },
        ]
      : [],
    scope: (key) => key === UNKNOWN_ALERT_KEY,
    now,
    log,
  });
  return { aborted: false, checked: results.length, ...summary };
}

/** The owner alert for sites the check could not judge for UNKNOWN_WEEKS_TO_OWNER weeks (pipeline/alerts.mjs). */
export const UNKNOWN_ALERT_KEY = "health-unknown";

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

/** Markdown summary for GITHUB_STEP_SUMMARY. */
export function healthSummary(s) {
  if (s.aborted) return `## Health check\n\nFAILED: ${s.message}.\n`;
  const lines = [
    "## Health check",
    "",
    `Checked ${s.checked} listed site(s): ${s.live} live, ${s.suspect} suspect, ${s.down} down, ${s.recovered} recovered, ${s.inconclusive.length} inconclusive (bot checks, timeouts, dropped connections), ${s.needsReview.length} need review.`,
    "",
    `A site is confirmed down after ${FAILS_TO_DOWN} failed checks in a row, on different weeks, spanning at least ${DOWN_AFTER_DAYS} days; an inconclusive check leaves its state unchanged, and a site whose capture met a bot wall is never counted down.`,
    "",
  ];
  if (s.changedDuringRun?.length) {
    lines.push(
      "### Changed during the run",
      "",
      `Nothing recorded for ${s.changedDuringRun.length} site(s): a capture, a grade or a review decision changed them while the run was checking. Next week's check looks again.`,
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
      `### Unknown for ${UNKNOWN_WEEKS_TO_OWNER}+ weeks (sent to the owner)`,
      "",
      "The check could not tell whether these sites work for weeks in a row; they are on /admin/alerts for a look by hand.",
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
