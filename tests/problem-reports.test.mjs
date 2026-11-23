// Visitors' "Report a problem" notes (lib/problem-reports) on a throwaway
// database: the note's cleaning and limit, one open report per visitor and
// site, grouping for the admin, handling (never a report changed since the
// owner's page loaded) and reopening (exactly one handled group), and every
// step of POST /api/problem-reports's intake in order: validation, the
// network limits (/64 and /48), the bot check, the live site, the visitor
// limit, a resend, the per-site and whole-site caps with their one log line
// and owner alert. A report never touches a site's grade, rating, tier or
// listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { rateLimit } from "../lib/polls/store.mjs";
import { NOTE_MAX, REASON_KEYS, isProblemReportAlert, cleanNote, cleanSiteUrl, listReports, markHandled, openCount, reopenReports, saveReport } from "../lib/problem-reports/store.mjs";
import { CAP_ALERT_KEY, LIMITS, takeReport } from "../lib/problem-reports/intake.mjs";

const SITE = "https://e2e-reported.dev";
const OTHER = "https://other-reported.dev";
const T0 = Date.UTC(2026, 10, 23, 18);
const ch = (...codes) => String.fromCodePoint(...codes);

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "problem-reports-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

/** The intake with the route's parts stood in: a passing bot check and both sites live, unless told otherwise. */
function intake(db, over = {}) {
  const calls = { verify: 0, logs: [], alerts: [] };
  const run = (body, extra = {}) =>
    takeReport({
      db,
      body,
      visitor: "visitor-a",
      network: "net-a",
      network48: "",
      verify: async () => {
        calls.verify++;
        return over.verify ?? "ok";
      },
      known: async (url) => (over.known ?? [SITE, OTHER]).includes(url),
      rateLimit: (key, opts) => rateLimit(db, key, opts),
      log: (fields) => calls.logs.push(fields),
      alert: async (c) => calls.alerts.push(c),
      now: T0,
      ...extra,
    });
  return { run, calls };
}

const rows = async (db) => (await db.execute("SELECT * FROM problem_reports ORDER BY id")).rows;
const slots = async (db, prefix) => (await db.execute({ sql: "SELECT COALESCE(SUM(n), 0) AS n FROM rate_limits WHERE k LIKE ?", args: [`${prefix}%`] })).rows[0].n;
const seen = (r) => ({ id: r.id, updatedAt: r.updatedAt });

test("cleanNote: plain text, folded, at most NOTE_MAX characters", () => {
  assert.deepEqual(cleanNote(undefined), { note: null });
  assert.deepEqual(cleanNote("   "), { note: null });
  assert.deepEqual(cleanNote(42), { error: "bad_note" });
  assert.deepEqual(cleanNote("  a\u0000b\t\tc  \r\n\n\n\nd "), { note: "a b c\n\nd" });
  assert.deepEqual(cleanNote("<script>alert(1)</script>"), { note: "<script>alert(1)</script>" }, "kept as text: the pages render it as text");
  assert.equal(cleanNote(ch(0xe9).repeat(NOTE_MAX)).note.length, NOTE_MAX);
  assert.deepEqual(cleanNote("a".repeat(NOTE_MAX + 1)), { error: "note_too_long" });
});

