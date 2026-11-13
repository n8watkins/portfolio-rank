// The owner's goals (lib/goals/config.mjs, pipeline/goals.mjs): the weekly
// check on a fake clock measures last week, records progress, emails the
// owner once with a calendar invite when a goal is first reached, never
// again after, and a dry run writes and sends nothing. Kit (the newsletter's
// subscriber count) is mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { GOALS } from "../lib/goals/config.mjs";
import { buildIcs, checkGoals, decisionSlot, finishedWeek, goalsHistory, kitConfirmed } from "../pipeline/goals.mjs";
import { createEmailGate, emailTransport } from "../lib/email/gate.mjs";
import { emailSender } from "../pipeline/alerts.mjs";

// Monday 2026-11-16, 08:00 Pacific (16:00 UTC): the weekly cron.
const MONDAY = new Date("2026-11-16T16:00:00Z");

async function freshDb() {
  const db = createClient({ url: `file:${path.join(fs.mkdtempSync(path.join(os.tmpdir(), "goals-")), "db.sqlite")}` });
  await migrate(db);
  return db;
}

/** Kit's API, mocked: answers the confirmed count (`count`, changeable) or fails while `down`. */
function mockKit(count) {
  const k = {
    count,
    down: false,
    calls: [],
    kitApiKey: "test-kit-key",
    kitApi: "https://kit.test/v4",
    fetch: async (url, init) => {
      k.calls.push({ url: String(url), key: init.headers["X-Kit-Api-Key"] });
      if (k.down) return new Response(JSON.stringify({ errors: ["down"] }), { status: 503 });
      return new Response(JSON.stringify({ subscribers: [], pagination: { has_next_page: false, total_count: k.count } }), { status: 200 });
    },
  };
  return k;
}

/** `n` graded portfolios, plus some judged "not a portfolio" and some delisted, in one statement each. */
async function graded(db, n, { notPortfolio = 0, delisted = 0 } = {}) {
  const add = (count, prefix, rubric, delistedAt) =>
    db.execute({
      sql: `WITH RECURSIVE i(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM i WHERE k + 1 < ?)
            INSERT INTO portfolios (url, status, ai_rubric, delisted_at) SELECT 'https://' || ? || k || '.dev/', 'live', ?, ? FROM i`,
      args: [count, prefix, rubric, delistedAt],
    });
  if (n) await add(n, "graded-", JSON.stringify({ tier: "B", is_portfolio: true }), null);
  if (notPortfolio) await add(notPortfolio, "notp-", JSON.stringify({ tier: "C", is_portfolio: false }), null);
  if (delisted) await add(delisted, "gone-", JSON.stringify({ tier: "B", is_portfolio: true }), "2026-11-01");
}

function owner() {
  const sent = [];
  return { sent, email: { send: async (m) => void sent.push(m) } };
}

const ctx = (db, o, extra = {}) => ({ db, email: o.email, to: "owner@example.com", siteUrl: "https://portfoliorank.dev", ...extra });
const byId = (r, id) => r.goals.find((g) => g.id === id);

test("the first goals: the newsletter at 100 confirmed in Kit, the library milestone at 5,000 graded", () => {
  assert.deepEqual(
    GOALS.map((g) => [g.id, g.conditions.map((c) => [c.metric, c.atLeast])]),
    [
      ["newsletter-100-subscribers", [["newsletter_confirmed", 100]]],
      ["library-5000-graded", [["graded_portfolios", 5000]]],
    ]
  );
  for (const g of GOALS) assert.equal(g.meeting.minutes, 30);
});

