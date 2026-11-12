// When checks re-run (lib/freshness.mjs): the change fingerprint's
// normalization (per-request noise never changes it, a deploy or an edit
// does), the comparison of two fingerprints, the rule for every check kind,
// and the selections the scheduled jobs make, on a throwaway local
// database. No server or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ACTIVE, ensureRosterSchema } from "../pipeline/roster.mjs";
import {
  CHECK_KINDS,
  assetUrls,
  checkFingerprints,
  compareFingerprints,
  decide,
  dueForFingerprint,
  freshnessSummary,
  lighthouseDue,
  linksDue,
  markForced,
  normalizeHtml,
  pacificDayStart,
  pageFingerprint,
  perTick,
  readFreshness,
  recordCheck,
  recordChecks,
  screenshotsDue,
} from "../lib/freshness.mjs";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-11T20:00:00Z");

/** A realistic page; every argument is something that differs per request or per deploy. */
function page({ nonce = "r4nd0mN0nc3", csrf = "tok-abc123", stamp = "2026-11-11T10:00:00.000Z", epoch = 1762855200000, reqId = "0f8fad5b-d9cb-469f-a165-70867728950e", cf = "a1b2c3d4e5f6", build = "a1b2c3", css = "9f8e7d", headline = "Hi, I'm Jane", extraSpace = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="csrf-token" content="${csrf}">
  <title>Jane Doe - Developer</title>
  <link rel="stylesheet" href="/_next/static/css/${css}.css">
  <link rel="preload" as="script" href="/_next/static/chunks/main-${build}.js">
  <script nonce="${nonce}">window.__STATE__ = { at: "${stamp}", t: ${epoch}, requestId: "${reqId}" };</script>
  <script src="/_next/static/chunks/main-${build}.js" nonce="${nonce}" defer></script>
  <script src="https://www.googletagmanager.com/gtag/js?id=G-ABC&amp;t=${epoch}"></script>
  <!-- rendered at ${stamp} in 12ms -->
</head>
<body data-request-id="${reqId}">
  <header><h1>${headline}</h1>${extraSpace}</header>
  <form action="/contact" method="post"><input type="hidden" name="authenticity_token" value="${csrf}"><button>Send</button></form>
  <a href="/cdn-cgi/l/email-protection#${cf}" class="__cf_email__" data-cfemail="${cf}">[email protected]</a>
  <footer>Served ${new Date(epoch).toUTCString()} at 10:00:00 · © 2026</footer>
</body></html>`;
}
const fp = (html, headers = null) => pageFingerprint({ html, finalUrl: "https://jane.dev/", headers, now: NOW });

test("normalization: per-request noise never changes the fingerprint", () => {
  const a = fp(page());
  const b = fp(
    page({
      nonce: "Zz9yXw",
      csrf: "tok-zzz999",
      stamp: "2026-11-12T23:59:59.999Z",
      epoch: 1762999999999,
      reqId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      cf: "ffeeddccbbaa",
      extraSpace: "\n\n   ",
    })
  );
  assert.equal(a.hash, b.hash);
  assert.notEqual(a.raw, b.raw, "the raw bodies differ, only the noise");
  // Nothing of the noise survives normalization.
  const n = normalizeHtml(page());
  for (const noise of ["r4nd0mN0nc3", "tok-abc123", "1762855200000", "0f8fad5b", "a1b2c3d4e5f6", "rendered at"]) assert.ok(!n.includes(noise), `${noise} survived`);
});

test("normalization: a new build hash, a new stylesheet or an edited page is a change", () => {
  const a = fp(page());
  assert.notEqual(fp(page({ build: "d4e5f6" })).hash, a.hash, "a deploy changes the script's build hash");
  assert.notEqual(fp(page({ css: "123abc" })).hash, a.hash, "a new stylesheet");
  assert.notEqual(fp(page({ headline: "Hi, I'm Jane Doe" })).hash, a.hash, "edited text");
  // A new link, even a long one, is a change; a tracking payload is not.
  const withLink = (href) => fp(page({ headline: `Jane <a href="${href}">post</a>` })).hash;
  assert.notEqual(withLink("/blog/how-i-built-my-portfolio-with-nextjs-and-tailwind"), withLink("/blog/how-i-built-my-portfolio-with-astro-and-tailwind-css"));
  const tracked = (id) => fp(page({ headline: `Jane <div data-hydro="eyJyZWZlcnJlciI6IiIsInJlcXVlc3RfaWQiOi${id}In0="></div>` })).hash;
  assert.equal(tracked("JCNDk0OjFBNDIxRTo5OUNFRjY6MThCN0Q3"), tracked("JCNDk0OjFBNDIxRTo5OUQxQTU6MThCODIw"));
});

test("asset URLs: absolute, sorted, per-request query parameters dropped, versions kept", () => {
  const html = `<script src="/b.js?v=2"></script><script src="https://cdn.x/a.js?t=1762855200"></script>
    <link rel="stylesheet" href="s.css?_wpnonce=abc"><link rel="modulepreload" href="/m.js"><link rel="icon" href="/favicon.ico">
    <link rel="preload" as="font" href="/f.woff2"><script>inline()</script>`;
  assert.deepEqual(assetUrls(html, "https://jane.dev/blog/"), ["/b.js?v=2", "/blog/s.css", "/m.js", "https://cdn.x/a.js"]);
  // The same page with or without "www." has the same assets.
  assert.deepEqual(assetUrls(html, "https://www.jane.dev/blog/"), assetUrls(html, "https://jane.dev/blog/"));
  assert.equal(pageFingerprint({ html: page(), finalUrl: "https://www.jane.dev/" }).hash, fp(page()).hash);
});

test("normalization: a body cut off inside an inline script hashes like the whole page", () => {
  const head = `<html><body><h1>Jane</h1><p>${"work ".repeat(50)}</p>`;
  const whole = `${head}<script>var t = "${"x".repeat(200)}";</script><p>more</p></body></html>`;
  const cut = `${head}<script>var t = "${"x".repeat(80)}`;
  assert.equal(normalizeHtml(cut), normalizeHtml(head));
  assert.ok(normalizeHtml(whole).startsWith(normalizeHtml(head)));
});