test("cleanNote: invisible and text-direction characters are dropped; C1 controls and line separators become spaces", () => {
  const invisible = [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff];
  for (const c of invisible) assert.deepEqual(cleanNote(`x${ch(c)}y`), { note: "xy" }, `U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
  for (const c of [0x0080, 0x0085, 0x009b, 0x009f, 0x2028, 0x2029, 0x007f]) {
    assert.deepEqual(cleanNote(`x${ch(c)}y`), { note: "x y" }, `U+${c.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  // A note that is nothing but invisible characters is no note.
  assert.deepEqual(cleanNote(ch(0x200b, 0xfeff, 0x202e)), { note: null });
});

test("the source files hold no raw invisible or text-direction characters", () => {
  // Escapes in a string, so this file holds none of the characters it looks for.
  const bad = new RegExp("[\\u0080-\\u009f\\u00ad\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]", "u");
  const files = [
    "lib/problem-reports/store.mjs",
    "lib/problem-reports/intake.mjs",
    "lib/problem-reports/schema.mjs",
    "tests/problem-reports.test.mjs",
    "tests/problem-reports-e2e.test.mjs",
    "components/profile/ReportProblem.tsx",
    "components/admin/ProblemReports.tsx",
  ];
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const line = text.split("\n").findIndex((l) => bad.test(l));
    assert.equal(line, -1, `${f} line ${line + 1}`);
  }
});

test("the admin list: attributes are spaced, and the stale message is keyed by the group like every other message", () => {
  const src = fs.readFileSync(new URL("../components/admin/ProblemReports.tsx", import.meta.url), "utf8");
  assert.equal(/\}[A-Za-z-]+=/.test(src), false, "no JSX attribute glued to the one before it");
  assert.equal(src.includes("site.url}`]"), false, "messages are keyed by site.key, never site.url");
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

  const items = list.open[0].reports.map(seen);
  assert.deepEqual(await markHandled(db, { items, actor: "admin:owner", now: new Date(T0 + 1e6) }), { changed: 3, stale: [] });
  assert.equal((await markHandled(db, { items, actor: "admin:owner" })).changed, 0, "already handled");
  list = await listReports(db);
  assert.deepEqual(list.open.map((s) => s.url), [OTHER]);
  assert.equal(list.handled[0].url, SITE);
  assert.equal(list.handled[0].handledBy, "admin:owner");
  // The visitor's hash goes once handled; the same visitor can report the site again.
  assert.equal((await db.execute({ sql: "SELECT COUNT(*) AS n FROM problem_reports WHERE url = ? AND reporter IS NOT NULL", args: [SITE] })).rows[0].n, 0);
  await saveReport(db, { url: SITE, reason: "gone", reporter: "v1", now: new Date(T0 + 2e6) });
  assert.equal((await listReports(db)).open.find((s) => s.url === SITE).count, 1);

  assert.equal(await reopenReports(db, { ids: items.map((x) => x.id) }), 3);
  assert.equal((await listReports(db)).open.find((s) => s.url === SITE).count, 4);
});

test("Mark handled never closes a report the visitor changed after the owner's page loaded", async () => {
  const db = await freshDb();
  await saveReport(db, { url: SITE, reason: "screenshot", note: "Spinner", reporter: "v1", now: new Date(T0) });
  await saveReport(db, { url: SITE, reason: "other", reporter: "v2", now: new Date(T0 + 1000) });
  const shown = (await listReports(db)).open[0].reports.map(seen);
  // v1 resends with a new note while the owner reads the old one.
  await saveReport(db, { url: SITE, reason: "measurement", note: "Actually the project count is wrong", reporter: "v1", now: new Date(T0 + 5000) });
  const out = await markHandled(db, { items: shown, actor: "admin:owner", now: new Date(T0 + 6000) });
  assert.equal(out.changed, 1);
  const v1 = (await rows(db)).find((r) => r.reporter === "v1");
  assert.deepEqual(out.stale, [Number(v1.id)]);
  assert.equal(v1.status, "open", "the new note stays open for the owner");
  assert.equal(v1.note, "Actually the project count is wrong");
});

