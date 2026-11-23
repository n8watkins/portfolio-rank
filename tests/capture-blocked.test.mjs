// A capture that does not show the site (pipeline/capture-blocked.mjs) is
// never graded: the decision for each reason, a real short portfolio that is
// not blocked, and what the weekly health check (pipeline/health.mjs) and the
// exclusions (pipeline/exclusions.mjs) then do with a site whose capture has
// only ever been blocked: a blank or gated one ends as broken, a bot-walled
// one is never failed and keeps its needs_review mark for the owner. No
// network: fetch is a stand-in, the database a throwaway local file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  BLOCKED_PREFIX,
  BLOCK_MAX_WORDS,
  BOT_CHECK_MAX_WORDS,
  BOT_WALL,
  BOT_WALL_REASON,
  MEDIA_ONLY,
  OWNER_REVIEW_PREFIX,
  SHOWS_SITE_REASON,
  capturedBlocked,
  httpVerdict,
  isBlockedReason,
  isBotWallPage,
  isBotWallReason,
  readBlockedInputs,
} from "../pipeline/capture-blocked.mjs";
import { runHealthCheck } from "../pipeline/health.mjs";
import { planExclusions } from "../pipeline/exclusions.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";

const DAY = 86400000;
const words = (n, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}`).join(" ");
const PORTFOLIO = `Jane Doe Backend engineer. ${words(60)}`;

test("capturedBlocked: a page that shows the site is not blocked", () => {
  assert.equal(capturedBlocked({ text: PORTFOLIO, outboundLinks: 3 }), null);
  assert.equal(capturedBlocked({ text: PORTFOLIO, outboundLinks: 0 }), null, "plenty of words need no links");
  // Passes that got through, and ones that never ran, change nothing.
  assert.equal(capturedBlocked({ text: PORTFOLIO, splash: { passed: true }, modal: { passed: true }, mode: { passed: true } }), null);
});

test("capturedBlocked: a minimalist one-screen portfolio with a few links is not blocked", () => {
  // Under BLOCK_MAX_WORDS words, but it links out: a real, short page.
  const text = "Jane Doe\nDesigner and engineer in Lisbon.\nWork\nAbout\nGitHub\nLinkedIn\nEmail";
  assert.ok(text.split(/\s+/).length < BLOCK_MAX_WORDS);
  assert.equal(capturedBlocked({ text, title: "Jane Doe", outboundLinks: 2 }), null);
  // A short page with "Start" in a sentence is not a gate either.
  assert.equal(capturedBlocked({ text: "Hi, I'm Jane, a designer in Lisbon. Start a project with me today please", outboundLinks: 1 }), null);
});

test("capturedBlocked: each reason", () => {
  const cases = [
    [{ text: "Vercel Security Checkpoint We're verifying your browser", title: "Vercel Security Checkpoint" }, BOT_WALL],
    [{ text: "example.dev Verifying you are human. This may take a few seconds. example.dev needs to review the security of your connection before proceeding.", outboundLinks: 1 }, BOT_WALL],
    [{ text: "", title: "Just a moment...", outboundLinks: 1 }, BOT_WALL],
    [{ text: "CLICK TO ENTER", outboundLinks: 1 }, "still a gate or loader after the click-through"],
    [{ text: "Loading 72%", outboundLinks: 1 }, "still a gate or loader after the click-through"],
    [{ text: PORTFOLIO, splash: { passed: false, password: true } }, "still a gate or loader after the click-through"],
    [{ text: "How would you like to see this site? Recruiter Developer", outboundLinks: 1, mode: { passed: false, picked: "Recruiter" } }, "still a mode picker after the click"],
    [{ text: PORTFOLIO, outboundLinks: 3, modal: { passed: false, kind: "dialog" } }, "still a dialog on top after the click"],
    [{ text: words(12), outboundLinks: 0 }, "12 words and no outbound links"],
    [{ text: "", outboundLinks: 0 }, "0 words and no outbound links"],
  ];
  for (const [input, want] of cases) assert.equal(capturedBlocked(input), want, JSON.stringify(input));
  assert.equal(BOT_WALL, "a bot or security check stood in for the site");
});

test("capturedBlocked: a long portfolio that jokes about robots is not a bot check", () => {
  const text = `${words(BOT_CHECK_MAX_WORDS)} I promise I'm not a robot.`;
  assert.equal(capturedBlocked({ text, outboundLinks: 2 }), null);
});

