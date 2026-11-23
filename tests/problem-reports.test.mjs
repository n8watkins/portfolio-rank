// Visitors' "Report a problem" notes (lib/problem-reports) on a throwaway
// database: the note's cleaning and limit, one open report per visitor and
// site, grouping for the admin, handling and reopening, and every step of
// POST /api/problem-reports's intake in order (validation, the network and
// visitor limits, the bot check, the known site, the per-site cap). A report
// never touches a site's grade, rating, tier or listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { rateLimit } from "../lib/polls/store.mjs";
import { NOTE_MAX, REASON_KEYS, cleanNote, cleanSiteUrl, listReports, markHandled, openCount, reopenReports, saveReport } from "../lib/problem-reports/store.mjs";
import { LIMITS, takeReport } from "../lib/problem-reports/intake.mjs";

const SITE = "https://e2e-reported.dev";
const OTHER = "https://other-reported.dev";
const T0 = Date.UTC(2026, 10, 23, 18);

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "problem-reports-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

/** The intake with the route's parts stood in: a passing bot check and both sites known, unless told otherwise. */
function intake(db, over = {}) {
  const calls = { verify: 0 };
  const run = (body, extra = {}) =>
    takeReport({
      db,
      body,
      visitor: "visitor-a",
      network: "net-a",
      verify: async () => {
        calls.verify++;
        return over.verify ?? "ok";
      },
      known: async (url) => (over.known ?? [SITE, OTHER]).includes(url),
      rateLimit: (key, opts) => rateLimit(db, key, opts),
      now: T0,
      ...extra,
    });
  return { run, calls };
}

const rows = async (db) => (await db.execute("SELECT * FROM problem_reports ORDER BY id")).rows;

test("cleanNote: plain text, folded, at most NOTE_MAX characters", () => {
  assert.deepEqual(cleanNote(undefined), { note: null });
  assert.deepEqual(cleanNote("   "), { note: null });
  assert.deepEqual(cleanNote(42), { error: "bad_note" });
  assert.deepEqual(cleanNote("  a\u0000b\t\tc  \r\n\n\n\nd "), { note: "a b c\n\nd" });
  // Direction overrides and zero-width characters can't disguise a note.
  assert.deepEqual(cleanNote("x‮y​z"), { note: "x y z" });
  assert.deepEqual(cleanNote("<script>alert(1)</script>"), { note: "<script>alert(1)</script>" }, "kept as text: the pages render it as text");
  assert.equal(cleanNote("é".repeat(NOTE_MAX)).note.length, NOTE_MAX);
  assert.deepEqual(cleanNote("a".repeat(NOTE_MAX + 1)), { error: "note_too_long" });
});

test("cleanSiteUrl: http(s) only, no credentials, bounded", () => {
  assert.equal(cleanSiteUrl(SITE), SITE);
  assert.equal(cleanSiteUrl("javascript:alert(1)"), null);
  assert.equal(cleanSiteUrl("https://user:pw@x.dev"), null);
  assert.equal(cleanSiteUrl("not a url"), null);
  assert.equal(cleanSiteUrl(`https://x.dev/${"a".repeat(2100)}`), null);
  assert.equal(cleanSiteUrl(null), null);
});

test("saveReport: one open report per visitor and site; a second send replaces it", async () => {
  const db = await freshDb();
  const a = await saveReport(db, { url: SITE, reason: "screenshot", note: "Cookie wall", reporter: "v1", now: new Date(T0) });
  const b = await saveReport(db, { url: SITE, reason: "measurement", note: null, reporter: "v1", now: new Date(T0 + 1000) });
  assert.equal(b.id, a.id);
  assert.equal(b.updated, true);
  const c = await saveReport(db, { url: SITE, reason: "gone", reporter: "v2", now: new Date(T0 + 2000) });
  assert.notEqual(c.id, a.id);
  const all = await rows(db);
  assert.equal(all.length, 2);
  assert.equal(all[0].reason, "measurement");
  assert.equal(all[0].note, null);
  await assert.rejects(saveReport(db, { url: SITE, reason: "nope", reporter: "v3" }));
});