test("Reopen puts back exactly one handled group; a reopened report then resent by its visitor is a second open report", async () => {
  const db = await freshDb();
  await saveReport(db, { url: SITE, reason: "screenshot", reporter: "v1", now: new Date(T0) });
  let list = await listReports(db);
  await markHandled(db, { items: list.open[0].reports.map(seen), actor: "admin:owner", now: new Date(T0 + 1000) });
  await saveReport(db, { url: SITE, reason: "gone", reporter: "v2", now: new Date(T0 + 2000) });
  list = await listReports(db);
  await markHandled(db, { items: list.open[0].reports.map(seen), actor: "admin:owner", now: new Date(T0 + 3000) });

  list = await listReports(db);
  assert.equal(list.handled.length, 2, "two handled groups for one site, one per Mark handled");
  assert.deepEqual(list.handled.map((g) => g.reasons[0].key), ["gone", "screenshot"], "latest first");
  assert.notEqual(list.handled[0].key, list.handled[1].key);
  // Reopen the older group only.
  assert.equal(await reopenReports(db, { ids: list.handled[1].reports.map((r) => r.id) }), 1);
  list = await listReports(db);
  assert.deepEqual(list.open.map((g) => [g.url, g.count]), [[SITE, 1]]);
  assert.equal(list.open[0].reports[0].reason, "screenshot");
  assert.equal(list.handled.length, 1);

  // The reopened report lost v1's hash when it was handled: v1 sending again adds a second open report (documented).
  await saveReport(db, { url: SITE, reason: "measurement", reporter: "v1", now: new Date(T0 + 4000) });
  assert.equal((await listReports(db)).open[0].count, 2);
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
  await markHandled(db, { items: list.open[0].reports.map(seen), actor: "admin:owner" });
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
  // The route always names a network (the shared "unknown" one without an address); an empty one is a bug, refused.
  assert.deepEqual(await run({ url: SITE, reason: "other" }, { network: "" }), { status: 400, body: { error: "bad_request" } });
  assert.equal(calls.verify, 0, "no bot check spent on a bad request");
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM rate_limits")).rows[0].n, 0, "nor a rate-limit slot");
  assert.equal((await rows(db)).length, 0);
});

test("intake: a failed bot check spends the network slots but not the visitor's, and stores nothing", async () => {
  const db = await freshDb();
  const failing = intake(db, { verify: "failed" });
  assert.deepEqual(await failing.run({ url: SITE, reason: "screenshot" }, { network48: "n48" }), { status: 403, body: { error: "turnstile_failed" } });
  assert.equal(await slots(db, "report:nh:"), 1);
  assert.equal(await slots(db, "report:nd:"), 1);
  assert.equal(await slots(db, "report:n48:"), 1);
  assert.equal(await slots(db, "report:vd:"), 0, "the per-visitor limit comes after the bot check");
  assert.equal((await rows(db)).length, 0);
  // A visitor whose checks fail many times still has a full day of reports once one passes.
  for (let i = 0; i < LIMITS.VISITOR_DAY + 2; i++) await failing.run({ url: SITE, reason: "other" }, { network: `fail-net-${i}` });
  const passing = intake(db);
  assert.equal((await passing.run({ url: SITE, reason: "other" }, { network: "fresh-net" })).status, 200);
  // "skipped" is a local run with no secret (lib/turnstile.ts): accepted.
  const local = intake(db, { verify: "skipped" });
  assert.equal((await local.run({ url: OTHER, reason: "screenshot" }, { network: "local-net" })).status, 200);
});