test("capturedBlocked: what besides words shows a site", () => {
  // A canvas or video filling the screen with no DOM text or links: a canvas site or a stuck preloader,
  // which the capture never stores as live on its own (MEDIA_ONLY: blank frame or owner review).
  assert.equal(capturedBlocked({ text: "", outboundLinks: 0, mediaCover: 1 }), MEDIA_ONLY);
  assert.equal(capturedBlocked({ text: "Coming soon", mediaCover: 0.8 }), MEDIA_ONLY, "an image-only coming-soon page");
  assert.equal(capturedBlocked({ text: "", outboundLinks: 0, mediaCover: 0.1 }), "0 words and no outbound links", "a small spinner or logo is not a site");
  // A short home page with its own navigation, or one page and a contact link.
  assert.equal(capturedBlocked({ text: words(17), siteLinks: 4, contactLinks: 1 }), null);
  assert.equal(capturedBlocked({ text: words(17), siteLinks: 1, contactLinks: 1 }), null);
  assert.equal(capturedBlocked({ text: words(10), siteLinks: 1 }), "10 words and no outbound links", "one link of its own is not enough");
  assert.equal(capturedBlocked({ text: words(10), contactLinks: 1 }), "10 words and no outbound links", "a coming-soon page with an email link is not a site");
  // A bare loading line is a loader, media or not.
  assert.equal(capturedBlocked({ text: "Loading...", mediaCover: 1 }), "still a gate or loader after the click-through");
});

test("capturedBlocked: a plain gate word counts only as an element's whole text", () => {
  const text = "Jane Doe\nDesigner. Let's start something.\nGitHub LinkedIn";
  assert.equal(capturedBlocked({ text, outboundLinks: 2 }), null, "start in a sentence");
  assert.equal(capturedBlocked({ text, outboundLinks: 2, gateElement: false }), null);
  assert.equal(capturedBlocked({ text: "Jane Doe\nStart", outboundLinks: 1 }), "still a gate or loader after the click-through", "start on a line of its own");
  assert.equal(capturedBlocked({ text: "Jane Doe Start", outboundLinks: 1, gateElement: true }), "still a gate or loader after the click-through", "the page said it is a button");
  // A loader at 100% next to the word is still a loader.
  assert.equal(capturedBlocked({ text: "Jane Doe. Loading experience 100% Enter", outboundLinks: 3 }), "still a gate or loader after the click-through");
});

test("capturedBlocked: 'not a robot' is a bot check only on a nearly empty page that asks for it", () => {
  assert.equal(capturedBlocked({ text: "Hi, I'm Sam. Developer, climber, definitely not a robot. GitHub LinkedIn Email", outboundLinks: 2 }), null);
  assert.equal(capturedBlocked({ text: `${words(60)} Please confirm you are not a robot.`, outboundLinks: 2 }), null, "a long page");
  assert.equal(capturedBlocked({ text: "One more step. Please verify you are not a robot to continue.", outboundLinks: 1 }), BOT_WALL);
  assert.equal(capturedBlocked({ text: "Are you a robot? Complete the reCAPTCHA below.", outboundLinks: 1 }), BOT_WALL);
  assert.equal(capturedBlocked({ text: words(80), title: "Are you a robot?", outboundLinks: 1 }), BOT_WALL, "in the title");
});

test("isBotWallPage: rule 1 on its own, for callers that ask only 'is this a bot wall'", () => {
  assert.equal(isBotWallPage({ text: "", title: "Just a moment..." }), true);
  assert.equal(isBotWallPage({ text: "Verifying you are human. This may take a few seconds." }), true);
  assert.equal(isBotWallPage({ text: PORTFOLIO }), false);
  // A gate or an empty page is blocked, but not a bot wall.
  assert.equal(isBotWallPage({ text: "CLICK TO ENTER" }), false);
  assert.equal(isBotWallPage({ text: "" }), false);
});