test("the finished week runs Monday to Monday, Pacific, across DST", () => {
  assert.deepEqual(
    { ...finishedWeek(MONDAY), start: finishedWeek(MONDAY).start.toISOString(), end: finishedWeek(MONDAY).end.toISOString() },
    { week: "2026-11-09", start: "2026-11-09T08:00:00.000Z", end: "2026-11-16T08:00:00.000Z" }
  );
  // Monday 2026-11-02 08:00 Pacific: the week before held the switch back to standard time (Nov 1).
  const w = finishedWeek(new Date("2026-11-02T16:00:00Z"));
  assert.equal(w.week, "2026-10-26");
  assert.equal(w.start.toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(w.end.toISOString(), "2026-11-02T08:00:00.000Z");
  // A Sunday night still belongs to the week that is running.
  assert.equal(finishedWeek(new Date("2026-11-16T07:30:00Z")).week, "2026-11-02");
});

test("the decision slot is 3 days later at 10:00 Pacific, moved off weekends", () => {
  const s = decisionSlot(MONDAY);
  assert.equal(s.start.toISOString(), "2026-11-19T18:00:00.000Z"); // Thursday 10:00 PST
  assert.equal(s.end.getTime() - s.start.getTime(), 30 * 60000);
  // From a Thursday, 3 days later is Sunday: Monday instead.
  assert.equal(decisionSlot(new Date("2026-11-19T16:00:00Z")).start.toISOString(), "2026-11-23T18:00:00.000Z");
  // Daylight time: 10:00 PDT is 17:00 UTC.
  assert.equal(decisionSlot(new Date("2026-07-06T16:00:00Z")).start.toISOString(), "2026-07-09T17:00:00.000Z");
});

test("below every target: progress is recorded, nothing is sent", async () => {
  const db = await freshDb();
  const kit = mockKit(99);
  await graded(db, 10, { notPortfolio: 3, delisted: 2 });
  const o = owner();
  const r = await checkGoals(ctx(db, o, kit), { now: MONDAY });
  assert.equal(r.week, "2026-11-09");
  assert.deepEqual(byId(r, "newsletter-100-subscribers").conditions[0].values, [99]);
  assert.deepEqual(byId(r, "library-5000-graded").conditions[0].values, [10], "not a portfolio and delisted sites don't count");
  assert.equal(o.sent.length, 0);
  assert.deepEqual(kit.calls, [{ url: "https://kit.test/v4/subscribers?status=active&include_total_count=true&per_page=1", key: "test-kit-key" }]);
  const history = await goalsHistory(db);
  assert.deepEqual(history.find((h) => h.id === "newsletter-100-subscribers").history.map((h) => [h.week, h.metrics, h.reached]), [["2026-11-09", { newsletter_confirmed: 99 }, false]]);
  assert.equal(history.find((h) => h.id === "newsletter-100-subscribers").event, null);
});

test("Kit's count: asked at most once a day, the last count when Kit is down, unknown without a key", async () => {
  const db = await freshDb();
  const kit = mockKit(12);
  const t = Date.now();
  assert.equal(await kitConfirmed({ db, ...kit }, { now: t }), 12);
  kit.count = 13;
  assert.equal(await kitConfirmed({ db, ...kit }, { now: t + 3600000 }), 12, "cached for the day");
  assert.equal(kit.calls.length, 1);
  assert.equal(await kitConfirmed({ db, ...kit }, { now: t + 86400000 }), 13, "asked again after a day");
  kit.down = true;
  assert.equal(await kitConfirmed({ db, ...kit }, { now: t + 2 * 86400000 }), 13, "Kit down: the last count");
  assert.equal(await kitConfirmed({ db: await freshDb(), ...kit }), null, "down with nothing cached: unknown");
  assert.equal(await kitConfirmed({ db, ...kit, kitApiKey: null }), null, "no key: unknown");
  // The app's admin pages share the row: { count } under kit:confirmed.
  assert.deepEqual(JSON.parse(String((await db.execute("SELECT v FROM cache WHERE k = 'kit:confirmed'")).rows[0].v)), { count: 13 });
  // Unknown is never "reached".
  const r = await checkGoals(ctx(await freshDb(), owner()), { now: MONDAY, dryRun: true });
  assert.deepEqual(byId(r, "newsletter-100-subscribers").conditions[0].values, [null]);
  assert.equal(byId(r, "newsletter-100-subscribers").reached, false);
});

test("reaching a goal emails once with a 30-minute invite; later weeks never email again", async () => {
  const db = await freshDb();
  const kit = mockKit(101);
  const o = owner();
  const r = await checkGoals(ctx(db, o, kit), { now: MONDAY });
  const g = byId(r, "newsletter-100-subscribers");
  assert.equal(g.reached, true);
  assert.equal(g.fired, true);
  assert.equal(byId(r, "library-5000-graded").fired, false);
  assert.equal(o.sent.length, 1);
  const m = o.sent[0];
  assert.equal(m.to, "owner@example.com");
  assert.equal(m.subject, "Goal reached: Newsletter: 100 subscribers");
  assert.match(m.text, /\[reached\] 100\+ confirmed newsletter subscribers \(Kit\): 101/);
  assert.match(m.text, /Thursday, November 19/);
  assert.equal(m.attachments.length, 1);
  const [ics] = m.attachments;
  assert.equal(ics.filename, "newsletter-100-subscribers.ics");
  assert.match(ics.type, /^text\/calendar/);
  assert.match(ics.content, /\r\nDTSTART:20261119T180000Z\r\n/);
  assert.match(ics.content, /\r\nDTEND:20261119T183000Z\r\n/);
  assert.match(ics.content, /\r\nSUMMARY:Decide: the newsletter at 100 subscribers\r\n/);
  assert.match(ics.content, /\r\nUID:goal-newsletter-100-subscribers@portfoliorank\r\n/);
  assert.ok(ics.content.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75), "lines are folded at 75 octets");

  // Next Monday, and a month later: still reached, never emailed again.
  for (const days of [7, 35]) {
    const later = await checkGoals(ctx(db, o, kit), { now: new Date(MONDAY.getTime() + days * 86400000) });
    assert.equal(byId(later, "newsletter-100-subscribers").fired, false);
    assert.ok(byId(later, "newsletter-100-subscribers").notifiedAt);
  }
  assert.equal(o.sent.length, 1);
  const event = (await goalsHistory(db)).find((h) => h.id === "newsletter-100-subscribers").event;
  assert.equal(event.week, "2026-11-09");
  assert.deepEqual(event.met, ["100+ confirmed newsletter subscribers (Kit)"]);
  assert.equal(event.slotStart, "2026-11-19T18:00:00.000Z");
  assert.ok(event.notifiedAt);
});

