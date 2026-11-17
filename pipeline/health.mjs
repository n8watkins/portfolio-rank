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
//   connection, a temporary DNS failure on the runner, or the check itself
//   crashing, each after a retry and the browser's second opinion
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

// Thresholds. The check runs weekly, so 3 failed checks in a row span 14 days.
// Requiring both means extra manual runs can't confirm a site down faster.
export const FAILS_TO_DOWN = 3;
export const DOWN_AFTER_DAYS = 13;
// A failed check counts only on a week of its own: the n-th counted failure
// comes at least (n - 1) * FAIL_WEEK_DAYS after the first. Two runs on one bad
// day count once. Six days, not seven, so a weekly run that starts a little
// early still counts.
export const FAIL_WEEK_DAYS = 6;
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
 * capture's rule (./capture-blocked.mjs capturedBlocked, its first rule, on
 * the page's title and visible text), so the capture and this check never
 * disagree about what a wall is.
 */
export const isBotWallPage = ({ title = "", text = "" } = {}) =>
  capturedBlocked({ title: String(title ?? ""), text: String(text ?? ""), outboundLinks: 1 }) === BOT_WALL;

/** The plain answer was a bot wall: its status, or its page (an error answer carries its page in gate.html). */
const gateWall = (gate) =>
  BOT_WALL_STATUS.has(gate.httpStatus) || (gate.status !== "dead" && Boolean(gate.html) && isBotWallPage({ title: titleOf(gate.html), text: visibleText(gate.html) }));

// The browser's errors that say nothing about the site: its own timeout, a
// connection dropped or reset (bot filters do this, as with ERR_HTTP2_PROTOCOL_ERROR
// for an old User-Agent), or the browser itself going away (a crash of the check).
const BROWSER_TRANSIENT =
  /Timeout \d+ms exceeded|net::ERR_(CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|SPDY_PROTOCOL_ERROR|TIMED_OUT|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|ABORTED)|Target (page, context or browser )?(has been )?closed|browser has been closed|Browser closed/i;

// Sleeping free-tier apps answer these while they wake up.
const COLD_START_STATUS = new Set([502, 503, 504]);
export const COLD_START_WAIT_MS = 30000;

const blocked = (status, finalUrl) => ({
  ok: null,
  reason: `blocked by a bot check${status ? ` (HTTP ${status})` : ""}`,
  finalUrl,
});

/** Inconclusive for a reason that says nothing about the site (a timeout, a dropped connection, a crash). */
const unknown = (reason, finalUrl) => ({ ok: null, reason: `could not tell: ${reason}`, finalUrl });

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
      // Neither opinion learned anything about the site (or the check's own code broke): inconclusive, never a failed check.
      const crashed = e instanceof TypeError || e instanceof ReferenceError || e instanceof RangeError || e instanceof SyntaxError;
      if (gate.transient || crashed || BROWSER_TRANSIENT.test(String(e?.message ?? e))) {
        return unknown(`${gate.status === "error" ? gate.reason : "plain request answered"}; browser: ${browserSaid}`, finalUrl);
      }
      const why = gate.status === "error" ? gate.reason : browserSaid;
      return { ok: false, reason: `does not load (${why})`, finalUrl };
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
 * The state machine. prev: { health, fails, firstFailAt } from the row (or
 * null); result: { ok, reason } with ok true, false or null (inconclusive).
 * A failure counts only on a week of its own (FAIL_WEEK_DAYS); one in the
 * same week as a counted one updates the reason and nothing else.
 * Returns the new { health, fails, firstFailAt, reason }.
 */