test("isBotWallPage: a longer interstitial with a challenge form and no navigation is a wall", () => {
  const waf =
    "Enter the characters you see below. Sorry, we just need to make sure you're not a robot. For best results, please make sure your browser is accepting cookies. " +
    "Type the characters you see in this image: Try different image Continue shopping Conditions of Use Privacy Policy © 1996-2026, Example.com, Inc. or its affiliates";
  assert.ok(waf.split(/\s+/).length > BLOCK_MAX_WORDS);
  assert.equal(isBotWallPage({ text: waf, siteLinks: 2, challenge: true }), true);
  assert.equal(capturedBlocked({ text: waf, siteLinks: 2, challenge: true, outboundLinks: 0 }), BOT_WALL);
  // The same words on a site with navigation, or with no challenge on screen, are not taken for a wall.
  assert.equal(isBotWallPage({ text: waf, siteLinks: 5, challenge: true }), false);
  assert.equal(isBotWallPage({ text: waf, siteLinks: 0, challenge: false }), false);
});

test("isBotWallPage: the reCAPTCHA notice and a joking title are not a wall", () => {
  const notice = "Ana Ruiz Product designer in Madrid. GitHub LinkedIn This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.";
  assert.equal(isBotWallPage({ text: notice }), false);
  assert.equal(capturedBlocked({ text: notice, outboundLinks: 2 }), null);
  assert.equal(isBotWallPage({ text: words(2000), title: "Jane Doe - I'm not a robot" }), false, "a long site");
  assert.equal(isBotWallPage({ text: words(2000), title: "Are you a robot?" }), false, "a title counts only on a short page");
  assert.equal(isBotWallPage({ text: words(30), title: "Jane Doe - I'm not a robot" }), false);
  // A short page that asks for the captcha is still one.
  assert.equal(isBotWallPage({ text: "Please complete the CAPTCHA below to continue." }), true);
});

test("readBlockedInputs: a page that cannot be read falls back to the text read before, never to an empty page", async () => {
  const failing = { evaluate: async () => Promise.reject(new Error("Execution context was destroyed")), title: async () => "Jane Doe" };
  const shown = await readBlockedInputs(failing, PORTFOLIO);
  assert.equal(shown.text, PORTFOLIO);
  assert.equal(capturedBlocked(shown), null);
  assert.equal("html" in shown, false, "the page's HTML is not carried along");
});

test("httpVerdict: the main document's status decides; an error page is never the site", () => {
  const site = { text: `Jane Doe ${words(200)}`, title: "Jane Doe", outboundLinks: 3 };
  assert.equal(httpVerdict({ status: 200, ...site }), null);
  assert.equal(httpVerdict({ status: 0, text: "" }), null, "no status known");
  assert.equal(httpVerdict({ status: 304, ...site }), null);
  // Bot walls: challenge wording, Cloudflare's challenge header, a firewall's 403.
  for (const doc of [
    { status: 403, text: "Verifying you are human. This may take a few seconds.", title: "Just a moment..." },
    { status: 503, text: "Checking your browser before accessing example.dev", title: "Just a moment..." },
    { status: 403, text: "", cfMitigated: "challenge" },
    { status: 403, text: "Error 1020 Access denied. This website is using a security service to protect itself from online attacks. Ray ID: 8f2a", title: "Access denied" },
    { status: 429, text: "Verifying you are human.", title: "Just a moment..." },
  ]) {
    assert.deepEqual(httpVerdict(doc), { status: "error", reason: BOT_WALL_REASON, needsReview: true }, JSON.stringify(doc));
  }
  // Rate limits are retried, never reviewed (Cloudflare's 1015 page says "Access denied" in its title too).
  assert.deepEqual(httpVerdict({ status: 429, text: "Error 1015 You are being rate limited", title: "Access denied | example.dev" }), { status: "error", reason: "HTTP 429 (rate limited)", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 429, text: "" }), { status: "error", reason: "HTTP 429 (rate limited)", needsReview: false });
  // Errors are retried with backoff; 404 and 410 are dead, as in the plain pre-check.
  assert.deepEqual(httpVerdict({ status: 503, text: "Service Unavailable" }), { status: "error", reason: "HTTP 503", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 500, ...site }), { status: "error", reason: "HTTP 500", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 401, text: "Unauthorized" }), { status: "error", reason: "HTTP 401", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 403, text: "Forbidden" }), { status: "error", reason: "HTTP 403", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 404, ...site }), { status: "dead", reason: "HTTP 404", needsReview: false });
  // A 403 whose page shows a whole site: a browser sees it, its status says error. The owner looks,
  // under the owner-review prefix: it is not a bot wall, and not a blocked reason the health check fails.
  const odd = httpVerdict({ status: 403, ...site, shown: site });
  assert.deepEqual(odd, { status: "error", reason: `${SHOWS_SITE_REASON} (HTTP 403)`, needsReview: true });
  assert.ok(odd.reason.startsWith(OWNER_REVIEW_PREFIX));
  assert.equal(isBotWallReason(odd.reason), false);
  assert.equal(isBlockedReason(odd.reason), false);
  // Not without the evidence of what the page showed.
  assert.equal(httpVerdict({ status: 403, ...site }).needsReview, false);
  // A single-page app served from a copied 404.html after a hard navigation goes the same way.
  assert.deepEqual(httpVerdict({ status: 404, ...site, shown: site }), { status: "error", reason: `${SHOWS_SITE_REASON} (HTTP 404)`, needsReview: true });
  assert.deepEqual(httpVerdict({ status: 404, text: "Not Found", shown: { text: "Not Found" } }), { status: "dead", reason: "HTTP 404", needsReview: false });
});

