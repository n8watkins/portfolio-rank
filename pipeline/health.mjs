// PortfolioRank's own health check (free: no Gemini, no paid APIs), run on
// every listed site every night (owner, 2026-11-16: daily, not weekly), and
// hourly on the sites whose re-check is due (./recheck.mjs).
// For every site on the list it checks that the site loads, isn't parked or
// for sale, isn't blank, isn't a duplicate of another entry, and wasn't graded
// "not a portfolio"; redirects to another domain are reported as moves (and
// possible hijacks) for a person to look at. One bad check never removes
// anything, and no failed check ever writes a row to the owner's review queue:
//
//   every failed check, whatever its kind (the site does not answer: paused
//   hosting, a deleted deployment, a dead domain, a refused connection, an
//   HTTP error; or it answers with the wrong thing: parked or for sale, blank,
//   a redirect to a social profile, a blocked capture of a site never
//   captured; or it duplicates another entry): the one ladder of
//   ./not-working.mjs (out of the AI's work at the first failure, hidden in
//   the temporary pool when the next day's re-check fails too, archived after
//   90 days). The nightly run leaves a site on that ladder to the hourly
//   re-check, so a site is never checked twice in an hour and a stage is
//   never counted twice
//   any state --pass--> live (the ladder cleared, back exactly as it was)
//   low portfolio signals (./signals.mjs needsReview): never a failure; the
//   site stays listed and its signals are recorded as unread (the code could
//   not read it)
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
//   a site whose stored capture reason is the bot wall is never failed for
//   the wall: a pass while it is not failing is inconclusive (owner,
//   2026-11-16: bot-walled sites wait for his review); a real failure this
//   check sees counts like any site's (owner, 2026-11-23)
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
// Sites in the temporary pool for LEAVE_AFTER_DAYS are archived: added to
// data/excluded.json (pipeline/exclusions.mjs), so the list drops them; until
// then the site and the background jobs skip them.