test("a goal that fired stays fired even if the number drops back", async () => {
  const db = await freshDb();
  const kit = mockKit(100);
  const o = owner();
  await checkGoals(ctx(db, o, kit), { now: MONDAY });
  kit.count = 10;
  await db.execute("DELETE FROM cache WHERE k = 'kit:confirmed'");
  await checkGoals(ctx(db, o, kit), { now: new Date(MONDAY.getTime() + 7 * 86400000) });
  kit.count = 105;
  await db.execute("DELETE FROM cache WHERE k = 'kit:confirmed'");
  await checkGoals(ctx(db, o, kit), { now: new Date(MONDAY.getTime() + 14 * 86400000) });
  assert.equal(o.sent.length, 1);
});

test("an email that couldn't go out is tried again next week, then never again", async () => {
  const db = await freshDb();
  await graded(db, 5000);
  const r1 = await checkGoals(ctx(db, { email: null }, { email: null }), { now: MONDAY });
  assert.equal(byId(r1, "library-5000-graded").fired, false);
  assert.match(byId(r1, "library-5000-graded").error, /owner alerts are off/);
  let failing = true;
  const o = owner();
  const flaky = { send: async (m) => (failing ? Promise.reject(new Error("owner alert email not sent (cap:kind)")) : o.email.send(m)) };
  const r2 = await checkGoals(ctx(db, { email: flaky }), { now: new Date(MONDAY.getTime() + 7 * 86400000) });
  assert.match(byId(r2, "library-5000-graded").error, /cap:kind/);
  assert.equal((await goalsHistory(db)).find((h) => h.id === "library-5000-graded").event.lastError, "owner alert email not sent (cap:kind)");
  failing = false;
  const r3 = await checkGoals(ctx(db, { email: flaky }), { now: new Date(MONDAY.getTime() + 14 * 86400000) });
  assert.equal(byId(r3, "library-5000-graded").fired, true);
  // The email reports the week it was reached.
  assert.match(o.sent[0].text, /Week of 2026-11-09/);
  await checkGoals(ctx(db, { email: flaky }), { now: new Date(MONDAY.getTime() + 21 * 86400000) });
  assert.equal(o.sent.length, 1);
});