test("httpVerdict: rate-limit wording decides only on a 429 or a short 403 or 503 page, as whole words", () => {
  const spa = { text: `Jane Doe. I built a rate limiter for the payments API. ${words(200)}`, title: "Jane Doe", outboundLinks: 2 };
  assert.deepEqual(httpVerdict({ status: 404, ...spa, shown: spa }), { status: "error", reason: `${SHOWS_SITE_REASON} (HTTP 404)`, needsReview: true });
  assert.deepEqual(httpVerdict({ status: 404, text: "Not found. We rate limited nothing." }), { status: "dead", reason: "HTTP 404", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 503, text: "Too many requests. Try again later." }), { status: "error", reason: "HTTP 503 (rate limited)", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 503, text: "A separate limited edition. Down for maintenance." }), { status: "error", reason: "HTTP 503", needsReview: false });
  assert.deepEqual(httpVerdict({ status: 500, text: "You are being rate limited" }), { status: "error", reason: "HTTP 500", needsReview: false });
});

test("isBotWallPage: a page with its own navigation or contact links is a site, captcha wording or not", () => {
  const form = "Jane Doe. Designer. Work About Contact. Write to me: complete the captcha below and press send.";
  assert.equal(isBotWallPage({ text: form, contactLinks: 1 }), false);
  assert.equal(isBotWallPage({ text: form, siteLinks: 3 }), false);
  assert.equal(isBotWallPage({ text: form }), true, "without either, a short captcha request is still a wall");
  // Challenge wording that only walls use still counts.
  assert.equal(isBotWallPage({ text: "Verifying you are human. This may take a few seconds.", contactLinks: 1 }), true);
});

test("isBlockedReason and isBotWallReason read the stored failure reason", () => {
  assert.equal(isBlockedReason(`${BLOCKED_PREFIX}12 words and no outbound links`), true);
  assert.equal(isBlockedReason(`${BLOCKED_PREFIX}${BOT_WALL}`), true);
  assert.equal(isBlockedReason("renders blank"), false);
  assert.equal(isBlockedReason(null), false);
  assert.equal(isBotWallReason(`${BLOCKED_PREFIX}${BOT_WALL}`), true);
  assert.equal(isBotWallReason(`${BLOCKED_PREFIX}12 words and no outbound links`), false);
  assert.equal(isBotWallReason(BOT_WALL), false, "only a capture failure's reason");
  assert.equal(isBotWallReason(null), false);
});

// --- The weekly health check and the exclusions -----------------------------

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocked-"));
  return createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
}

function fakeFetch(map) {
  return async (url) => {
    const r = map[url];
    if (!r) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return { status: r.status, ok: r.status >= 200 && r.status < 300, url, text: async () => r.body ?? "" };
  };
}