test("compare: the first fingerprint is a baseline; content changes count; validators only when the body is identical", () => {
  const html = page();
  const base = fp(html, { etag: '"v1"', "last-modified": "Mon, 02 Nov 2026 08:00:00 GMT", date: "Wed, 11 Nov 2026 20:00:00 GMT" });
  assert.deepEqual(compareFingerprints(null, base), { changed: false, first: true, reason: "first" });
  assert.equal(compareFingerprints(base, fp(html, { etag: '"v1"' })).changed, false);
  assert.equal(compareFingerprints(base, fp(page({ headline: "New" }))).reason, "content");
  // Same bytes, new ETag: a redeploy of identical HTML whose scripts may have changed.
  assert.equal(compareFingerprints(base, fp(html, { etag: '"v2"' })).reason, "redeploy");
  assert.equal(compareFingerprints(base, fp(html, { "last-modified": "Tue, 10 Nov 2026 08:00:00 GMT", date: "Wed, 11 Nov 2026 20:00:00 GMT" })).reason, "redeploy");
  // A body that differs only by noise, with an ETag hashed from it: not a change.
  assert.equal(compareFingerprints(base, fp(page({ nonce: "other" }), { etag: '"v9"' })).changed, false);
  // A Last-Modified that is the response's own time is a dynamic page, never a version.
  const dynamic = fp(html, { "last-modified": "Wed, 11 Nov 2026 19:59:59 GMT", date: "Wed, 11 Nov 2026 20:00:00 GMT" });
  assert.equal(dynamic.lastModified, null);
});