test("listReports groups open reports by site with counts and reasons; handle and reopen", async () => {
  const db = await freshDb();
  await saveReport(db, { url: SITE, reason: "screenshot", note: "Shows a cookie banner", reporter: "v1", now: new Date(T0) });
  await saveReport(db, { url: SITE, reason: "screenshot", reporter: "v2", now: new Date(T0 + 60_000) });
  await saveReport(db, { url: SITE, reason: "not_portfolio", reporter: "v3", now: new Date(T0 + 120_000) });
  await saveReport(db, { url: OTHER, reason: "other", note: "Typo", reporter: "v1", now: new Date(T0 + 180_000) });

  let list = await listReports(db);
  assert.deepEqual(
    list.open.map((s) => [s.url, s.count]),
    [
      [SITE, 3],
      [OTHER, 1],
    ],
    "most reported first"
  );
  assert.deepEqual(
    list.open[0].reasons.map((r) => [r.key, r.count]),
    [
      ["screenshot", 2],
      ["not_portfolio", 1],
    ]
  );
  assert.equal(list.open[0].reasons[0].label, "The screenshot is wrong or broken");
  assert.equal(list.open[0].first, new Date(T0).toISOString());
  assert.equal(list.open[0].last, new Date(T0 + 120_000).toISOString());
  assert.equal(await openCount(db), 4);

  const ids = list.open[0].reports.map((r) => r.id);
  assert.equal(await markHandled(db, { ids, actor: "admin:owner", now: new Date(T0 + 1e6) }), 3);
  assert.equal(await markHandled(db, { ids, actor: "admin:owner" }), 0, "already handled");
  list = await listReports(db);
  assert.deepEqual(list.open.map((s) => s.url), [OTHER]);
  assert.equal(list.handled[0].url, SITE);
  assert.equal(list.handled[0].handledBy, "admin:owner");
  // The visitor's hash goes once handled; the same visitor can report the site again.
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM problem_reports WHERE url = ? AND reporter IS NOT NULL", args: [SITE] })).rows[0].n, 0);
  await saveReport(db, { url: SITE, reason: "gone", reporter: "v1", now: new Date(T0 + 2e6) });
  assert.equal((await listReports(db)).open.find((s) => s.url === SITE).count, 1);

  assert.equal(await reopenReports(db, { ids }), 3);
  assert.equal((await listReports(db)).open.find((s) => s.url === SITE).count, 4);
});

test("a report changes nothing about the site: no grade, rating, tier, vote or health is written", async () => {
  const db = await freshDb();
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status, ai_rubric) VALUES (?, 'x', 'live', '{\"tier\":\"A\",\"is_portfolio\":true}')", args: [SITE] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1300, 12)", args: [SITE] });
  const snap = async () =>
    JSON.stringify([
      (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [SITE] })).rows,
      (await db.execute({ sql: "SELECT * FROM ratings WHERE url = ?", args: [SITE] })).rows,
      (await db.execute("SELECT COUNT(*) AS n FROM votes")).rows,
      (await db.execute("SELECT COUNT(*) AS n FROM status_reviews")).rows,
    ]);
  const before = await snap();
  const { run } = intake(db);
  for (const reason of REASON_KEYS) assert.equal((await run({ url: SITE, reason }, { visitor: `v-${reason}` })).status, 200);
  const list = await listReports(db);
  await markHandled(db, { ids: list.open[0].reports.map((r) => r.id), actor: "admin:owner" });
  assert.equal(await snap(), before);
});

test("intake: validation comes first and costs nothing", async () => {
  const db = await freshDb();
  const { run, calls } = intake(db);
  assert.deepEqual(await run(null), { status: 400, body: { error: "bad_request" } });
  assert.deepEqual(await run({ url: SITE, reason: "x" }), { status: 400, body: { error: "bad_reason" } });
  assert.deepEqual(await run({ reason: "screenshot" }), { status: 400, body: { error: "bad_request" } });
  assert.deepEqual(await run({ url: "ftp://x.dev", reason: "screenshot" }), { status: 400, body: { error: "bad_request" } });
  assert.deepEqual(await run({ url: SITE, reason: "other", note: "a".repeat(NOTE_MAX + 1) }), { status: 400, body: { error: "note_too_long" } });
  assert.deepEqual(await run({ url: SITE, reason: "other", note: { x: 1 } }), { status: 400, body: { error: "bad_note" } });
  assert.deepEqual(await run({ url: SITE, reason: "other" }, { visitor: "" }), { status: 400, body: { error: "bad_request" } });
  assert.equal(calls.verify, 0, "no bot check spent on a bad request");
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM rate_limits")).rows[0].n, 0, "nor a rate-limit slot");
  assert.equal((await rows(db)).length, 0);
});