const EMPTY = "https://empty.example";
const WALLED = "https://walled.example";
const WALLED_OPEN = "https://walled-open.example";
const EMPTY_WALLED = "https://empty-walled.example";
const GOOD_WALLED = "https://good-walled.example";
const RECOVERED = "https://recovered.example";
const feed = [
  { name: "Empty Person", url: EMPTY },
  { name: "Walled Person", url: WALLED },
  { name: "Open Walled", url: WALLED_OPEN },
  { name: "Empty Walled", url: EMPTY_WALLED },
  { name: "Good Walled", url: GOOD_WALLED },
  { name: "Recovered Person", url: RECOVERED },
];
const SPARSE = "<html><body><p>Hello there, welcome to my new website, coming along soon</p></body></html>";
const WALL = { status: 403, body: "<title>Just a moment...</title>" };
const fetchImpl = fakeFetch({
  // The plain fetch sees the empty site as up.
  [EMPTY]: { status: 200, body: SPARSE },
  // The capture's browser met a bot wall; so does the health check.
  [WALLED]: WALL,
  // The capture's browser met a bot wall, but the plain fetch gets a page that
  // passes, with signals that would clear needs_review.
  [WALLED_OPEN]: { status: 200, body: "<html><head><title>Open Walled - Developer</title></head><body><h1>Open Walled</h1><p>Hi, I'm Open Walled. I build things for the web. <a href='https://github.com/x'>GitHub</a> Projects, resume, contact me.</p></body></html>" },
  // The capture saw an empty page; the health check meets a bot wall.
  [EMPTY_WALLED]: WALL,
  [GOOD_WALLED]: WALL,
  [RECOVERED]: { status: 200, body: SPARSE },
});

async function seed(db) {
  await ensureRosterSchema(db);
  const retry = "2026-11-12T00:00:00.000Z";
  const blocked = (url, name, why, needsReview = 0) => ({
    sql: "INSERT INTO portfolios (url, name, status, reason, capture_attempts, retry_at, needs_review) VALUES (?, ?, 'error', ?, 1, ?, ?)",
    args: [url, name, `${BLOCKED_PREFIX}${why}`, retry, needsReview],
  });
  await db.batch(
    [
      // Never had a good capture; the last one was blocked (pipeline/capture.mjs recordCaptureFailure).
      blocked(EMPTY, "Empty Person", "9 words and no outbound links"),
      blocked(WALLED, "Walled Person", BOT_WALL, 1),
      blocked(WALLED_OPEN, "Open Walled", BOT_WALL, 1),
      blocked(EMPTY_WALLED, "Empty Walled", "9 words and no outbound links"),
      // Has a good capture: a bot wall says nothing about it.
      { sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, health) VALUES (?, ?, 'live', '', 'k1', 'live')", args: [GOOD_WALLED, "Good Walled"] },
      // Was blocked once, then captured fine: status live again.
      { sql: "INSERT INTO portfolios (url, name, status, reason, shot_key) VALUES (?, ?, 'live', '', 'k2')", args: [RECOVERED, "Recovered Person"] },
    ],
    "write"
  );
}

const rowOf = async (db, url) =>
  (
    await db.execute({
      sql: `SELECT status, reason, health, health_reason, health_fails, retry_at, needs_review, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`,
      args: [url],
    })
  ).rows[0];

test("health check: a never-captured blank site fails, stays hidden and keeps its capture backoff", async () => {
  const db = tempDb();
  await seed(db);
  const s = await runHealthCheck({ db, feed, fetchImpl, now: new Date("2026-11-11T00:00:00Z"), log: () => {} });
  assert.equal(s.aborted, false);

  const empty = await rowOf(db, EMPTY);
  assert.equal(empty.health, "suspect", "the plain fetch saw it up; the blocked capture decides");
  assert.match(String(empty.health_reason), /^capture blocked: 9 words/);
  assert.equal(Number(empty.hidden), 1, "not shown on the site");
  assert.equal(empty.retry_at, "2026-11-12T00:00:00.000Z", "the retry is not pulled forward: the backoff stands");

  // A bot wall the health check meets itself stays inconclusive, whatever the capture saw.
  const emptyWalled = await rowOf(db, EMPTY_WALLED);
  assert.equal(emptyWalled.health, null);
  assert.equal(Number(emptyWalled.hidden), 1);

  const good = await rowOf(db, GOOD_WALLED);
  assert.equal(good.health, "live", "a site with a good capture behind a bot wall keeps its state");
  assert.equal(Number(good.hidden), 0);
  assert.ok(s.inconclusive.some((i) => i.url === GOOD_WALLED));

  assert.equal((await rowOf(db, RECOVERED)).health, "live");
});

