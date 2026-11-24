// When checks re-run (lib/freshness.mjs): the rule for every check kind (due
// by age or by a person's request, never because the page changed), the
// selections the scheduled jobs make, and the grader's page fingerprint
// (normalization: per-request noise never changes it, a deploy or an edit
// does), on a throwaway local database. No server or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { ACTIVE, ensureRosterSchema } from "../pipeline/roster.mjs";
import { CHECK_KINDS, assetUrls, decide, lighthouseDue, linksDue, markForced, normalizeHtml, pageFingerprint, readFreshness, screenshotsDue } from "../lib/freshness.mjs";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { SCHEDULED_TASKS } from "../worker/crons.ts";

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

test("fingerprint: a Last-Modified that is the response's own time is a dynamic page, never a version", () => {
  const dynamic = fp(page(), { "last-modified": "Wed, 11 Nov 2026 19:59:59 GMT", date: "Wed, 11 Nov 2026 20:00:00 GMT" });
  assert.equal(dynamic.lastModified, null);
  assert.equal(fp(page(), { "last-modified": "Mon, 02 Nov 2026 08:00:00 GMT", date: "Wed, 11 Nov 2026 20:00:00 GMT" }).lastModified, "Mon, 02 Nov 2026 08:00:00 GMT");
});

test("the rule, for every check kind: reuse until the maximum age or a person's request", () => {
  const maxDays = { lighthouse: 90, screenshots: 90, polish: 30, links: 30, freeChecks: 30 };
  for (const [kind, days] of Object.entries(maxDays)) {
    assert.equal(CHECK_KINDS[kind].maxAgeMs, days * DAY, `${kind} max age`);
    const at = NOW - 10 * DAY;
    const result = { at, failed: false };
    assert.deepEqual(decide(kind, { result: null, now: NOW }), { run: true, reason: "missing" });
    assert.deepEqual(decide(kind, { result, now: NOW }), { run: false, reason: null });
    // An old row's changed_at (the removed hourly fingerprints) never makes anything due.
    assert.deepEqual(decide(kind, { result, page: { checked_at: NOW - DAY, changed_at: NOW - 2 * DAY }, now: NOW }), { run: false, reason: null });
    assert.deepEqual(decide(kind, { result, page: { forced_at: NOW - HOUR }, now: NOW }), { run: true, reason: "forced" });
    // A request before it was measured is already in the result.
    assert.equal(decide(kind, { result, page: { forced_at: at - DAY }, now: NOW }).run, false);
    assert.equal(decide(kind, { result: { at: NOW - (days - 1) * DAY }, now: NOW }).run, false, `${kind} under ${days} days`);
    assert.equal(decide(kind, { result: { at: NOW - days * DAY }, now: NOW }).reason, "max_age", `${kind} at ${days} days`);
  }
});

test("the rule: failures keep their short retry window, and Re-measure overrides it", () => {
  for (const kind of ["lighthouse", "polish", "links", "screenshots"]) {
    assert.equal(decide(kind, { result: { at: NOW - 59 * 60000, failed: true }, now: NOW }).run, false, `${kind}: within the hour`);
    assert.equal(decide(kind, { result: { at: NOW - HOUR, failed: true }, now: NOW }).reason, "failed", `${kind}: after an hour`);
    assert.equal(decide(kind, { result: { at: NOW - 600000, failed: true }, page: { changed_at: NOW - 60000 }, now: NOW }).run, false);
    assert.equal(decide(kind, { result: { at: NOW - 600000, failed: true }, page: { forced_at: NOW - 60000 }, now: NOW }).reason, "forced");
  }
  assert.equal(decide("freeChecks", { result: { at: NOW - 9 * 60000, failed: true }, now: NOW }).run, false);
  assert.equal(decide("freeChecks", { result: { at: NOW - 10 * 60000, failed: true }, now: NOW }).reason, "failed");
});

