// PortfolioRank's own weekly health check (free: no Gemini, no paid APIs).
// For every site on the list it checks that the site loads, isn't parked or
// for sale, isn't blank, isn't a duplicate of another entry, and wasn't graded
// "not a portfolio"; redirects to another domain are reported as moves (and
// possible hijacks) for a person to look at. One bad check never removes
// anything:
//
//   live --fail--> suspect --fail--> ... --fail (FAILS_TO_DOWN checks in a row
//   spanning at least DOWN_AFTER_DAYS)--> down
//   any state --pass--> live (fail count reset)
//   a bot wall (403/429 challenge) is inconclusive: the state stays as it was
//
// Down sites are added to data/excluded.json (pipeline/exclusions.mjs), so the
// list drops them; until then the site and the background jobs skip them.

import { httpGate, isParkingDomain, netloc, parkingPhrase, visibleText } from "./gate.mjs";
import { ensureRosterSchema, NOT_PORTFOLIO } from "./roster.mjs";
import { portfolioSignals } from "./signals.mjs";

// Thresholds. The check runs weekly, so 3 failed checks in a row span 14 days.
// Requiring both means extra manual runs can't confirm a site down faster.
export const FAILS_TO_DOWN = 3;
export const DOWN_AFTER_DAYS = 13;
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
// 403 or 429 to automated checks while the site works for people. They say
// nothing about the site, so the check is inconclusive and the state stays.
const BOT_WALL_STATUS = new Set([403, 429]);
const BOT_WALL_TITLE = /vercel security checkpoint|just a moment|attention required|checking your browser/i;

// Sleeping free-tier apps answer these while they wake up.
const COLD_START_STATUS = new Set([502, 503, 504]);
export const COLD_START_WAIT_MS = 30000;

const blocked = (status, finalUrl) => ({
  ok: null,
  reason: `blocked by a bot check${status ? ` (HTTP ${status})` : ""}`,
  finalUrl,
});

/**
 * Check one site. `render(url)` loads it in a real browser and returns
 * { status, finalUrl, text, title, media } (or throws; media: the page shows
 * a canvas or large images, as canvas apps without DOM text do); it is the second opinion for
 * pages that fail over plain HTTP (flaky TLS, cold starts) or have no
 * server-rendered text (single-page apps, JavaScript redirects).
 * Returns { ok, reason, finalUrl, moved?, hijack? } where ok is true, false,
 * or null for inconclusive (a bot wall).
 */
export async function checkSite(
  entry,
  { fetchImpl = globalThis.fetch, render, timeoutMs = 20000, coldStartWaitMs = COLD_START_WAIT_MS } = {}
) {
  const { url, name } = entry;
  let gate = await httpGate(url, { fetchImpl, timeoutMs });
  if (gate.status === "error" && !BOT_WALL_STATUS.has(gate.httpStatus)) {
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
  if (gate.status === "error" || text.length < BLANK_TEXT) {
    const wall = BOT_WALL_STATUS.has(gate.httpStatus);
    if (!render) {
      if (wall) return blocked(gate.httpStatus, finalUrl);
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
      const why = gate.status === "error" ? gate.reason : String(e?.message ?? e).slice(0, 80);
      return { ok: false, reason: `does not load (${why})`, finalUrl };
    }
    finalUrl = page.finalUrl || finalUrl;
    if (BOT_WALL_STATUS.has(page.status) || BOT_WALL_TITLE.test(String(page.title ?? ""))) {
      return blocked(page.status, finalUrl);
    }
    if (page.status >= 400) return { ok: false, reason: `HTTP ${page.status}`, finalUrl };
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
  const fails = Number(prev?.fails ?? 0) + 1;
  const firstFailAt = prev?.firstFailAt ?? now.toISOString();
  const span = (now.getTime() - new Date(firstFailAt).getTime()) / 86400000;
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
}) {
  await ensureRosterSchema(db);
  const rows = new Map(
    (
      await db.execute(
        `SELECT url, status, health, health_reason, health_fails, health_first_fail_at,
                CASE WHEN ${NOT_PORTFOLIO()} THEN 1 ELSE 0 END AS not_portfolio
         FROM portfolios WHERE delisted_at IS NULL`
      )
    ).rows.map((r) => [String(r.url), r])
  );
  const entries = feed.slice(0, limit);
  const results = await mapPool(entries, concurrency, async (entry, idx) => {
    const r = await checkSite(entry, { fetchImpl, render }).catch((e) => ({
      ok: false,
      reason: `check crashed: ${String(e?.message ?? e).slice(0, 80)}`,
      finalUrl: null,
    }));
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

  // Duplicates and "not a portfolio" are failures too, only after loading.
  const dupes = findDuplicates(results.filter((r) => r.ok));
  for (const r of results) {
    if (!r.ok) continue;
    if (dupes.has(r.url)) {
      r.ok = false;
      r.reason = `duplicate of ${dupes.get(r.url)}`;
    } else if (Number(rows.get(r.url)?.not_portfolio ?? 0) === 1) {
      r.ok = false;
      r.reason = "AI grading says this is not a portfolio";
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
  };
  const stmts = [];
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
    if (next.health) summary[next.health]++;
    else summary.unchecked++;
    if (r.ok === null) summary.inconclusive.push({ url: r.url, reason: r.reason });
    if (r.moved) summary.moved.push({ url: r.url, to: r.finalUrl, hijack: r.hijack });
    if (r.signals?.needsReview) summary.needsReview.push({ url: r.url, score: r.signals.score });
    if (next.health === "down" && prev?.health !== "down") summary.newlyDown.push({ url: r.url, reason: next.reason });
    if (next.health === "live" && (prev?.health === "suspect" || prev?.health === "down")) summary.recovered++;
    // A passing site whose last capture failed gets recaptured on the next sync.
    const retryNow = r.ok === true && row && String(row.status) !== "live";
    // Signals only from a page that loaded; otherwise the last ones stay.
    const signals = r.signals ? JSON.stringify({ ...r.signals, checked_at: stamp }) : null;
    stmts.push({
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
                                  ELSE excluded.needs_review END
              ${retryNow ? ", retry_at = excluded.health_checked_at" : ""}`,
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
        r.signals?.needsReview ? 1 : 0,
      ],
    });
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200), "write");
  return { aborted: false, checked: results.length, ...summary };
}

const cell = (s) => String(s ?? "").replace(/\|/g, "/");

/** Markdown summary for GITHUB_STEP_SUMMARY. */
export function healthSummary(s) {
  if (s.aborted) return `## Health check\n\nFAILED: ${s.message}.\n`;
  const lines = [
    "## Health check",
    "",
    `Checked ${s.checked} listed site(s): ${s.live} live, ${s.suspect} suspect, ${s.down} down, ${s.recovered} recovered, ${s.inconclusive.length} inconclusive (bot checks), ${s.needsReview.length} need review.`,
    "",
    `A site is confirmed down after ${FAILS_TO_DOWN} failed checks in a row spanning at least ${DOWN_AFTER_DAYS} days; a bot check leaves its state unchanged.`,
    "",
  ];
  if (s.newlyDown.length) {
    lines.push("### Newly down", "", "| URL | Reason |", "| --- | --- |");
    for (const d of s.newlyDown) lines.push(`| ${cell(d.url)} | ${cell(d.reason)} |`);
    lines.push("");
  }
  if (s.needsReview.length) {
    lines.push(
      "### Needs review (looks little like a portfolio)",
      "",
      "Not removed or hidden: these go first in the grading queue so the AI's is_portfolio confirms or clears them.",
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