test("the rule, for every check kind: reuse while unchanged, re-run on a change, Re-measure or past the maximum age", () => {
  const maxDays = { lighthouse: 90, screenshots: 90, polish: 30, links: 30, freeChecks: 30 };
  for (const [kind, days] of Object.entries(maxDays)) {
    assert.equal(CHECK_KINDS[kind].maxAgeMs, days * DAY, `${kind} max age`);
    const at = NOW - 10 * DAY;
    const result = { at, failed: false };
    assert.deepEqual(decide(kind, { result: null, now: NOW }), { run: true, reason: "missing", unchangedSince: null });
    // Unchanged, and checked again after it was measured.
    assert.deepEqual(decide(kind, { result, page: { checked_at: NOW - DAY, changed_at: null }, now: NOW }), { run: false, reason: null, unchangedSince: NOW - DAY });
    // Unchanged, with no check since: reused, nothing to say.
    assert.equal(decide(kind, { result, page: { checked_at: at - DAY }, now: NOW }).unchangedSince, null);
    assert.equal(decide(kind, { result, page: { checked_at: NOW - DAY, changed_at: NOW - 2 * DAY }, now: NOW }).reason, "changed");
    // A change before it was measured is already in the result.
    assert.equal(decide(kind, { result, page: { changed_at: at - DAY }, now: NOW }).run, false);
    assert.equal(decide(kind, { result, page: { forced_at: NOW - HOUR }, now: NOW }).reason, "forced");
    assert.equal(decide(kind, { result: { at: NOW - (days - 1) * DAY }, now: NOW }).run, false, `${kind} under ${days} days`);
    assert.equal(decide(kind, { result: { at: NOW - days * DAY }, now: NOW }).reason, "max_age", `${kind} at ${days} days`);
  }
});

test("the rule: failures keep their short retry window, and Re-measure overrides it", () => {
  for (const kind of ["lighthouse", "polish", "links", "screenshots"]) {
    assert.equal(decide(kind, { result: { at: NOW - 59 * 60000, failed: true }, now: NOW }).run, false, `${kind}: within the hour`);
    assert.equal(decide(kind, { result: { at: NOW - HOUR, failed: true }, now: NOW }).reason, "failed", `${kind}: after an hour`);
    // A changed page doesn't shorten a failure's window; the admin's Re-measure does.
    assert.equal(decide(kind, { result: { at: NOW - 600000, failed: true }, page: { changed_at: NOW - 60000 }, now: NOW }).run, false);
    assert.equal(decide(kind, { result: { at: NOW - 600000, failed: true }, page: { forced_at: NOW - 60000 }, now: NOW }).reason, "forced");
  }
  assert.equal(decide("freeChecks", { result: { at: NOW - 9 * 60000, failed: true }, now: NOW }).run, false);
  assert.equal(decide("freeChecks", { result: { at: NOW - 10 * 60000, failed: true }, now: NOW }).reason, "failed");
});

test("cadence: a 168th of the list an hour, so each site once a week", () => {
  assert.equal(perTick(2106), 14);
  assert.ok(perTick(2106) * 24 * 7 >= 2106);
  assert.equal(perTick(0), 1);
  assert.equal(perTick(1_000_000), 60, "capped per tick");
});

test("pacific day start", () => {
  assert.equal(new Date(pacificDayStart(NOW)).toISOString(), "2026-11-11T08:00:00.000Z");
  assert.equal(new Date(pacificDayStart(Date.parse("2026-07-01T06:30:00Z"))).toISOString(), "2026-06-30T07:00:00.000Z");
});

async function freshDb() {
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "fresh-")), "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  return db;
}
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
async function addSite(db, url, { tier = "A", captured = NOW - 10 * DAY, factsAt = NOW - 10 * DAY, health = null, delisted = null, status = "live" } = {}) {
  await db.execute({
    sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts, facts_at, ai_rubric, health, delisted_at) VALUES (?, ?, 'k', ?, '{}', ?, ?, ?, ?)",
    args: [url, status, sqlTime(captured), new Date(factsAt).toISOString(), JSON.stringify({ tier }), health, delisted],
  });
}