import { httpGate, parkedPage, titleOf, visibleText } from "./gate.mjs";
import { BOT_WALL, capturedBlocked, isBlockedReason, isBotWallReason } from "./capture-blocked.mjs";
import { ensureRosterSchema, NOT_PORTFOLIO } from "./roster.mjs";
import { portfolioSignals } from "./signals.mjs";
import { HELD_SQL, notPortfolioReason } from "./portfolio-guard.mjs";
import { replaceGradeStatements } from "./rubric-history.mjs";
import { atTheDoor } from "../lib/reviews/door.mjs";
import { APPLIED, OPEN_CASE_SQL, ensureReviewSchema } from "../lib/reviews/store.mjs";
import { rankForWrite, rankFromCode } from "../lib/tiers-store.mjs";
import { assignShownRanks } from "../lib/ranking/store.mjs";
import { reconcileAlerts } from "./alerts.mjs";
import {
  LADDER_UNKNOWN_SQL,
  HIDE_PER_DAY,
  LEAVE_AFTER_DAYS,
  NOT_WORKING,
  RECHECKED,
  RECHECK_AFTER_MS,
  HIDE_WEAK_PER_DAY,
  SPIKE_CLASS,
  SPIKE_NEW,
  SPIKE_WEAK,
  SPIKE_WEAK_WINDOW_MS,
  SPIKE_WINDOW_MS,
  isWeakVerdict,
  ON_LADDER_SQL,
  PURGE_BACK,
  PURGE_GONE,
  VALID_MARKS,
  columnsOf,
  failOnLadder,
  holdOnLadder,
  leavesList,
  poolOf,
  confirmAfterMs,
  pruneReturns,
  reasonClass,
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

// Every failed check takes the one ladder of ./not-working.mjs (its
// thresholds are there). When the check could not tell (timeouts, dropped connections, DNS, a broken
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
 * What a page links to, in the shape the capture's own rule reads
 * (./capture-blocked.mjs capturedBlocked, as pageEvidence counts in the
 * browser): other hosts (outboundLinks), other pages of the same site
 * (siteLinks) and mailto: or tel: links (contactLinks), from the HTML's hrefs.
 */
export function linksOf(html, base) {
  const hosts = new Set();
  const pages = new Set();
  let contactLinks = 0;
  let here;
  try {
    here = new URL(String(base));
  } catch {
    return { outboundLinks: 0, siteLinks: 0, contactLinks: 0 };
  }
  const host = (u) => u.hostname.replace(/^www\./, "");
  const path = (u) => u.pathname.replace(/\/+$/, "") || "/";
  for (const m of String(html ?? "").matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    let u;
    try {
      u = new URL(m[1], here);
    } catch {
      continue;
    }
    if (u.protocol === "mailto:" || u.protocol === "tel:") contactLinks++;
    else if (!/^https?:$/.test(u.protocol)) continue;
    else if (host(u) !== host(here)) hosts.add(u.hostname);
    else if (path(u) !== path(here)) pages.add(path(u));
  }
  return { outboundLinks: hosts.size, siteLinks: pages.size, contactLinks };
}

/** Scripts written without spaces between words: a name in them is matched as written, whole. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** How much of a page's text the name test reads: its opening, where a portfolio says whose it is. */
export const NAME_TEXT_CHARS = 2000;

/**
 * Whether a page carries the listed person's name: the archive check's test
 * that a site that answers again is still that person's, not a re-registered
 * domain (#292 reviews, F4 and the second review's item 2). Read in the title
 * and the first NAME_TEXT_CHARS of the text, Unicode-aware, case and accents
 * folded:
 *   every name word of three letters or more, as whole words, together (only
 *   spaces, punctuation and words of one or two letters between them), in
 *   any order, a later word allowed as its initial with a full stop ("Mnelisi
 *   M."), so "Ann Arbor lee county" and "annual" are not "Ann Lee", and
 *   "Jane Doe" is not "Jane Smith";
 *   a part in a script written without spaces (Chinese, Japanese, Korean,
 *   Thai...) as written, whatever its length;
 *   a one-word name in the title or the first heading only (`heading`);
 *   a name of only short words ("Ed Li", third review of #292): all of them,
 *   as whole words together, in the title or the first heading only;
 *   no name at all never matches.
 * The address never counts: a re-registered domain keeps the name in it.
 * The archive check takes a page with strong portfolio signals too (a handle
 * instead of the name: ./exclusions.mjs passesFullCheck).
 */
export function carriesName(name, { title = "", text = "", heading = "" } = {}) {
  const parts = String(name ?? "").normalize("NFC").split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  const unspaced = parts.filter((p) => UNSPACED.test(p));
  const long = parts.filter((p) => !UNSPACED.test(p)).map(fold).filter((w) => [...w].length >= 3);
  const shortOnly = !unspaced.length && !long.length;
  const words = shortOnly ? parts.map(fold) : long;
  if (!unspaced.length && !words.length) return false;
  const one = shortOnly || (unspaced.length + words.length === 1 && !unspaced.length);
  const where = one ? `${title}\n${heading}` : `${title}\n${String(text ?? "").slice(0, NAME_TEXT_CHARS)}`;
  const folded = fold(where);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The name's words as one phrase, in order: between two of them only spaces, punctuation and short words
  // ("José de la Cruz"), so "Ann Arbor lee county" is not "Ann Lee".
  const between = "(?:[^\\p{L}\\p{N}\\p{M}]+(?:[\\p{L}\\p{M}]{1,2}[^\\p{L}\\p{N}\\p{M}]+)*)";
  // In any order ("Cyubahiro Benjamin" for Benjamin Cyubahiro), the first word in full and a later one in
  // full or as its initial with a full stop ("Mnelisi M." for Mnelisi Mthuli).
  const orders = (list) => (list.length <= 1 || list.length > 4 ? [list] : list.flatMap((w, i) => orders([...list.slice(0, i), ...list.slice(i + 1)]).map((rest) => [w, ...rest])));
  const later = (w) => `(?:${escape(w)}|${escape([...w][0])}\\.)`;
  // A name of three words or more may drop its middle ones ("Yogesh Paliyal" for Yogesh Choudhary Paliyal).
  const forms = words.length >= 3 ? [words, [words[0], words[words.length - 1]]] : [words];
  const phrase = words.length
    ? forms.flatMap(orders).some((o) => new RegExp(`(^|[^\\p{L}\\p{N}\\p{M}])${[escape(o[0]), ...o.slice(1).map(later)].join(between)}($|[^\\p{L}\\p{N}\\p{M}])`, "u").test(folded))
    : true;
  return phrase && unspaced.every((p) => String(where).normalize("NFC").includes(p));
}

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

/**
 * The markup of a bot or captcha service's challenge (Cloudflare's challenge
 * platform and Turnstile, Vercel's checkpoint, hCaptcha, reCAPTCHA, Imperva,
 * DDoS-Guard, PerimeterX, DataDome, Sucuri), for a page that shows no words:
 * a challenge still deciding, not a blank site. The `cf-mitigated` header
 * would say it too, but the plain request (./gate.mjs) does not keep headers.
 */
export const CHALLENGE_MARKUP =
  /challenges\.cloudflare\.com|\/cdn-cgi\/challenge-platform|cf-turnstile|_vercel\/(security|challenge)|vercel-challenge|hcaptcha\.com|www\.google\.com\/recaptcha|_Incapsula_Resource|ddos-guard|px-captcha|captcha-delivery\.com|sucuri_cloudproxy/i;

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
      if (wall || (gate.status !== "error" && (gate.httpStatus === 202 || CHALLENGE_MARKUP.test(String(gate.html ?? ""))))) return blocked(gate.httpStatus, finalUrl);
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
    // Where the browser ended up, after the page's own redirects (./gate.mjs parkedPage, as the capture judges it).
    const parked = parkedPage({ finalUrl, html: String(page.html ?? ""), text, title: String(page.title ?? "") });
    if (parked) return { ok: false, reason: parked, finalUrl };
    if (text.length < BLANK_TEXT && !page.media) {
      // A blank page that is a challenge with no words of its own (a 202 while a script decides, or the
      // markup of a known bot or captcha service): a bot wall, inconclusive, never a failure (#292 review, F2).
      if (page.status === 202 || gate.httpStatus === 202 || CHALLENGE_MARKUP.test(`${page.html ?? ""}\n${gate.html ?? ""}`)) return blocked(page.status, finalUrl);
      return { ok: false, reason: "renders blank", finalUrl };
    }
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
  // What the page says, for the archive check's same-person test (./exclusions.mjs passesFullCheck).
  // With the page's first heading and what it links to, for the capture's own rule on what shows a site.
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(String(html ?? ""));
  const seen = { pageText: text.slice(0, 20000), title: titleOf(html), heading: h1 ? visibleText(h1[1]).slice(0, 200) : "", links: linksOf(html, finalUrl) };
  if (redirect?.moved) return { ok: true, reason: "", finalUrl, moved: true, hijack: redirect.hijack, signals, ...seen };
  return { ok: true, reason: "", finalUrl, signals, ...seen };
}