test("intake: a site without a live profile is refused after the bot check, before the visitor limit", async () => {
  const db = await freshDb();
  const unknown = intake(db, { known: [] });
  assert.deepEqual(await unknown.run({ url: OTHER, reason: "gone" }), { status: 404, body: { error: "unknown_site" } });
  assert.equal(unknown.calls.verify, 1);
  assert.equal(await slots(db, "report:vd:"), 0);
  assert.equal((await rows(db)).length, 0);
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

test("intake: per network an hour and a day, per IPv6 /48 a day, per visitor a day", async () => {
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

  // Stepping through /64s inside one /48: the /48's day limit.
  const db48 = await freshDb();
  const six = intake(db48);
  for (let i = 0; i < LIMITS.NETWORK48_DAY; i++) {
    const r = await six.run({ url: i % 2 ? SITE : OTHER, reason: "other" }, { visitor: `s${i}`, network: `net64-${i}`, network48: "one-48", now: T0 + i * 60_000 });
    assert.equal(r.status, 200, `report ${i + 1}`);
  }
  assert.equal((await six.run({ url: SITE, reason: "other" }, { visitor: "s-last", network: "net64-new", network48: "one-48" })).status, 429);
  assert.equal((await six.run({ url: SITE, reason: "other" }, { visitor: "s-last", network: "net64-new", network48: "another-48" })).status, 200);

  // One visitor on many networks: the visitor's day limit.
  const db2 = await freshDb();
  const v = intake(db2);
  for (let i = 0; i < LIMITS.VISITOR_DAY; i++) assert.equal((await v.run({ url: i % 2 ? SITE : OTHER, reason: "other" }, { network: `net${i}` })).status, 200);
  assert.equal((await v.run({ url: SITE, reason: "other" }, { network: "net-new" })).status, 429);
});

test("intake: past a site's day cap the visitor still gets thanks, nothing more is stored, and it is logged once", async () => {
  const db = await freshDb();
  const { run, calls } = intake(db);
  for (let i = 0; i < LIMITS.SITE_DAY; i++) assert.equal((await run({ url: SITE, reason: "screenshot" }, { visitor: `s${i}`, network: `net${i}` })).status, 200);
  for (let i = 0; i < 3; i++) assert.deepEqual(await run({ url: SITE, reason: "screenshot" }, { visitor: `late${i}`, network: `net-late${i}` }), { status: 200, body: { ok: true } });
  assert.equal((await rows(db)).length, LIMITS.SITE_DAY);
  assert.equal(calls.logs.length, 1, "logged once per site per day");
  assert.equal(calls.logs[0].event, "problem_reports_site_cap");
  assert.equal(calls.alerts.length, 0);
  // A visitor who already has an open report can still correct it: no new row, no cap charged.
  assert.equal((await run({ url: SITE, reason: "gone", note: "Corrected" }, { visitor: "s0", network: "net0" })).status, 200);
  assert.equal((await rows(db)).find((r) => r.reporter === "s0").note, "Corrected");
  // Another site is not affected.
  assert.equal((await run({ url: OTHER, reason: "gone" }, { visitor: "late", network: "net-late" })).status, 200);
  assert.equal((await rows(db)).length, LIMITS.SITE_DAY + 1);
});

test("intake: a resend never charges the site cap", async () => {
  const db = await freshDb();
  const { run } = intake(db);
  assert.equal((await run({ url: SITE, reason: "screenshot" })).status, 200);
  for (let i = 0; i < 4; i++) await run({ url: SITE, reason: "other", note: `edit ${i}` });
  assert.equal(await slots(db, "report:sd:"), 1, "one new report, one slot");
  assert.equal(await slots(db, "report:all"), 1);
});

test("intake: past the whole site's day cap: thanks, nothing stored, one log line and one quiet owner alert", async () => {
  const db = await freshDb();
  const { run, calls } = intake(db);
  // Fill the whole-site counter directly (as many sites' reports would).
  for (let i = 0; i < LIMITS.ALL_DAY; i++) await rateLimit(db, "report:all", { limit: LIMITS.ALL_DAY, windowMs: 86_400_000, now: T0 });
  for (let i = 0; i < 3; i++) assert.deepEqual(await run({ url: SITE, reason: "screenshot" }, { visitor: `v${i}`, network: `n${i}` }), { status: 200, body: { ok: true } });
  assert.equal((await rows(db)).length, 0);
  assert.deepEqual(calls.logs.map((l) => l.event), ["problem_reports_daily_cap"]);
  assert.equal(calls.alerts.length, 1);
  assert.equal(calls.alerts[0].key, CAP_ALERT_KEY);
  assert.equal(calls.alerts[0].quiet, true);
});

test("intake: a failing owner alert still thanks the visitor, is logged, and is tried again by the next request", async () => {
  const db = await freshDb();
  let fail = true;
  const alerts = [];
  const logs = [];
  const run = (i) =>
    takeReport({
      db,
      body: { url: SITE, reason: "screenshot" },
      visitor: `v${i}`,
      network: `n${i}`,
      verify: async () => "ok",
      known: async () => true,
      rateLimit: (key, opts) => rateLimit(db, key, opts),
      log: (f) => logs.push(f.event),
      alert: async (c) => {
        if (fail) throw new Error("database is locked");
        alerts.push(c.key);
      },
      now: T0,
    });
  for (let i = 0; i < LIMITS.ALL_DAY; i++) await rateLimit(db, "report:all", { limit: LIMITS.ALL_DAY, windowMs: 86_400_000, now: T0 });
  assert.deepEqual(await run(0), { status: 200, body: { ok: true } }, "the thanks, not a 500");
  assert.deepEqual(logs, ["problem_reports_daily_cap", "problem_reports_alert_failed"]);
  assert.equal(await slots(db, "report:all-logged"), 0, "the day's mark is not spent on a failed alert");
  fail = false;
  assert.equal((await run(1)).status, 200);
  assert.deepEqual(alerts, [CAP_ALERT_KEY], "the next request records it");
  assert.equal((await run(2)).status, 200);
  assert.deepEqual(alerts, [CAP_ALERT_KEY], "and only once that day");
});

test("the cap alert: raised by the route's reconcile, left alone by the night's, cleared by Mark handled's", async () => {
  const { reconcileAlerts, activeAlerts } = await import("../pipeline/alerts.mjs");
  const db = await freshDb();
  const open = async () => (await activeAlerts(db)).map((a) => a.key);
  assert.equal(isProblemReportAlert(CAP_ALERT_KEY), true);
  assert.equal(isProblemReportAlert("newsletter-stopped:1"), false);
  // As app/api/problem-reports/route.ts raises it.
  await reconcileAlerts(db, { conditions: [{ key: CAP_ALERT_KEY, kind: "problem", title: "cap", quiet: true }], scope: (k) => k === CAP_ALERT_KEY, now: new Date(T0) });
  assert.deepEqual(await open(), [CAP_ALERT_KEY]);
  // The night's reconcile (worker/night.ts, its scope excludes isProblemReportAlert; tests/ops-schedules.test.mjs checks it does) holds none of it.
  await reconcileAlerts(db, { conditions: [], scope: (k) => !isProblemReportAlert(k), now: new Date(T0 + 6 * 3_600_000) });
  assert.deepEqual(await open(), [CAP_ALERT_KEY], "the night leaves it open");
  // As app/api/admin/problem-reports/route.ts clears it on Mark handled.
  await reconcileAlerts(db, { conditions: [], scope: (k) => k === CAP_ALERT_KEY, now: new Date(T0 + 7 * 3_600_000) });
  assert.deepEqual(await open(), []);
});

test("retention: handled reports go 180 days after handling; open ones stay", async () => {
  const { pruneLogs, HANDLED_REPORT_DAYS } = await import("../pipeline/retention.mjs");
  const db = await freshDb();
  const old = new Date(T0 - (HANDLED_REPORT_DAYS + 1) * 86_400_000);
  await saveReport(db, { url: SITE, reason: "screenshot", reporter: "v1", now: old });
  await saveReport(db, { url: SITE, reason: "gone", reporter: "v2", now: old });
  await saveReport(db, { url: OTHER, reason: "other", reporter: "v3", now: old });
  const [a, b] = (await listReports(db)).open.find((g) => g.url === SITE).reports.sort((x, y) => x.id - y.id);
  await markHandled(db, { items: [seen(a)], actor: "admin:owner", now: old });
  await markHandled(db, { items: [seen(b)], actor: "admin:owner", now: new Date(T0 - 86_400_000) });
  const out = await pruneLogs(db, { now: new Date(T0) });
  assert.equal(out.problemReports, 1);
  assert.deepEqual(
    (await rows(db)).map((r) => [r.url, r.status]),
    [
      [SITE, "handled"],
      [OTHER, "open"],
    ]
  );
});