export function nextHealth(prev, result, now = new Date()) {
  if (result.ok === null) {
    return {
      health: prev?.health ?? null,
      fails: Number(prev?.fails ?? 0),
      firstFailAt: prev?.firstFailAt ?? null,
      reason: prev?.health && prev.health !== "live" ? prev.reason ?? result.reason : result.reason,
    };
  }
  if (result.ok) return { health: "live", fails: 0, firstFailAt: null, reason: "" };
  const before = Number(prev?.fails ?? 0);
  const firstFailAt = prev?.firstFailAt ?? now.toISOString();
  const span = (now.getTime() - new Date(firstFailAt).getTime()) / 86400000;
  const newWeek = before === 0 || span >= before * FAIL_WEEK_DAYS;
  const fails = newWeek ? before + 1 : before;
  const down = fails >= FAILS_TO_DOWN && span >= DOWN_AFTER_DAYS;
  return { health: down ? "down" : "suspect", fails, firstFailAt, reason: result.reason };
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
  const entries = feed.slice(0, limit);
  const results = await mapPool(entries, concurrency, async (entry, idx) => {
    // The check itself crashing says nothing about the site.
    const r = await checkSite(entry, { fetchImpl, render }).catch((e) => unknown(`the check crashed: ${String(e?.message ?? e).slice(0, 80)}`, null));
    const label = r.ok === null ? `inconclusive: ${r.reason}` : r.ok ? (r.moved ? `ok, moved to ${r.finalUrl}` : "ok") : r.reason;
    log(`[${idx + 1}/${entries.length}] ${entry.url} - ${label}`);
    return { ...entry, ...r };
  });

  const loadFailures = results.filter((r) => r.ok === false).length;
  if (entries.length >= 20 && loadFailures > entries.length * MAX_FAIL_SHARE) {
    return {
      aborted: true,
      checked: entries.length,
      failed: loadFailures,
      message: `${loadFailures} of ${entries.length} sites failed to load; more than ${MAX_FAIL_SHARE * 100}% points at the runner, so nothing was recorded`,
    };
  }

  // The rows as they are now, after the checks (which take most of an hour): the nightly capture, a
  // grade or a decision in /admin/review may have changed a site meanwhile. Every write below is
  // conditional on these values (stillAsRead), so a change made after this read is never overwritten.
  const rows = new Map(
    (
      await db.execute(
        `SELECT url, status, reason, health, health_reason, health_fails, health_first_fail_at, ai_rubric,
                CASE WHEN ${NOT_PORTFOLIO()} THEN 1 ELSE 0 END AS not_portfolio,
                CASE WHEN ${OPEN_CASE_SQL("portfolios")} THEN 1 ELSE 0 END AS open_case,
                CASE WHEN EXISTS (SELECT 1 FROM status_reviews d WHERE d.url = portfolios.url AND d.proposed = 'remove'
                                  AND d.status IN (${APPLIED.map((s) => `'${s}'`).join(", ")})) THEN 1 ELSE 0 END AS decided_removal
         FROM portfolios WHERE delisted_at IS NULL`
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
  };
  const plans = [];
  for (const r of results) {
    const row = rows.get(r.url);
    const prev = row
      ? {
          health: row.health == null ? null : String(row.health),
          fails: row.health_fails,
          firstFailAt: row.health_first_fail_at == null ? null : String(row.health_first_fail_at),
          reason: row.health_reason == null ? "" : String(row.health_reason),
        }
      : null;
    const next = nextHealth(prev, r, now);
    if (r.decidedDown) next.health = "down";
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
    plans.push({ r, prev, next, stmt });
  }
  const written = [];
  for (let i = 0; i < plans.length; i += 200) {
    const chunk = plans.slice(i, i + 200);
    const res = await db.batch(
      chunk.map((p) => p.stmt),
      "write"
    );
    chunk.forEach((p, j) => written.push(Number(res[j]?.rowsAffected ?? 0) > 0));
  }
  plans.forEach(({ r, prev, next }, i) => {
    if (!written[i]) {
      // Changed while the run was checking: nothing recorded, next week's check looks again.
      summary.changedDuringRun.push(r.url);
      return;
    }
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
      if (out) summary.toOwnerReview.push({ url, outcome: out.outcome, reviewId: out.reviewId });
    } catch (e) {
      log(`door: ${url} - left for next week: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  return { aborted: false, checked: results.length, ...summary };
}

// The columns a capture, a grade, a review decision or an Undo changes, compared with the values read
// after the checks. SQLite's IS compares NULLs as equal.
const GUARDED = ["status", "reason", "health", "health_reason", "health_fails", "health_first_fail_at", "ai_rubric"];
const STILL_AS_READ = `portfolios.delisted_at IS NULL AND ${GUARDED.map((c) => `portfolios.${c} IS ?`).join(" AND ")}`;
const stillAsReadArgs = (row) => GUARDED.map((c) => (row?.[c] == null ? null : typeof row[c] === "bigint" ? Number(row[c]) : row[c]));

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
              AND NOT EXISTS (SELECT 1 FROM status_reviews d WHERE d.url = p.url AND d.proposed = 'remove'
                              AND d.status IN (${APPLIED.map((s) => `'${s}'`).join(", ")}))`,
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
      "Graded \"not a portfolio\" before the review queue existed, with no decision on record. The door decided each one with a record (a removal by its rule, with Undo, or held for the owner); the health check never removes them itself.",
      "",
      "| URL | Door |",
      "| --- | --- |"
    );
    for (const d of s.toOwnerReview) lines.push(`| ${cell(d.url)} | ${cell(d.outcome)} |`);
    lines.push("");
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