test("a dry run shows the email it would send and writes nothing", async () => {
  const db = await freshDb();
  await graded(db, 5001);
  const o = owner();
  const r = await checkGoals(ctx(db, o), { now: MONDAY, dryRun: true });
  const g = byId(r, "library-5000-graded");
  assert.equal(g.wouldFire, true);
  assert.equal(g.fired, false);
  assert.equal(g.email.subject, "Goal reached: Library: 5,000 graded portfolios");
  assert.match(g.email.text, /5,000\+ graded portfolios in the library: 5,001/);
  assert.match(g.email.attachments[0].content, /BEGIN:VCALENDAR/);
  assert.equal(o.sent.length, 0);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM goal_progress")).rows[0].n), 0);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM goal_events")).rows[0].n), 0);
});

test("the invite goes through the owner-alert path: the email gate counts it, and Email Service gets a base64 .ics", async () => {
  const db = await freshDb();
  const kit = mockKit(100);
  const calls = [];
  const env = { OWNER_EMAIL: "owner@example.com", EMAIL_FROM: "portfoliorank@n8builds.dev", AUTH_SECRET: "test", SEND_EMAIL: { send: async (m) => void calls.push(m) } };
  const r = await checkGoals({ db, email: emailSender(env, { db }), to: env.OWNER_EMAIL, siteUrl: "https://portfoliorank.dev", ...kit }, { now: MONDAY });
  assert.equal(byId(r, "newsletter-100-subscribers").fired, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].from, { email: "portfoliorank@n8builds.dev", name: "PortfolioRank" });
  const [a] = calls[0].attachments;
  assert.equal(a.disposition, "attachment");
  assert.match(Buffer.from(a.content, "base64").toString("utf8"), /^BEGIN:VCALENDAR\r\n/);
  const sends = (await db.execute("SELECT kind, status FROM email_sends")).rows.map((x) => [x.kind, x.status]);
  assert.deepEqual(sends, [["owner-alert", "sent"]]);
  // The test outbox lists the attachment after the text.
  const outbox = emailTransport({ EMAIL_TRANSPORT: "outbox", SITE_ENV: "test" }, { db });
  await createEmailGate({ db, transport: outbox, secret: "test" }).send({ kind: "owner-alert", to: "o2@example.com", subject: "s", text: "t", attachments: [{ filename: "x.ics", type: "text/calendar", disposition: "attachment", content: "BEGIN:VCALENDAR" }] });
  assert.match(String((await db.execute("SELECT text FROM email_outbox")).rows[0].text), /--- attachment x\.ics \(text\/calendar\) ---\nBEGIN:VCALENDAR/);
});

test("text in the invite is escaped and long lines fold", () => {
  const ics = buildIcs({ uid: "u@x", start: MONDAY, end: MONDAY, summary: "A; b, c", description: "x".repeat(200) + "\nnext", now: MONDAY });
  assert.match(ics, /SUMMARY:A\\; b\\, c\r\n/);
  assert.match(ics, /\r\n x/);
  assert.match(ics.replace(/\r\n /g, ""), /DESCRIPTION:x{200}\\nnext\r\n/);
});