async function freshDb() {
  const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "fresh-")), "db.sqlite")}` });
  await migrate(db);
  await ensureRosterSchema(db);
  return db;
}
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
async function addSite(db, url, { tier = "A", rubric = null, captured = NOW - 10 * DAY, factsAt = NOW - 10 * DAY, health = null, delisted = null, status = "live" } = {}) {
  await db.execute({
    sql: "INSERT INTO portfolios (url, status, shot_key, captured_at, facts, facts_at, ai_rubric, health, delisted_at) VALUES (?, ?, 'k', ?, '{}', ?, ?, ?, ?)",
    args: [url, status, sqlTime(captured), new Date(factsAt).toISOString(), JSON.stringify(rubric ?? { tier }), health, delisted],
  });
}
/** A site_freshness row as the removed hourly fingerprints left it: a recent change. */
const oldChangeRow = (db, url, changedAt) =>
  db.execute({
    sql: "INSERT INTO site_freshness (url, hash, checked_at, attempted_at, changed_at, change_reason) VALUES (?, 'h', ?, ?, ?, 'content')",
    args: [url, changedAt, changedAt, changedAt],
  });

test("Lighthouse prewarm picks due results: never measured, asked for, failed past the hour, past 90 days; an old change is not a reason", async () => {
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
    v3: [],
    notPortfolio: [],
  };
  // Gemini's letter is never read (rubric v3): a C counts like any graded portfolio, a v3 grade with no letter too,
  // and only "not a portfolio" is left out.
  const rubricOf = { tierC: { tier: "C" }, v3: { rubric_version: 3, is_portfolio: true }, notPortfolio: { rubric_version: 3, is_portfolio: false } };
  for (const [name, rows] of Object.entries(sites)) {
    await addSite(db, `https://${name}.dev`, { rubric: rubricOf[name] ?? null });
    for (const [kind, at, ok] of rows) await store(kind, `https://${name}.dev`, at, ok);
  }
  await oldChangeRow(db, "https://changed.dev", NOW - 5 * DAY);
  await markForced(db, "https://forced.dev", { now: NOW - HOUR });
  const due = await lighthouseDue(db, { now: NOW, limit: 20, active: ACTIVE });
  // Never measured (by address), then asked for, then the oldest Lighthouse result first: the 91-day one, the day-old one whose polish is due, the failure.
  assert.deepEqual(due, ["https://never.dev", "https://tierC.dev", "https://v3.dev", "https://forced.dev", "https://old.dev", "https://polishOld.dev", "https://failedLong.dev"]);
});

test("screenshots: asked for first, then captures past 90 days; links: the same at 30 days; an old change is not a reason", async () => {
  const db = await freshDb();
  await addSite(db, "https://recent.dev", { captured: NOW - 30 * DAY, factsAt: NOW - 29 * DAY });
  await addSite(db, "https://old.dev", { captured: NOW - 95 * DAY, factsAt: NOW - 95 * DAY });
  await addSite(db, "https://links.dev", { captured: NOW - 40 * DAY, factsAt: NOW - 31 * DAY });
  await addSite(db, "https://changed.dev", { captured: NOW - 20 * DAY, factsAt: NOW - 20 * DAY });
  await addSite(db, "https://forced.dev", { captured: NOW - 2 * DAY, factsAt: NOW - 2 * DAY });
  await oldChangeRow(db, "https://changed.dev", NOW - DAY);
  await markForced(db, "https://forced.dev", { now: NOW - HOUR });
  assert.deepEqual(await screenshotsDue(db, { now: NOW, limit: 10, active: ACTIVE }), ["https://forced.dev", "https://old.dev"]);
  assert.deepEqual((await linksDue(db, { now: NOW, limit: 10, active: ACTIVE })).map((r) => r.url), ["https://forced.dev", "https://old.dev", "https://links.dev"]);
  // A re-capture tonight renews both.
  await db.execute({ sql: "UPDATE portfolios SET captured_at = ?, facts_at = ? WHERE url = 'https://forced.dev'", args: [sqlTime(NOW), new Date(NOW).toISOString()] });
  assert.ok(!(await screenshotsDue(db, { now: NOW + 60000, limit: 10, active: ACTIVE })).includes("https://forced.dev"));
  assert.ok(!(await linksDue(db, { now: NOW + 60000, limit: 10, active: ACTIVE })).some((r) => r.url === "https://forced.dev"));
});

test("screenshots: a failed refresh waits out its backoff unless someone asked again after it", async () => {
  const db = await freshDb();
  await addSite(db, "https://waits.dev", { captured: NOW - 95 * DAY });
  await addSite(db, "https://asked.dev", { captured: NOW - 95 * DAY });
  for (const url of ["https://waits.dev", "https://asked.dev"]) {
    await db.execute({ sql: "INSERT INTO refresh_failures (url, attempts, failed_at, retry_at) VALUES (?, 1, ?, ?)", args: [url, NOW - DAY, NOW + 5 * DAY] });
  }
  await markForced(db, "https://asked.dev", { now: NOW - HOUR });
  assert.deepEqual(await screenshotsDue(db, { now: NOW, limit: 10, active: ACTIVE }), ["https://asked.dev"]);
  assert.deepEqual(await screenshotsDue(db, { now: NOW + 5 * DAY, limit: 10, active: ACTIVE }), ["https://asked.dev", "https://waits.dev"]);
});

test("markForced keeps an old row's other columns and only sets forced_at", async () => {
  const db = await freshDb();
  await oldChangeRow(db, "https://a.dev", NOW - DAY);
  await markForced(db, "https://a.dev", { now: NOW });
  const row = await readFreshness(db, "https://a.dev");
  assert.equal(Number(row.forced_at), NOW);
  assert.equal(Number(row.changed_at), NOW - DAY, "no data is dropped");
});

test("the hourly page fingerprints are gone: no cron task, no worker module, no switch", () => {
  assert.ok(!Object.values(SCHEDULED_TASKS).flat().includes("freshness"));
  assert.ok(!existsSync("worker/freshness.ts"));
  assert.ok(!existsSync("lib/freshness-flag.ts"));
  assert.doesNotMatch(readFileSync("worker/index.ts", "utf8"), /freshness/i);
  const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
  assert.equal(config.vars.FRESHNESS_ENABLED, undefined);
});