test("fingerprint checks: due weekly, never twice in a day, and only listed live sites", async () => {
  const db = await freshDb();
  for (const u of ["https://a.dev", "https://b.dev", "https://c.dev"]) await addSite(db, u);
  await addSite(db, "https://down.dev", { health: "down" });
  await addSite(db, "https://gone.dev", { delisted: "2026-11-01" });
  await addSite(db, "https://dead.dev", { status: "dead" });
  const fetched = [];
  let headline = "v1";
  const fetchPage = async (url) => {
    fetched.push(url);
    if (url === "https://c.dev") return { error: "unreachable" };
    return { fp: fp(page({ headline })) };
  };
  const first = await checkFingerprints(db, { fetchPage, now: NOW, limit: 10, active: ACTIVE });
  assert.deepEqual(fetched.sort(), ["https://a.dev", "https://b.dev", "https://c.dev"]);
  assert.deepEqual(first, { due: 3, checked: 2, failed: 1, changed: 0, first: 2 });
  // An hour later and six days later: nothing is due, not even the one that failed.
  assert.deepEqual(await dueForFingerprint(db, { now: NOW + HOUR, limit: 10, active: ACTIVE }), []);
  assert.deepEqual(await dueForFingerprint(db, { now: NOW + 6 * DAY, limit: 10, active: ACTIVE }), []);
  // A week later: all three, and an edited page is recorded as changed.
  headline = "v2";
  const week = await checkFingerprints(db, { fetchPage, now: NOW + 7 * DAY, limit: 10, active: ACTIVE });
  assert.deepEqual(week, { due: 3, checked: 2, failed: 1, changed: 2, first: 0 });
  const a = await readFreshness(db, "https://a.dev");
  assert.equal(Number(a.changed_at), NOW + 7 * DAY);
  assert.equal(a.change_reason, "content");
  // The unreachable site kept no fingerprint, only its attempt.
  const c = await readFreshness(db, "https://c.dev");
  assert.equal(c.hash, null);
  assert.equal(c.error, "unreachable");
  // Oldest attempts first, limited.
  await db.execute({ sql: "UPDATE site_freshness SET attempted_at = ? WHERE url = ?", args: [NOW - 30 * DAY, "https://b.dev"] });
  assert.deepEqual(await dueForFingerprint(db, { now: NOW + 8 * DAY, limit: 1, active: ACTIVE }), ["https://b.dev"]);
});

test("recording: an unchanged page keeps its change time; a failed fetch keeps the fingerprint", async () => {
  const db = await freshDb();
  const url = "https://a.dev";
  await recordCheck(db, url, fp(page()), { now: NOW });
  await recordCheck(db, url, fp(page({ headline: "new" })), { now: NOW + DAY });
  await recordCheck(db, url, fp(page({ headline: "new", nonce: "x" })), { now: NOW + 2 * DAY });
  await recordChecks(db, [{ url, error: "http_503" }], { now: NOW + 3 * DAY });
  const row = await readFreshness(db, url);
  assert.equal(Number(row.changed_at), NOW + DAY);
  assert.equal(Number(row.checked_at), NOW + 2 * DAY);
  assert.equal(Number(row.attempted_at), NOW + 3 * DAY);
  assert.equal(row.hash, fp(page({ headline: "new" })).hash);
});

test("Lighthouse prewarm picks due results: never measured, changed or re-measured, failed past the hour, past 90 days", async () => {
  const db = await freshDb();
  const store = (kind, url, at, ok = true) => db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, ?, ?)", args: [`${kind}:${url}`, JSON.stringify({ ok }), at] });
  const sites = {
    never: [],
    fresh: [["psi", NOW - 80 * DAY], ["inspect", NOW - DAY]],
    old: [["psi", NOW - 91 * DAY], ["inspect", NOW - DAY]],
    changed: [["psi", NOW - 20 * DAY], ["inspect", NOW - DAY]],
    forced: [["psi", NOW - 2 * DAY], ["inspect", NOW - DAY]],
    failedLong: [["psi", NOW - 2 * HOUR, false], ["inspect", NOW - DAY]],
    failedNow: [["psi", NOW - 10 * 60000, false], ["inspect", NOW - DAY]],
    polishOld: [["psi", NOW - DAY], ["inspect", NOW - 31 * DAY]],
    tierC: [],
  };
  for (const [name, rows] of Object.entries(sites)) {
    await addSite(db, `https://${name}.dev`, { tier: name === "tierC" ? "C" : "A" });
    for (const [kind, at, ok] of rows) await store(kind, `https://${name}.dev`, at, ok);
  }
  await recordCheck(db, "https://changed.dev", fp(page()), { now: NOW - 30 * DAY });
  await recordCheck(db, "https://changed.dev", fp(page({ headline: "x" })), { now: NOW - 5 * DAY });
  await markForced(db, "https://forced.dev", { now: NOW - HOUR });
  const due = await lighthouseDue(db, { now: NOW, limit: 20, active: ACTIVE });
  // Then the oldest Lighthouse result first: the 91-day one, the day-old one whose polish is due, the failure.
  assert.deepEqual(due, ["https://never.dev", "https://changed.dev", "https://forced.dev", "https://old.dev", "https://polishOld.dev", "https://failedLong.dev"]);
});