/**
 * The address a site ended at on an earlier read (row.final_url, else the
 * capture's facts.final_url), when it is the listed address written another
 * way: only the scheme or a leading www differs, the path and query are the
 * same (second review of #292, item 5). null otherwise, and always for another
 * host (a move, never followed here) or another page of the site.
 */
export function sameSiteAddress(url, row) {
  const host = (u) => u.hostname.toLowerCase().replace(/^www\./, "");
  const rest = (u) => `${u.port}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  const plain = (u) => `${u.protocol}//${u.hostname.toLowerCase()}${rest(u)}`;
  let a;
  try {
    a = new URL(String(url));
  } catch {
    return null;
  }
  for (const stored of [row?.final_url, row?.facts_final_url]) {
    if (!stored) continue;
    let b;
    try {
      b = new URL(String(stored));
    } catch {
      continue;
    }
    if (/^https?:$/.test(b.protocol) && host(a) === host(b) && rest(a) === rest(b) && plain(a) !== plain(b)) return b.href;
  }
  return null;
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
 * from the row and health_marks (or null); result: { ok, reason, decided? }
 * with ok true, false or null (inconclusive). Four rules, in order: a pass
 * restores; could-not-tell changes nothing; a removal decided in the review
 * queue stays down (`decided`); every other failure is the one ladder of
 * ./not-working.mjs, whatever its kind (not answering, parked, blank, a
 * redirect to a social profile, a duplicate, a blocked capture).
 * Returns the new { health, fails, firstFailAt, lastFailAt, reason, pool }.
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
  // 3. A removal decided in the review queue stays down with its reason, off the ladder: it was decided,
  //    not seen failing, so no check of the site decides it (an Undo or the owner does).
  if (result.decided) {
    return { health: "down", fails: Number(prev?.fails ?? 0), firstFailAt: prev?.firstFailAt ?? now.toISOString(), lastFailAt: prev?.lastFailAt ?? null, reason: result.reason, pool: null };
  }
  // 4. The one ladder (./not-working.mjs). A row already down with no ladder (from before the pool, the
  //    old weekly-counted rule, or its marks voided) is in the pool since its first failure, so it never
  //    shows again on a failure and goes to the archive only on a fresh failed check.
  if (!prev?.pool && prev?.health === "down") {
    const since = prev.firstFailAt ?? now.toISOString();
    return failOnLadder({ ...prev, pool: { stage: NOT_WORKING, startedAt: since, since, nextAt: null, unclear: 0, firstAt: since, held: null } }, result, now);
  }
  return failOnLadder(prev, result, now);
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
  // The day's pace of hiding and the spike freeze's limits (./not-working.mjs); a test may set its own.
  hidePerDay = HIDE_PER_DAY,
  hideWeakPerDay = HIDE_WEAK_PER_DAY,
  spikeNew = SPIKE_NEW,
  spikeClass = SPIKE_CLASS,
  spikeWeak = SPIKE_WEAK,
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
            p.final_url, CASE WHEN json_valid(p.facts) THEN json_extract(p.facts, '$.final_url') END AS facts_final_url,
            ${RUBRIC_TOKEN("p")} AS rubric_token,
            CASE WHEN ${NOT_PORTFOLIO("p")} THEN 1 ELSE 0 END AS not_portfolio,
            CASE WHEN ${OPEN_CASE_SQL("p")} THEN 1 ELSE 0 END AS open_case,
            CASE WHEN ${REMOVAL_ON_RECORD_SQL("p")} THEN 1 ELSE 0 END AS decided_removal,
            ${["last_fail_at", "unknown_weeks", "unknown_last_at", "unknown_since", "pool_stage", "pool_started_at", "pool_next_at", "pool_since", "pool_unclear", "answers_at", "pool_first_at", "pool_held"].map((c) => `${mark(c)} AS ${c}`).join(", ")},
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

  // The listed address failed, but the site answers at the address it ended at on an earlier read, on the
  // same host (the scheme or www: http://gianlucafiore.it has a stale server among its DNS answers, while
  // https://www.gianlucafiore.it serves the site). That address passing means the site works: the failure
  // is not counted, and health_marks.answers_at records where it answers for the owner's Health pool page.
  // Never another host: that is a move (redirectVerdict).
  const rescueOf = (r) => (r.ok === false ? sameSiteAddress(r.url, rows.get(r.url)) : null);
  const rescues = results.filter((r) => rescueOf(r));
  if (rescues.length) {
    await mapPool(rescues, concurrency, async (r) => {
      const at = rescueOf(r);
      const again = await checkSite({ url: at, name: r.name }, { fetchImpl, render: counted }).catch(() => null);
      if (again?.ok !== true) return;
      log(`${r.url} - failed (${r.reason}), but the site answers at ${at}: not counted`);
      Object.assign(r, { ok: true, reason: "", finalUrl: again.finalUrl ?? at, signals: again.signals, answersAt: at, listedFailed: r.reason });
      delete r.moved;
      delete r.hijack;
    });
  }

  // Duplicates are failures too, only after loading. A "not a portfolio" grade never is.
  const dupes = findDuplicates(results.filter((r) => r.ok));
  // A site on the ladder as a duplicate whose original is not in this run (the hourly re-check takes only the
  // due sites) is still a duplicate while the original is listed under the same address, or the address this
  // site now ends at: otherwise a re-check would pass it every time and the nightly run fail it again.
  const inRun = new Set(results.map((r) => r.url));
  const dupOf = (row) => (String(row?.health_reason ?? "").startsWith("duplicate of ") ? String(row.health_reason).slice("duplicate of ".length) : null);
  const askOriginals = [...new Set(results.filter((r) => r.ok && !dupes.has(r.url) && dupOf(rows.get(r.url)) && !inRun.has(dupOf(rows.get(r.url)))).map((r) => dupOf(rows.get(r.url))))];
  if (askOriginals.length) {
    const originals = new Map();
    for (let i = 0; i < askOriginals.length; i += 400) {
      const part = askOriginals.slice(i, i + 400);
      const got = await db.execute({ sql: `SELECT url, final_url FROM portfolios WHERE delisted_at IS NULL AND url IN (${part.map(() => "?").join(",")})`, args: part });
      for (const o of got.rows) originals.set(String(o.url), o.final_url == null ? null : String(o.final_url));
    }
    for (const r of results) {
      const original = r.ok && !dupes.has(r.url) ? dupOf(rows.get(r.url)) : null;
      if (!original || !originals.has(original)) continue;
      const theirs = new Set([normKey(original), ...(originals.get(original) ? [normKey(originals.get(original))] : [])]);
      if ([r.url, r.finalUrl].filter(Boolean).some((u) => theirs.has(normKey(u)))) dupes.set(r.url, original);
    }
  }
  const toDoor = [];
  for (const r of results) {
    const was = rows.get(r.url);
    const notPortfolio = Number(was?.not_portfolio ?? 0) === 1;
    // A removal decided in the review queue (the owner's, or the door's rule; a row on record that
    // nobody undid) stays down with its reason, whatever this check sees, until an Undo or an owner
    // decision changes the grade or the health: it was decided, not seen failing.
    if (notPortfolio && Number(was?.decided_removal ?? 0) === 1 && String(was?.health ?? "") === "down" && notPortfolioReason(was?.health_reason)) {
      r.ok = false;
      r.decidedDown = true;
      r.decided = true;
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
  //   fails, with the capture's reason, so a site that stays blocked takes
  //   the ladder into the pool and the archive as broken (exclusions.mjs kind
  //   "down"), never as "not a portfolio".
  // - A bot wall alone is never a failure (owner, 2026-11-16 and 2026-11-23):
  //   the capture's wall never fails the site, and a pass of a site that is
  //   not failing is inconclusive, so the state stays as it was and the site
  //   stays hidden (lib/hidden.mjs) instead of being shown uncaptured; its
  //   needs_review mark is kept below. A real failure this check sees (it
  //   does not load, an HTTP error, parked, blank) counts like any site's,
  //   and a pass of a bot-walled site on the ladder brings it back as it was;
  //   the owner is asked about the wall once more after that
  //   (lib/reviews/door.mjs syncReviewRows).
  // A bot wall this check meets itself stays inconclusive in every case.
  const botWalled = new Set();
  for (const r of results) {
    const row = rows.get(r.url);
    if (!row) continue;
    if (isBotWallReason(row.reason)) {
      botWalled.add(r.url);
      const failing = Number(row.pool_valid ?? 0) === 1 || ["suspect", "down"].includes(String(row.health ?? ""));
      if (r.ok === true && !failing) {
        r.ok = null;
        r.reason = String(row.reason);
      }
      // A blank page behind a known wall is the wall still deciding, not a blank site (#292 review, F2).
      if (r.ok === false && !r.decidedDown && /^renders blank/.test(String(r.reason))) {
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
    restarted: [],
    newlyHidden: [],
    returned: [],
    leavingList: [],
    leftToRecheck,
    // The listed address failed but the site answered at its own www or https address: not counted.
    answersElsewhere: [],
  };
  const str = (v) => (v == null ? null : String(v));
  // Every site's next state first, so the day's pace and the spike freeze can see them all at once.
  const computed = new Map();
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
    // A removal decided in the review queue is down with its reason (rule 3 of nextHealth), off the ladder.
    computed.set(r, { row, prev, at, next: nextHealth(r.decidedDown ? { ...prev, pool: null } : prev, r, at) });
  }
  const pace = await hidingPace(db, { hasPool, hasFirst: marksCols.has("pool_first_at"), hasHeld: marksCols.has("pool_held"), now, hidePerDay, hideWeakPerDay, spikeNew, spikeClass, spikeWeak });
  summary.pace = pace;
  const DAYMS = 86400000;
  const isoAt = (ms) => new Date(ms).toISOString();
  // Out of a freeze once it lifts (a strong spike's window has passed; most of a weak freeze's held sites
  // pass again): a site still failing starts its evidence again from now (the next day, or a week for a
  // weak verdict), so nothing frozen is hidden on what was seen during the freeze.
  {
    for (const [r, c] of computed) {
      const held = c.prev?.pool?.held;
      const lifted = (held === "freeze" && !pace.frozen) || (held === "freeze-weak" && !pace.weakFrozen);
      if (!lifted || !c.next.pool) continue;
      const t = c.at.getTime();
      c.next = { ...c.next, health: c.next.health === "down" ? "suspect" : c.next.health, fails: Math.min(Number(c.next.fails ?? 0), RECHECKED), pool: { ...c.next.pool, stage: Math.min(c.next.pool.stage, RECHECKED), since: null, startedAt: isoAt(t), nextAt: isoAt(t + confirmAfterMs(c.next.reason)), held: null } };
      pace.released.push({ url: r.url, reason: c.next.reason });
    }
  }
  // The sites this run would hide, oldest first failure first.
  const hiding = [...computed.entries()]
    .filter(([, c]) => c.next.pool?.stage === NOT_WORKING && c.prev?.pool?.stage !== NOT_WORKING && c.prev?.health !== "down")
    .sort(([, a], [, b]) => String(a.prev?.pool?.firstAt ?? "").localeCompare(String(b.prev?.pool?.firstAt ?? "")));
  const spikeFrom = now.getTime() - SPIKE_WINDOW_MS;
  const left = { strong: pace.allowance, weak: pace.allowanceWeak };
  for (const [r, c] of hiding) {
    const weak = isWeakVerdict(c.next.reason);
    const firstAt = Date.parse(String(c.prev?.pool?.firstAt ?? ""));
    const fromSpike = !weak && pace.frozen && ((Number.isFinite(firstAt) && firstAt >= spikeFrom) || c.prev?.pool?.held === "freeze");
    const holdAt = (pool) => ({ ...c.next, health: "suspect", fails: RECHECKED, pool: { ...c.next.pool, stage: RECHECKED, since: null, ...pool } });
    if (weak && pace.weakFrozen) {
      // A weak freeze (our reader, most likely, and it may keep going): every weak verdict waits, still shown,
      // checked daily, its evidence starting again; it lifts only when most of them pass again.
      c.next = holdAt({ startedAt: isoAt(c.at.getTime()), nextAt: isoAt(c.at.getTime() + DAYMS), held: "freeze-weak" });
      pace.frozenHeld.push({ url: r.url, reason: c.next.reason });
    } else if (fromSpike) {
      // A strong spike (a fault on our side, or a host-wide outage): held, and its evidence starts again from
      // now, so once the spike is over it still needs its full confirming wait.
      c.next = holdAt({ startedAt: isoAt(c.at.getTime()), nextAt: isoAt(c.at.getTime() + DAYMS), held: "freeze" });
      pace.frozenHeld.push({ url: r.url, reason: c.next.reason });
    } else if (left[weak ? "weak" : "strong"] <= 0) {
      // The day's allowance for its kind is used: waits, still shown, until a place frees (the oldest hide of
      // that kind in the last day turns 24 hours).
      const oldest = weak ? pace.oldestWeakToday : pace.oldestToday;
      const free = oldest ? Date.parse(oldest) + DAYMS : c.at.getTime() + DAYMS;
      c.next = holdAt({ nextAt: isoAt(Math.max(c.at.getTime() + RECHECK_AFTER_MS, free)), held: "drain" });
      pace.drained.push({ url: r.url, reason: c.next.reason });
    } else {
      left[weak ? "weak" : "strong"]--;
      c.next = { ...c.next, pool: { ...c.next.pool, held: null } };
      if (weak) pace.oldestWeakToday = pace.oldestWeakToday ?? isoAt(c.at.getTime());
      else pace.oldestToday = pace.oldestToday ?? isoAt(c.at.getTime());
    }
  }
  const plans = [];
  for (const r of results) {
    const { row, prev, at } = computed.get(r);
    let next = computed.get(r).next;
    const stamp = at.toISOString();
    // A bot-walled site that never had a good capture, back from a real failure: unchecked again, as before
    // its failure (never "live"), so it stays hidden until a capture gets through instead of being shown
    // with no screenshot (lib/hidden.mjs: a failed capture is hidden unless the health check says live).
    if (r.ok === true && botWalled.has(r.url) && String(row?.status ?? "") === "error") next = { ...next, health: null };
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
    // Signals only from a page that loaded; otherwise the last ones stay. Low signals change nothing about
    // the site (owner's default, 2026-11-23): it stays listed, recorded as one the code could not read.
    const signals = r.signals
      ? JSON.stringify({
          ...r.signals,
          ...(r.signals.needsReview ? { unread: true } : {}),
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
        // Only a read that passed says where the site ends (a failed one may end at a stale server's page).
        r.ok === true ? r.finalUrl ?? null : null,
        signals,
        // The signals' verdict, but a bot-walled capture's mark for the owner's review is never cleared here.
        r.signals?.needsReview || botWalled.has(r.url) ? 1 : 0,
        ...stillAsReadArgs(row),
      ],
    };
    // The check's own memory, written only when the row above was (changes() is that statement's count).
    // Columns added later, written when the table has them: where the site answers when its listed address
    // does not (the rescue above: set by a pass through it, cleared by a pass of the listed address itself,
    // kept by a failure or a check that could not tell), the first failure of this run of failures, and why
    // it waits at stage 2 (the drain or a spike freeze).
    const later = [
      ["answers_at", r.ok === true ? r.answersAt ?? null : row?.answers_at == null ? null : String(row.answers_at)],
      ["pool_first_at", pool?.firstAt ?? null],
      ["pool_held", pool?.held ?? null],
    ].filter(([c]) => marksCols.has(c));
    const mark = {
      sql: `INSERT INTO health_marks (url, last_fail_at, unknown_weeks, unknown_last_at, unknown_since,
                                      pool_stage, pool_started_at, pool_next_at, pool_since, pool_unclear,
                                      pool_health, pool_checked_at, purge_pending${later.map(([c]) => `, ${c}`).join("")})
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${later.map(() => ", ?").join("")} WHERE changes() > 0
            ON CONFLICT(url) DO UPDATE SET last_fail_at = excluded.last_fail_at, unknown_weeks = excluded.unknown_weeks,
              unknown_last_at = excluded.unknown_last_at, unknown_since = excluded.unknown_since,
              pool_stage = excluded.pool_stage, pool_started_at = excluded.pool_started_at,
              pool_next_at = excluded.pool_next_at, pool_since = excluded.pool_since, pool_unclear = excluded.pool_unclear,
              pool_health = excluded.pool_health, pool_checked_at = excluded.pool_checked_at,
              -- Set when this write takes the profile away (1) or brings it back (2); cleared by the hourly purge
              -- once the cached copies agree (./not-working.mjs purgeGoneProfiles).
              purge_pending = CASE WHEN excluded.purge_pending > 0 THEN excluded.purge_pending ELSE health_marks.purge_pending END
              ${later.map(([c]) => `, ${c} = excluded.${c}`).join("")}`,
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
        ...later.map(([, v]) => v),
      ],
    };
    // A marks row only when there is something to keep or to clear: a ladder, a counted failure, a streak
    // of could-not-tell, a profile to purge, or a row already there. A healthy site without one gets none.
    const needMark = Number(row?.has_marks ?? 0) === 1 || Boolean(pool) || Boolean(next.lastFailAt) || Boolean(marks.unknownSince) || purgeState > 0 || Boolean(r.answersAt);
    // Back from the ladder (failing, or hidden in the temporary pool): recorded for the owner's Health pool
    // page, written only when the row above was (changes() is that statement's count), before the marks.
    const back = r.ok === true && (Boolean(prev?.pool) || prev?.health === "suspect" || prev?.health === "down");
    const returned = back
      ? [
          {
            sql: "INSERT INTO health_returns (url, at, from_where, reason, since, hidden) SELECT ?, ?, 'pool', ?, ?, ? WHERE changes() > 0",
            args: [r.url, stamp, prev.reason || null, prev.pool?.since ?? prev.pool?.startedAt ?? prev.firstFailAt ?? null, hiddenBefore ? 1 : 0],
          },
        ]
      : [];
    plans.push({ r, prev, next, marks, hiddenBefore, hiddenAfter, back, stmts: [stmt, ...returned, ...(needMark ? [mark] : [])] });
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
      // The log of returns keeps RETURNS_KEEP_DAYS.
      if (chunk.some((p) => p.back)) stmts.push(pruneReturns(now));
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
    if (r.answersAt) summary.answersElsewhere.push({ url: r.url, at: r.answersAt, listedFailed: r.listedFailed });
    if (r.signals?.needsReview) summary.needsReview.push({ url: r.url, score: r.signals.score });
    if (next.health === "down" && prev?.health !== "down") summary.newlyDown.push({ url: r.url, reason: next.reason });
    if (next.health === "live" && (prev?.health === "suspect" || prev?.health === "down")) summary.recovered++;
    // The not-working pool (./not-working.mjs).
    const wasOnLadder = Boolean(prev?.pool) || prev?.health === "suspect" || prev?.health === "down";
    if (next.pool && !wasOnLadder) summary.newlyFailing.push({ url: r.url, reason: next.reason });
    // The old weekly-counted rule's failing rows restarting on the ladder (release night): counted so a dry
    // run shows how many there are, by kind, before the first real run. They keep their original first
    // failure (./not-working.mjs failOnLadder), so they are never counted as a spike of new failures.
    if (next.pool && !prev?.pool && prev?.health === "suspect") summary.restarted.push({ url: r.url, reason: next.reason, kind: reasonClass(next.reason), firstAt: next.pool.firstAt });
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
  // The spike freeze: one owner alert while it holds, cleared by itself once the spike is over (read from
  // the marks, so every run agrees). The day's ordinary pace (the drain) never alerts.
  await reconcileAlerts(db, {
    conditions:
      pace.frozen || pace.weakFrozen
        ? [
            {
              key: SPIKE_ALERT_KEY,
              kind: "problem",
              title: pace.weakFrozen
                ? `${Math.max(pace.newWeak, pace.heldWeak)} listed sites look blank, blocked or not themselves to our reader: none of them is hidden while it lasts`
                : `${pace.newFailures} listed sites started failing within ${SPIKE_WINDOW_MS / 86400000} days: none of them is hidden while it lasts`,
              detail: pace.weakFrozen
                ? `${pace.newWeak} new weak verdicts (a blank page, a blocked capture, a social redirect, a duplicate, not the site, the browser's error page) within ${SPIKE_WEAK_WINDOW_MS / 86400000} days, ${pace.heldWeak} held that still fail. So many usually means our reader, and it may keep going, so this stands until fewer than ${spikeWeak} of them still fail; then each still failing needs a full week again before it is hidden, ${hideWeakPerDay} a day.`
                : `So many new failures at once (by kind: ${Object.entries(pace.byClass).map(([k, n]) => `${k} ${n}`).join(", ")}) usually means the checker or a host-wide outage rather than the sites. They stay shown; once the spike is over, each still failing is hidden only after its full confirming wait, ${hidePerDay} a day. This clears by itself.`,
            },
          ]
        : [],
    scope: (key) => key === SPIKE_ALERT_KEY,
    now,
    log,
  });
  // The nightly look at the pool (#292 review, item 6): one plain request to every site hidden in the pool
  // that is not due for its re-check within the hour. It can only bring a site back sooner, never fail one:
  // a page that answers with words moves its re-check to now, and the hourly re-check's full check decides.
  // A site fixed on day 36 is back the next day, not at its day-65 check.
  if (scheduled === "skip" && hasPool) {
    const soon = new Date(now.getTime() + 3600000).toISOString();
    const waiting = (
      await db.execute({
        sql: `SELECT p.url FROM health_marks m JOIN portfolios p ON p.url = m.url
              WHERE ${VALID_MARKS()} AND p.delisted_at IS NULL AND m.pool_stage = ${NOT_WORKING} AND m.pool_next_at > ?
                AND NOT (p.status = 'error' AND substr(COALESCE(p.reason, ''), 1, 17) = 'capture blocked: ')`,
        args: [soon],
      })
    ).rows.map((r) => String(r.url));
    const nudged = [];
    await mapPool(waiting, concurrency, async (url) => {
      const gate = await httpGate(url, { fetchImpl }).catch(() => null);
      if (gate?.status === "live" && !gateWall(gate) && visibleText(gate.html).length >= BLANK_TEXT) nudged.push(url);
    });
    for (const url of nudged) {
      await db.execute({
        sql: `UPDATE health_marks SET pool_next_at = ? WHERE url = ? AND EXISTS (SELECT 1 FROM portfolios p WHERE p.url = health_marks.url AND ${VALID_MARKS("health_marks", "p")})`,
        args: [now.toISOString(), url],
      });
    }
    summary.poolNudged = nudged;
  }
  // A site back from the pool rejoins the library at once with the rating it had (lib/tiers-store.mjs
  // rankFromCode puts a seeded row back), not at the next daily tiers run.
  for (const b of summary.returned) {
    try {
      await rankFromCode(db, b.url, { now: now.getTime() });
    } catch (e) {
      log(`tiers: ${b.url} not put back now (${String(e?.message ?? e).slice(0, 120)}); the daily run does it`);
    }
  }
  return { aborted: false, checked: results.length, controls: controlResults.length, ...summary };
}

/** The owner alert for sites the check could not judge for UNKNOWN_DAYS_TO_OWNER days (pipeline/alerts.mjs). */
export const UNKNOWN_ALERT_KEY = "health-unknown";
/** The same for sites on the not-working ladder (./not-working.mjs), read from the marks. */
export const UNKNOWN_LADDER_ALERT_KEY = "health-unknown-ladder";
/** The owner alert while a spike of new failures freezes hiding (./not-working.mjs SPIKE_NEW). */
export const SPIKE_ALERT_KEY = "health-spike-freeze";

/**
 * The day's pace of hiding and the spike freeze, read from the marks so the
 * nightly run and every hourly batch agree (./not-working.mjs HIDE_PER_DAY,
 * SPIKE_NEW, SPIKE_CLASS, SPIKE_WINDOW_MS):
 *   hiddenToday   sites hidden in the last 24 hours; allowance what is left of
 *                 the day's HIDE_PER_DAY; oldestToday the first of them
 *   newFailures   sites that entered the ladder within the spike window and
 *                 still fail, by kind (byClass); frozen when over the limits
 * Returns that, with empty lists for the sites this run holds.
 */
async function hidingPace(db, { hasPool, hasFirst, hasHeld, now, hidePerDay, hideWeakPerDay, spikeNew, spikeClass, spikeWeak }) {
  const out = {
    // The drain, by kind: strong evidence and weak verdicts (./not-working.mjs isWeakVerdict) each have their own allowance.
    hiddenToday: 0,
    hiddenWeakToday: 0,
    allowance: hidePerDay,
    allowanceWeak: hideWeakPerDay,
    oldestToday: null,
    oldestWeakToday: null,
    // The strong spike: new first failures of strong evidence within SPIKE_WINDOW_MS, released on that timer.
    newFailures: 0,
    byClass: {},
    frozen: false,
    // The weak spike: new weak first failures within SPIKE_WEAK_WINDOW_MS, and the sites it holds that still fail.
    newWeak: 0,
    heldWeak: 0,
    weakFrozen: false,
    frozenHeld: [],
    drained: [],
    released: [],
  };
  if (!hasPool) return out;
  const join = `FROM health_marks m JOIN portfolios p ON p.url = m.url WHERE ${VALID_MARKS()} AND p.delisted_at IS NULL`;
  const today = (
    await db.execute({ sql: `SELECT p.health_reason, m.pool_since ${join} AND m.pool_stage = ${NOT_WORKING} AND m.pool_since > ? ORDER BY m.pool_since`, args: [new Date(now.getTime() - 86400000).toISOString()] })
  ).rows;
  for (const r of today) {
    const weak = isWeakVerdict(r.health_reason);
    if (weak) out.hiddenWeakToday++;
    else out.hiddenToday++;
    if (weak) out.oldestWeakToday = out.oldestWeakToday ?? String(r.pool_since);
    else out.oldestToday = out.oldestToday ?? String(r.pool_since);
  }
  out.allowance = Math.max(0, hidePerDay - out.hiddenToday);
  out.allowanceWeak = Math.max(0, hideWeakPerDay - out.hiddenWeakToday);
  const first = hasFirst ? "COALESCE(m.pool_first_at, m.pool_started_at)" : "m.pool_started_at";
  const recent = (await db.execute({ sql: `SELECT p.health_reason, ${first} AS first_at ${join} AND ${first} >= ?`, args: [new Date(now.getTime() - SPIKE_WEAK_WINDOW_MS).toISOString()] })).rows;
  const strongFrom = new Date(now.getTime() - SPIKE_WINDOW_MS).toISOString();
  for (const r of recent) {
    if (isWeakVerdict(r.health_reason)) {
      out.newWeak++;
      continue;
    }
    if (String(r.first_at) < strongFrom) continue;
    out.newFailures++;
    const k = reasonClass(r.health_reason);
    out.byClass[k] = (out.byClass[k] ?? 0) + 1;
  }
  if (hasHeld) out.heldWeak = Number((await db.execute(`SELECT COUNT(*) AS n ${join} AND m.pool_held = 'freeze-weak'`)).rows[0]?.n ?? 0);
  out.frozen = out.newFailures > spikeNew || Object.values(out.byClass).some((n) => n > spikeClass);
  // A weak freeze lifts only when fewer than the limit of the sites it holds still fail, never on a timer.
  out.weakFrozen = out.newWeak > spikeWeak || out.heldWeak >= spikeWeak;
  return out;
}

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

/** The temporary pool's one line for a job summary: re-checked, back, failing for the first time, hidden, going to the archive. */
export function poolLine(s) {
  const n = (a) => (Array.isArray(a) ? a.length : Number(a ?? 0));
  return `Temporary pool: ${s.due != null ? `${s.checked} re-checked, ` : ""}${n(s.returned)} back, ${n(s.newlyFailing)} failing for the first time (out of AI work), ${n(s.newlyHidden)} newly hidden, ${n(s.leavingList)} in the pool ${LEAVE_AFTER_DAYS}+ days (archived with the weekly export).`;
}

/** Markdown summary for GITHUB_STEP_SUMMARY. */
export function healthSummary(s) {
  if (s.aborted) return `## Health check\n\nFAILED: ${s.message}.\n`;
  const lines = [
    `## Health check${s.dryRun ? " (dry run: nothing written)" : ""}`,
    "",
    `Checked ${s.checked} listed site(s): ${s.live} live, ${s.suspect} failing, ${s.down} in the pool or down, ${s.recovered} recovered, ${s.inconclusive.length} inconclusive (bot checks, timeouts, dropped connections), ${s.needsReview.length} the code could not read (low signals, still listed).`,
    "",
    poolLine(s),
    "",
    `A site that fails a check (it does not answer, is parked or blank, redirects to a social profile, or duplicates another entry) leaves the AI's work at once and is hidden in the temporary pool when its re-check the next day fails too (pipeline/not-working.mjs); ${s.leftToRecheck ? `${s.leftToRecheck} site(s) on that ladder were left to the hourly re-check. ` : ""}One passing check brings it back as it was. An inconclusive check leaves the state unchanged, a bot wall alone never counts, and nothing here goes to the owner's review queue.`,
    "",
  ];
  if (s.restarted?.length) {
    // Release night: the old rule's failing rows restart on the ladder with their original first failure.
    const by = {};
    for (const r of s.restarted) by[r.kind] = (by[r.kind] ?? 0) + 1;
    lines.push(
      `### Restarted on the ladder (${s.restarted.length})`,
      "",
      `Sites already failing under the old weekly-counted rule, now on the ladder. They keep their original first failure, so they never count as a spike of new failures. By kind: ${Object.entries(by)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}.`,
      "",
    );
  }
  if (s.dryRun && s.changes) {
    lines.push(`### Would change (${s.changes.length})`, "", "| URL | From | To | Stage | Hidden | Reason |", "| --- | --- | --- | ---: | --- | --- |");
    for (const c of s.changes) lines.push(`| ${cell(c.url)} | ${cell(c.from ?? "unchecked")} | ${cell(c.to ?? "unchecked")} | ${c.stage ?? ""} | ${c.hidden ? "yes" : "no"} | ${cell(c.reason)} |`);
    lines.push("");
  }
  if (s.pace?.frozenHeld?.length) {
    lines.push(
      `### Held by the spike freeze (${s.pace.frozenHeld.length})`,
      "",
      `${s.pace.newFailures} sites started failing within ${SPIKE_WINDOW_MS / 86400000} days, more than a real outage brings: none of them is hidden while it lasts (owner alert ${SPIKE_ALERT_KEY}).`,
      "",
      ...s.pace.frozenHeld.map((h) => `- ${cell(h.url)} (${cell(h.reason)})`),
      ""
    );
  }
  if (s.pace?.drained?.length) {
    lines.push(`Waiting for a place in today's ${HIDE_PER_DAY} hides (still shown, hidden as places free): ${s.pace.drained.map((h) => cell(h.url)).join(", ")}.`, "");
  }
  if (s.poolNudged?.length) lines.push(`Hidden sites that answered a plain request tonight, re-checked within the hour: ${s.poolNudged.map(cell).join(", ")}.`, "");
  if (s.newlyHidden?.length) {
    lines.push(`### Into the temporary pool (hidden ${s.dryRun ? "if written" : "now"})`, "", "| URL | Reason |", "| --- | --- |");
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
      "### The code could not read these sites (low portfolio signals)",
      "",
      "Not removed, hidden, pooled or sent to the owner's review queue: each loaded, so it stays listed as it is. The low reading is recorded with its signals (unread), usually a page the reader could not read (an intro screen, a desktop-style design).",
      "",
      "| URL | Signals (of 6) |",
      "| --- | ---: |"
    );
    for (const n of s.needsReview) lines.push(`| ${cell(n.url)} | ${n.score} |`);
    lines.push("");
  }
  if (s.answersElsewhere?.length) {
    lines.push(
      "### Listed address unreliable (not counted)",
      "",
      "The listed address failed, but the site answered at its own address with www or https, where it ended on an earlier read. Not a failure; shown on /admin/health-pool.",
      "",
      "| Listed URL | Answers at | The listed address said |",
      "| --- | --- | --- |"
    );
    for (const a of s.answersElsewhere) lines.push(`| ${cell(a.url)} | ${cell(a.at)} | ${cell(a.listedFailed)} |`);
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
