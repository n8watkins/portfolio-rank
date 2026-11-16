// A capture that does not show the site (pipeline/capture-blocked.mjs) is
// never graded and never sent to the owner: the decision for each reason, a
// real short portfolio that is not blocked, and what the weekly health check
// (pipeline/health.mjs) and the exclusions (pipeline/exclusions.mjs) then do
// with a site whose capture has only ever been blocked. No network: fetch is
// a stand-in, the database a throwaway local file.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { BLOCKED_PREFIX, BLOCK_MAX_WORDS, BOT_CHECK_MAX_WORDS, capturedBlocked, isBlockedReason } from "../pipeline/capture-blocked.mjs";
import { DOWN_AFTER_DAYS, FAILS_TO_DOWN, runHealthCheck } from "../pipeline/health.mjs";
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
    [{ text: "Vercel Security Checkpoint We're verifying your browser", title: "Vercel Security Checkpoint" }, "a bot or security check stood in for the site"],
    [{ text: "example.dev Verifying you are human. This may take a few seconds. example.dev needs to review the security of your connection before proceeding.", outboundLinks: 1 }, "a bot or security check stood in for the site"],
    [{ text: "", title: "Just a moment...", outboundLinks: 1 }, "a bot or security check stood in for the site"],
    [{ text: "CLICK TO ENTER", outboundLinks: 1 }, "still a gate or loader after the click-through"],
    [{ text: "Loading 72%", outboundLinks: 1 }, "still a gate or loader after the click-through"],
    [{ text: PORTFOLIO, splash: { passed: false, password: true } }, "still a gate or loader after the click-through"],
    [{ text: "How would you like to see this site? Recruiter Developer", outboundLinks: 1, mode: { passed: false, picked: "Recruiter" } }, "still a mode picker after the click"],
    [{ text: PORTFOLIO, outboundLinks: 3, modal: { passed: false, kind: "dialog" } }, "still a dialog on top after the click"],
    [{ text: words(12), outboundLinks: 0 }, "12 words and no outbound links"],
    [{ text: "", outboundLinks: 0 }, "0 words and no outbound links"],
  ];
  for (const [input, want] of cases) assert.equal(capturedBlocked(input), want, JSON.stringify(input));
});

test("capturedBlocked: a long portfolio that jokes about robots is not a bot check", () => {
  const text = `${words(BOT_CHECK_MAX_WORDS)} I promise I'm not a robot.`;
  assert.equal(capturedBlocked({ text, outboundLinks: 2 }), null);
});