test("screenshots: changed or asked for first, then captures past 90 days; links: the same at 30 days", async () => {
  const db = await freshDb();
  await addSite(db, "https://recent.dev", { captured: NOW - 30 * DAY, factsAt: NOW - 29 * DAY });
  await addSite(db, "https://old.dev", { captured: NOW - 95 * DAY, factsAt: NOW - 95 * DAY });
  await addSite(db, "https://links.dev", { captured: NOW - 40 * DAY, factsAt: NOW - 31 * DAY });
  await addSite(db, "https://changed.dev", { captured: NOW - 20 * DAY, factsAt: NOW - 20 * DAY });
  await addSite(db, "https://forced.dev", { captured: NOW - 2 * DAY, factsAt: NOW - 2 * DAY });
  await recordCheck(db, "https://changed.dev", fp(page()), { now: NOW - 40 * DAY });
  await recordCheck(db, "https://changed.dev", fp(page({ build: "zzz" })), { now: NOW - DAY });
  await markForced(db, "https://forced.dev", { now: NOW - HOUR });
  assert.deepEqual(await screenshotsDue(db, { now: NOW, limit: 10, active: ACTIVE }), ["https://changed.dev", "https://forced.dev", "https://old.dev"]);
  assert.deepEqual((await linksDue(db, { now: NOW, limit: 10, active: ACTIVE })).map((r) => r.url), ["https://changed.dev", "https://forced.dev", "https://old.dev", "https://links.dev"]);
  // A re-capture tonight renews both.
  await db.execute({ sql: "UPDATE portfolios SET captured_at = ?, facts_at = ? WHERE url = 'https://changed.dev'", args: [sqlTime(NOW), new Date(NOW).toISOString()] });
  assert.ok(!(await screenshotsDue(db, { now: NOW + 60000, limit: 10, active: ACTIVE })).includes("https://changed.dev"));
  assert.ok(!(await linksDue(db, { now: NOW + 60000, limit: 10, active: ACTIVE })).some((r) => r.url === "https://changed.dev"));
});

test("the admin's counts: unchanged, changed this week, never checked, checked and re-measured today", async () => {
  const db = await freshDb();
  for (const u of ["https://a.dev", "https://b.dev", "https://c.dev", "https://d.dev"]) await addSite(db, u);
  await recordCheck(db, "https://a.dev", fp(page()), { now: NOW - 20 * DAY });
  await recordCheck(db, "https://a.dev", fp(page()), { now: NOW - HOUR });
  await recordCheck(db, "https://b.dev", fp(page()), { now: NOW - 20 * DAY });
  await recordCheck(db, "https://b.dev", fp(page({ headline: "x" })), { now: NOW - 2 * DAY });
  await recordCheck(db, "https://c.dev", fp(page()), { now: NOW - 3 * DAY });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES ('psi:https://a.dev', '{}', ?), ('inspect:https://a.dev', '{}', ?), ('psi:https://b.dev', '{}', ?)", args: [NOW - HOUR, NOW - HOUR, NOW - DAY] });
  await db.execute({ sql: "UPDATE portfolios SET captured_at = ? WHERE url = 'https://c.dev'", args: [sqlTime(NOW - 2 * HOUR)] });
  const s = await freshnessSummary(db, { now: NOW, active: ACTIVE });
  assert.deepEqual(s, { unchanged: 2, changedThisWeek: 1, unchecked: 1, checkedToday: 1, remeasuredToday: { lighthouse: 1, polish: 1, screenshots: 1, links: 0, total: 3 } });
});