test("intake: the bot check refuses, and an unknown site is refused after it", async () => {
  const db = await freshDb();
  const failing = intake(db, { verify: "failed" });
  assert.deepEqual(await failing.run({ url: SITE, reason: "screenshot" }), { status: 403, body: { error: "turnstile_failed" } });
  assert.equal((await rows(db)).length, 0);
  // "skipped" is a local run with no secret (lib/turnstile.ts): accepted.
  const local = intake(db, { verify: "skipped" });
  assert.equal((await local.run({ url: SITE, reason: "screenshot" })).status, 200);
  const unknown = intake(db, { known: [] });
  assert.deepEqual(await unknown.run({ url: OTHER, reason: "gone" }, { visitor: "v2" }), { status: 404, body: { error: "unknown_site" } });
  assert.equal((await rows(db)).length, 1);
});

test("intake: a stored report with its note; the same visitor again updates it", async () => {
  const db = await freshDb();
  const { run } = intake(db);
  assert.deepEqual(await run({ url: SITE, reason: "screenshot", note: "  Cookie   wall " }), { status: 200, body: { ok: true } });
  assert.deepEqual(await run({ url: SITE, reason: "measurement", note: "Speed is off" }), { status: 200, body: { ok: true } });
  const all = await rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].reason, "measurement");
  assert.equal(all[0].note, "Speed is off");
  assert.equal(all[0].reporter, "visitor-a", "only the keyed hash the route passes");
});

test("intake: per network an hour and a day, per visitor a day", async () => {
  const db = await freshDb();
  const { run } = intake(db);
  // One network, many visitors: the hourly network limit stops it first.
  for (let i = 0; i < LIMITS.NETWORK_HOUR; i++) assert.equal((await run({ url: SITE, reason: "other" }, { visitor: `n${i}` })).status, 200);
  const over = await run({ url: SITE, reason: "other" }, { visitor: "n-last" });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, "rate_limited");
  assert.ok(Number(over.headers["retry-after"]) > 0);
  // The day's network limit across hours.
  let accepted = LIMITS.NETWORK_HOUR;
  for (let hour = 1; accepted < LIMITS.NETWORK_DAY; hour++) {
    for (let i = 0; i < LIMITS.NETWORK_HOUR && accepted < LIMITS.NETWORK_DAY; i++, accepted++) {
      const r = await run({ url: OTHER, reason: "other" }, { visitor: `d${accepted}`, now: T0 + hour * 3_600_001 });
      assert.equal(r.status, 200, `report ${accepted + 1}`);
    }
  }
  assert.equal((await run({ url: OTHER, reason: "other" }, { visitor: "d-last", now: T0 + 10 * 3_600_001 })).status, 429, "the day's network limit");

  // One visitor on many networks: the visitor's day limit.
  const db2 = await freshDb();
  const v = intake(db2);
  for (let i = 0; i < LIMITS.VISITOR_DAY; i++) assert.equal((await v.run({ url: SITE, reason: "other" }, { network: `net${i}` })).status, 200);
  assert.equal((await v.run({ url: SITE, reason: "other" }, { network: "net-new" })).status, 429);
  // No network known (a local run): only the visitor limit applies.
  assert.equal((await v.run({ url: SITE, reason: "other" }, { network: "", visitor: "fresh" })).status, 200);
});

test("intake: past a site's day cap the visitor still gets thanks, and nothing more is stored", async () => {
  const db = await freshDb();
  const { run } = intake(db);
  for (let i = 0; i < LIMITS.SITE_DAY; i++) assert.equal((await run({ url: SITE, reason: "screenshot" }, { visitor: `s${i}`, network: `net${i}` })).status, 200);
  assert.deepEqual(await run({ url: SITE, reason: "screenshot" }, { visitor: "late", network: "net-late" }), { status: 200, body: { ok: true } });
  assert.equal((await rows(db)).length, LIMITS.SITE_DAY);
  // Another site is not affected.
  assert.equal((await run({ url: OTHER, reason: "gone" }, { visitor: "late", network: "net-late" })).status, 200);
  assert.equal((await rows(db)).length, LIMITS.SITE_DAY + 1);
});