test("isBlockedReason reads the stored failure reason", () => {
  assert.equal(isBlockedReason(`${BLOCKED_PREFIX}12 words and no outbound links`), true);
  assert.equal(isBlockedReason("renders blank"), false);
  assert.equal(isBlockedReason(null), false);
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
const GOOD_WALLED = "https://good-walled.example";
const RECOVERED = "https://recovered.example";
const feed = [
  { name: "Empty Person", url: EMPTY },
  { name: "Walled Person", url: WALLED },
  { name: "Good Walled", url: GOOD_WALLED },
  { name: "Recovered Person", url: RECOVERED },
];
// A plain fetch sees the empty site and the recovered one as up; the bot wall answers 403.
const fetchImpl = fakeFetch({
  [EMPTY]: { status: 200, body: "<html><body><p>Hello there, welcome to my new website, coming along soon</p></body></html>" },
  [WALLED]: { status: 403, body: "<title>Just a moment...</title>" },
  [GOOD_WALLED]: { status: 403, body: "<title>Just a moment...</title>" },
  [RECOVERED]: { status: 200, body: "<html><body><p>Hello there, welcome to my new website, coming along soon</p></body></html>" },
});

async function seed(db) {
  await ensureRosterSchema(db);
  const retry = "2026-11-12T00:00:00.000Z";
  await db.batch(
    [
      // Never had a good capture; the last one was blocked (pipeline/capture.mjs recordCaptureFailure).
      { sql: "INSERT INTO portfolios (url, name, status, reason, capture_attempts, retry_at) VALUES (?, ?, 'error', ?, 1, ?)", args: [EMPTY, "Empty Person", `${BLOCKED_PREFIX}9 words and no outbound links`, retry] },
      { sql: "INSERT INTO portfolios (url, name, status, reason, capture_attempts, retry_at) VALUES (?, ?, 'error', ?, 1, ?)", args: [WALLED, "Walled Person", `${BLOCKED_PREFIX}a bot or security check stood in for the site`, retry] },
      // Has a good capture: a bot wall says nothing about it.
      { sql: "INSERT INTO portfolios (url, name, status, reason, shot_key, health) VALUES (?, ?, 'live', '', 'k1', 'live')", args: [GOOD_WALLED, "Good Walled"] },
      // Was blocked once, then captured fine: status live again.
      { sql: "INSERT INTO portfolios (url, name, status, reason, shot_key) VALUES (?, ?, 'live', '', 'k2')", args: [RECOVERED, "Recovered Person"] },
    ],
    "write"
  );
}

const rowOf = async (db, url) =>
  (await db.execute({ sql: `SELECT status, reason, health, health_reason, retry_at, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, args: [url] })).rows[0];

test("health check: a never-captured site whose capture was blocked fails, stays hidden and keeps its capture backoff", async () => {
  const db = tempDb();
  await seed(db);
  const s = await runHealthCheck({ db, feed, fetchImpl, now: new Date("2026-11-11T00:00:00Z"), log: () => {} });
  assert.equal(s.aborted, false);

  const empty = await rowOf(db, EMPTY);
  assert.equal(empty.health, "suspect", "the plain fetch saw it up; the blocked capture decides");
  assert.match(String(empty.health_reason), /^capture blocked: 9 words/);
  assert.equal(Number(empty.hidden), 1, "not shown on the site");
  assert.equal(empty.retry_at, "2026-11-12T00:00:00.000Z", "the retry is not pulled forward: the backoff stands");

  const walled = await rowOf(db, WALLED);
  assert.equal(walled.health, "suspect", "a bot wall is no longer inconclusive for a site we never saw");
  assert.match(String(walled.health_reason), /bot or security check/);
  assert.equal(Number(walled.hidden), 1);

  const good = await rowOf(db, GOOD_WALLED);
  assert.equal(good.health, "live", "a site with a good capture behind a bot wall keeps its state");
  assert.equal(Number(good.hidden), 0);
  assert.ok(s.inconclusive.some((i) => i.url === GOOD_WALLED));

  const recovered = await rowOf(db, RECOVERED);
  assert.equal(recovered.health, "live");
});

test("health check: a site that stays blocked is confirmed down and excluded as broken, never as not a portfolio", async () => {
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
  // Weekly checks: FAILS_TO_DOWN of them spanning at least DOWN_AFTER_DAYS.
  for (let i = 0; i < FAILS_TO_DOWN; i++) {
    await runHealthCheck({ db, feed: all, fetchImpl: fetchAll, now: new Date(start + i * Math.ceil(DOWN_AFTER_DAYS / (FAILS_TO_DOWN - 1)) * DAY), log: () => {} });
  }
  assert.equal((await rowOf(db, EMPTY)).health, "down");
  assert.equal((await rowOf(db, WALLED)).health, "down");
  assert.equal((await rowOf(db, GOOD_WALLED)).health, "live");

  const plan = await planExclusions({ db, excluded: [], feed: all, now: new Date(start + 20 * DAY) });
  const byUrl = Object.fromEntries(plan.added.map((a) => [a.url, a]));
  assert.deepEqual(Object.keys(byUrl).sort(), [EMPTY, WALLED].sort());
  for (const url of [EMPTY, WALLED]) {
    assert.equal(byUrl[url].kind, "down", "broken, not not_portfolio");
    assert.match(byUrl[url].reason, /^capture blocked: /);
  }
  assert.ok(!plan.feed.some((p) => p.url === EMPTY || p.url === WALLED));
  assert.ok(plan.feed.some((p) => p.url === GOOD_WALLED) && plan.feed.some((p) => p.url === RECOVERED));
});