test("health check: a bot-walled, never-captured site is never failed, stays hidden and keeps its needs_review mark", async () => {
  const db = tempDb();
  await seed(db);
  const start = Date.parse("2026-11-11T00:00:00Z");
  for (let i = 0; i < 4; i++) {
    const s = await runHealthCheck({ db, feed, fetchImpl, now: new Date(start + i * 7 * DAY), log: () => {} });
    for (const url of [WALLED, WALLED_OPEN]) assert.ok(s.inconclusive.some((x) => x.url === url), `${url} is inconclusive`);
  }
  for (const url of [WALLED, WALLED_OPEN]) {
    const row = await rowOf(db, url);
    assert.equal(row.health, null, "never suspect, never down");
    assert.equal(Number(row.health_fails), 0);
    assert.equal(Number(row.needs_review), 1, "the mark for the owner's review survives every weekly check");
    assert.equal(row.reason, `${BLOCKED_PREFIX}${BOT_WALL}`, "the capture's reason is kept");
    assert.equal(row.status, "error");
    assert.equal(Number(row.hidden), 1, "not shown on the site while uncaptured");
    assert.equal(row.retry_at, "2026-11-12T00:00:00.000Z", "retried on its own backoff");
  }
  // And it never reaches the exclusions (the blank site, down by now, is left out of this feed).
  const plan = await planExclusions({ db, excluded: [], feed: feed.filter((p) => p.url !== EMPTY), now: new Date(start + 40 * DAY) });
  assert.deepEqual(plan.added, []);
  // The plain fetch's own signals did not ask for review: only the capture's mark keeps it.
  const signals = JSON.parse(String((await db.execute({ sql: "SELECT signals FROM portfolios WHERE url = ?", args: [WALLED_OPEN] })).rows[0].signals));
  assert.equal(signals.needsReview, false);
});

test("health check: a blank site that stays blocked goes into the temporary pool and, after 90 days, the archive as broken, never as not a portfolio", async () => {
  const db = tempDb();
  await seed(db);
  // Healthy sites around them (the exclusions refuse to drop more than a tenth of the list at once).
  const others = Array.from({ length: 30 }, (_, i) => ({ name: `Other Person${i}`, url: `https://other${i}.example` }));
  const body = (name) => `<html><head><title>${name}</title></head><body><p>Hi, I'm ${name}. ${"I build things for the web. ".repeat(5)}</p></body></html>`;
  const all = [...feed, ...others];
  const fetchAll = async (url) => {
    const other = others.find((o) => o.url === url);
    return other ? { status: 200, ok: true, url, text: async () => body(other.name) } : fetchImpl(url);
  };
  const start = Date.parse("2026-11-11T00:00:00Z");
  const HOUR = 3600000;
  // The nightly run, then the ladder's re-checks of the site (the hourly job's own call): an hour later, the next day.
  await runHealthCheck({ db, feed: all, fetchImpl: fetchAll, now: new Date(start), log: () => {} });
  const recheck = (t) => runHealthCheck({ db, feed: [feed[0]], fetchImpl: fetchAll, now: new Date(t), scheduled: "check", alerts: false, doorLimit: 0, log: () => {} });
  await recheck(start + HOUR);
  assert.equal((await rowOf(db, EMPTY)).health, "suspect", "never hidden on the first day");
  await recheck(start + DAY);
  assert.equal((await rowOf(db, EMPTY)).health, "down", "in the temporary pool the next day");
  for (const url of [WALLED, WALLED_OPEN, EMPTY_WALLED]) assert.equal((await rowOf(db, url)).health, null, `${url} is not failed`);
  assert.equal((await rowOf(db, GOOD_WALLED)).health, "live");
  // Not archived before 90 days in the pool.
  assert.deepEqual((await planExclusions({ db, excluded: [], feed: all, now: new Date(start + 20 * DAY) })).added, []);
  // Its check on day 90 still fails: archived with the next weekly export.
  const day90 = start + DAY + 90 * DAY;
  await db.execute({ sql: "UPDATE health_marks SET pool_next_at = ? WHERE url = ?", args: [new Date(day90).toISOString(), EMPTY] });
  await recheck(day90);

  const plan = await planExclusions({ db, excluded: [], feed: all, now: new Date(day90) });
  assert.deepEqual(plan.added.map((a) => a.url), [EMPTY]);
  assert.equal(plan.added[0].kind, "down", "broken, not not_portfolio");
  assert.match(plan.added[0].reason, /^capture blocked: /);
  assert.ok(!plan.feed.some((p) => p.url === EMPTY));
  for (const url of [WALLED, WALLED_OPEN, EMPTY_WALLED, GOOD_WALLED, RECOVERED]) assert.ok(plan.feed.some((p) => p.url === url));
});
