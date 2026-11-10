// PortfolioRank's own cleanup: roster sync and purge (pipeline/roster.mjs),
// the health check and its state machine (pipeline/health.mjs), exclusions
// (pipeline/exclusions.mjs) and the feed shrink guard (generate_feed.py).
// No network: fetch and the browser are stand-ins; the database is a
// throwaway local file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { httpGate, parkingPhrase } from "../pipeline/gate.mjs";
import {
  ACTIVE,
  captureRetryAt,
  dueForCapture,
  ensureRosterSchema,
  MIN_ROSTER,
  purgeDelisted,
  syncRoster,
} from "../pipeline/roster.mjs";
import {
  checkSite,
  DOWN_AFTER_DAYS,
  FAILS_TO_DOWN,
  findDuplicates,
  healthSummary,
  nextHealth,
  registrableDomain,
  runHealthCheck,
} from "../pipeline/health.mjs";
import { kindOf, planExclusions } from "../pipeline/exclusions.mjs";

const DAY = 86400000;

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
  return { dir, db: createClient({ url: `file:${path.join(dir, "db.sqlite")}` }) };
}

const roster = (n, prefix = "https://site") =>
  Array.from({ length: n }, (_, i) => ({ name: `Person Number${i}`, url: `${prefix}${i}.example` }));

// A fetch stand-in: url -> { status, url?, body } | Error.
function fakeFetch(map) {
  return async (url) => {
    const r = typeof map === "function" ? map(url) : map[url];
    if (!r) throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      url: r.url ?? url,
      text: async () => r.body ?? "",
    };
  };
}
const page = (title, text) => `<html><head><title>${title}</title></head><body><p>${text}</p></body></html>`;
const portfolioPage = (name) => page(`${name} - Developer`, `Hi, I'm ${name}. ${"I build things for the web. ".repeat(5)}`);

// ---------------------------------------------------------------------------
// roster

test("syncRoster delists rows that left the feed, with the date, and restores them when they return", async () => {
  const { db } = tempDb();
  const feed = roster(MIN_ROSTER);
  await ensureRosterSchema(db);
  for (const u of [feed[0].url, feed[1].url, "https://gone.example"]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [u] });
  }
  const now = new Date("2026-11-10T00:00:00Z");
  assert.deepEqual(await syncRoster(db, feed, { now }), { delisted: 1, relisted: 0, listed: 2 });
  const gone = (await db.execute("SELECT delisted_at FROM portfolios WHERE url = 'https://gone.example'")).rows[0];
  assert.equal(gone.delisted_at, now.toISOString());
  // Idempotent.
  assert.deepEqual(await syncRoster(db, feed, { now }), { delisted: 0, relisted: 0, listed: 2 });
  // Re-listed.
  const back = [...feed, { name: "Back", url: "https://gone.example" }];
  assert.equal((await syncRoster(db, back, { now })).relisted, 1);
  const row = (await db.execute("SELECT delisted_at FROM portfolios WHERE url = 'https://gone.example'")).rows[0];
  assert.equal(row.delisted_at, null);
});

test("syncRoster refuses a feed that is too small to be real", async () => {
  const { db } = tempDb();
  await assert.rejects(syncRoster(db, roster(10)), /refusing a roster of 10/);
  await assert.rejects(syncRoster(db, []), /refusing/);
});

test("ensureRosterSchema is additive and idempotent on an existing table", async () => {
  const { db } = tempDb();
  await db.execute("CREATE TABLE portfolios (url TEXT PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, shot_key TEXT, meta TEXT, checked_at TEXT, captured_at TEXT)");
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://a.example', 'live')");
  await ensureRosterSchema(db);
  await ensureRosterSchema(db);
  const cols = (await db.execute("PRAGMA table_info(portfolios)")).rows.map((r) => r.name);
  for (const c of ["delisted_at", "health", "health_fails", "retry_at", "capture_attempts", "final_url"]) assert.ok(cols.includes(c), c);
  const row = (await db.execute("SELECT status, health_fails FROM portfolios")).rows[0];
  assert.equal(row.status, "live");
  assert.equal(row.health_fails, 0);
});

test("purgeDelisted deletes screenshots and rows after 30 days, keeps votes and ratings", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  await db.execute("CREATE TABLE votes (winner TEXT, loser TEXT)");
  await db.execute("CREATE TABLE ratings (url TEXT PRIMARY KEY, elo INTEGER)");
  const now = new Date("2026-12-20T00:00:00Z");
  const old = new Date(now - 31 * DAY).toISOString();
  const recent = new Date(now - 5 * DAY).toISOString();
  for (let i = 0; i < 20; i++) {
    await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, status) VALUES (?, ?, 'live')", args: [`https://keep${i}.example`, `k${i}`] });
  }
  await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES ('https://old.example', 'oldkey', ?)", args: [old] });
  await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES ('https://recent.example', 'recentkey', ?)", args: [recent] });
  await db.execute("INSERT INTO votes VALUES ('https://old.example', 'https://keep0.example')");
  await db.execute("INSERT INTO ratings VALUES ('https://old.example', 1250)");
  await db.execute({ sql: "INSERT INTO cache VALUES ('psi:https://old.example', '{}', 1)" });
  const deleted = [];
  const r = await purgeDelisted(db, { now, deleteShots: async (k) => deleted.push(k), log: () => {} });
  assert.deepEqual(r, { due: 1, purged: 1, failed: 0 });
  assert.deepEqual(deleted, ["oldkey"]);
  const urls = (await db.execute("SELECT url FROM portfolios")).rows.map((x) => x.url);
  assert.ok(!urls.includes("https://old.example"));
  assert.ok(urls.includes("https://recent.example"));
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM votes")).rows[0].n, 1);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM ratings")).rows[0].n, 1);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM cache")).rows[0].n, 0);
});

test("purgeDelisted keeps a row whose screenshots could not be deleted, and refuses a mass purge", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const now = new Date("2026-12-20T00:00:00Z");
  const old = new Date(now - 40 * DAY).toISOString();
  for (let i = 0; i < 9; i++) await db.execute({ sql: "INSERT INTO portfolios (url) VALUES (?)", args: [`https://k${i}.example`] });
  await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES ('https://x.example', 'x', ?)", args: [old] });
  const r = await purgeDelisted(db, { now, deleteShots: async () => { throw new Error("R2 down"); }, log: () => {} });
  assert.deepEqual(r, { due: 1, purged: 0, failed: 1 });
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://x.example'")).rows[0].n, 1);
  // 3 of 10 due (30% > 20%): refused, nothing deleted.
  for (const u of ["https://y.example", "https://z.example"]) {
    await db.execute({ sql: "INSERT INTO portfolios (url, delisted_at) VALUES (?, ?)", args: [u, old] });
  }
  await assert.rejects(purgeDelisted(db, { now, deleteShots: async () => {} }), /refusing/);
});

test("capture retries back off: 1, 2, 4, 8, 16, then 30 days", () => {
  const now = new Date("2026-11-10T00:00:00Z");
  const days = [1, 2, 3, 4, 5, 6, 9].map((a) => (new Date(captureRetryAt(a, now)) - now) / DAY);
  assert.deepEqual(days, [1, 2, 4, 8, 16, 30, 30]);
});

test("dueForCapture: new sites and failures whose backoff ran out; never captured, delisted or down ones", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const now = new Date("2026-11-10T00:00:00Z");
  const past = new Date(now - DAY).toISOString();
  const future = new Date(now.getTime() + DAY).toISOString();
  await db.batch([
    "INSERT INTO portfolios (url, status) VALUES ('https://captured.example', 'live')",
    { sql: "INSERT INTO portfolios (url, status, retry_at) VALUES ('https://retry-now.example', 'error', ?)", args: [past] },
    { sql: "INSERT INTO portfolios (url, status, retry_at) VALUES ('https://retry-later.example', 'error', ?)", args: [future] },
    "INSERT INTO portfolios (url, status) VALUES ('https://legacy-error.example', 'error')",
    "INSERT INTO portfolios (url, status) VALUES ('https://pending.example', 'pending')",
    { sql: "INSERT INTO portfolios (url, status, retry_at, health) VALUES ('https://down.example', 'dead', ?, 'down')", args: [past] },
  ]);
  const entries = ["captured", "retry-now", "retry-later", "legacy-error", "pending", "down", "new"].map((n) => ({
    url: `https://${n}.example`,
  }));
  const due = (await dueForCapture(db, entries, now)).map((e) => e.url);
  assert.deepEqual(due, ["https://retry-now.example", "https://pending.example", "https://new.example"]);
});

// ---------------------------------------------------------------------------
// gate

test("parking phrases count only in the title or on a nearly empty page", () => {
  assert.equal(parkingPhrase({ html: page("Buy this domain", "") }), "buy this domain");
  assert.equal(parkingPhrase({ html: page("Parked", "This domain is for sale. Make an offer.") }), "this domain is for sale");
  // A real portfolio that mentions a phrase in its content (2026-11-10 false positives).
  const long = page("Jane Doe - Engineer", `I built a domain parking detector. ${"Lots of real portfolio content. ".repeat(60)}`);
  assert.equal(parkingPhrase({ html: long }), undefined);
});

test("httpGate: 404 is dead, DNS failure is dead, 5xx and timeouts are retryable errors", async () => {
  assert.equal((await httpGate("https://a.example", { fetchImpl: fakeFetch({ "https://a.example": { status: 404 } }) })).status, "dead");
  assert.equal((await httpGate("https://nx.example", { fetchImpl: fakeFetch({}) })).status, "dead");
  assert.equal((await httpGate("https://b.example", { fetchImpl: fakeFetch({ "https://b.example": { status: 503 } }) })).status, "error");
  const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
  assert.deepEqual(
    (await httpGate("https://c.example", { fetchImpl: fakeFetch({ "https://c.example": timeout }) })).status,
    "error"
  );
});

// ---------------------------------------------------------------------------
// health

test("registrableDomain treats shared hosts and two-level suffixes as public", () => {
  assert.equal(registrableDomain("https://me.vercel.app/x"), "me.vercel.app");
  assert.equal(registrableDomain("www.jane.co.uk"), "jane.co.uk");
  assert.equal(registrableDomain("https://blog.jane.dev"), "jane.dev");
  assert.equal(registrableDomain("a.b.github.io"), "b.github.io");
});

test("checkSite: a live page passes; dead, parked and blank pages fail", async () => {
  const site = { name: "Jane Doe", url: "https://jane.dev" };
  const ok = await checkSite(site, { fetchImpl: fakeFetch({ "https://jane.dev": { status: 200, body: portfolioPage("Jane Doe") } }) });
  assert.equal(ok.ok, true);
  const dead = await checkSite(site, { fetchImpl: fakeFetch({ "https://jane.dev": { status: 404 } }) });
  assert.deepEqual([dead.ok, dead.reason], [false, "HTTP 404"]);
  const parked = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://jane.dev": { status: 200, url: "https://www.hugedomains.com/domain_profile.cfm?d=jane.dev" } }),
  });
  assert.deepEqual([parked.ok, parked.reason], [false, "redirects to hugedomains.com"]);
  // Blank over HTTP and in the browser.
  const blank = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://jane.dev": { status: 200, body: "<div id=root></div>" } }),
    render: async () => ({ status: 200, finalUrl: "https://jane.dev/", title: "", text: "" }),
  });
  assert.deepEqual([blank.ok, blank.reason], [false, "renders blank"]);
});

test("checkSite: a single-page app with no server text passes once the browser renders it", async () => {
  const r = await checkSite(
    { name: "Jane Doe", url: "https://jane.dev" },
    {
      fetchImpl: fakeFetch({ "https://jane.dev": { status: 200, body: "<div id=root></div><script src=app.js></script>" } }),
      render: async () => ({ status: 200, finalUrl: "https://jane.dev/", title: "Jane", text: "Jane Doe, engineer. Projects, writing and contact." }),
    }
  );
  assert.equal(r.ok, true);
});

test("checkSite: a cold start (503) is retried and confirmed by the browser before failing", async () => {
  let calls = 0;
  const r = await checkSite(
    { name: "Ben", url: "https://ben.onrender.com" },
    {
      fetchImpl: fakeFetch(() => (calls++, { status: 503 })),
      render: async () => ({ status: 200, finalUrl: "https://ben.onrender.com/", title: "Ben", text: "Ben builds backend systems and writes about them." }),
    }
  );
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
});

test("checkSite: a sleeping free-tier app gets a second look before it counts as down", async () => {
  const statuses = [503, 200];
  const r = await checkSite(
    { name: "Ben", url: "https://beno.onrender.com" },
    {
      fetchImpl: fakeFetch({ "https://beno.onrender.com": { status: 503 } }),
      coldStartWaitMs: 0,
      render: async () => {
        const status = statuses.shift();
        return { status, finalUrl: "https://beno.onrender.com/", title: "Ben", text: status === 200 ? "Ben builds backend systems and APIs." : "Application loading" };
      },
    }
  );
  assert.equal(r.ok, true);
});

test("checkSite: a canvas app (Flutter web) with no DOM text is not blank", async () => {
  const r = await checkSite(
    { name: "Abdul Wahab Khan", url: "https://wahab-khan.github.io/Abdul-Wahab-Khan" },
    {
      fetchImpl: fakeFetch({ "https://wahab-khan.github.io/Abdul-Wahab-Khan": { status: 200, body: "<title>Abdul Wahab Khan</title><script src=main.dart.js></script>" } }),
      render: async () => ({ status: 200, finalUrl: "https://wahab-khan.github.io/Abdul-Wahab-Khan/", title: "Abdul Wahab Khan", text: "", media: true }),
    }
  );
  assert.equal(r.ok, true);
});

test("checkSite: bot walls (403/429 challenges) are inconclusive, not failures", async () => {
  const site = { name: "Scott Spence", url: "https://scottspence.com" };
  const r = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://scottspence.com": { status: 403 } }),
    render: async () => ({ status: 403, finalUrl: "https://scottspence.com/", title: "Just a moment...", text: "" }),
  });
  assert.equal(r.ok, null);
  assert.match(r.reason, /bot check/);
  const vercel = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://scottspence.com": { status: 429 } }),
    render: async () => ({ status: 200, finalUrl: "https://scottspence.com/", title: "Vercel Security Checkpoint", text: "x" }),
  });
  assert.equal(vercel.ok, null);
});

test("checkSite: a move to another domain passes and is reported; an unrelated target is flagged; LinkedIn fails", async () => {
  const moved = await checkSite(
    { name: "Aarab Nishchal", url: "https://aarab.vercel.app" },
    { fetchImpl: fakeFetch({ "https://aarab.vercel.app": { status: 200, url: "https://www.aarab.me/", body: portfolioPage("Aarab Nishchal") } }) }
  );
  assert.deepEqual([moved.ok, moved.moved, moved.hijack], [true, true, false]);
  const odd = await checkSite(
    { name: "Aarab Nishchal", url: "https://aarab.vercel.app" },
    { fetchImpl: fakeFetch({ "https://aarab.vercel.app": { status: 200, url: "https://casino.example/", body: page("Best slots", "Win big today. ".repeat(10)) } }) }
  );
  assert.deepEqual([odd.ok, odd.hijack], [true, true]);
  const li = await checkSite(
    { name: "Jane Doe", url: "https://jane.dev" },
    { fetchImpl: fakeFetch({ "https://jane.dev": { status: 200, url: "https://www.linkedin.com/in/jane", body: portfolioPage("Jane Doe") } }) }
  );
  assert.deepEqual([li.ok, li.reason], [false, "redirects to linkedin.com, not a portfolio"]);
});

test("findDuplicates keeps the first entry for the same URL or the same final URL", () => {
  const d = findDuplicates([
    { url: "https://a.dev", finalUrl: "https://a.dev/" },
    { url: "https://www.a.dev/" },
    { url: "https://b.vercel.app", finalUrl: "https://b.dev/" },
    { url: "https://b.dev", finalUrl: "https://b.dev/" },
  ]);
  assert.deepEqual([...d], [["https://www.a.dev/", "https://a.dev"], ["https://b.dev", "https://b.vercel.app"]]);
});

test(`state machine: down only after ${FAILS_TO_DOWN} failed checks spanning ${DOWN_AFTER_DAYS}+ days; a pass recovers`, () => {
  const t0 = new Date("2026-11-01T00:00:00Z");
  const at = (days) => new Date(t0.getTime() + days * DAY);
  const fail = { ok: false, reason: "HTTP 404" };
  let s = nextHealth(null, fail, at(0));
  assert.deepEqual([s.health, s.fails], ["suspect", 1]);
  // Three failures in two days (manual runs) are still only suspect.
  s = nextHealth(s, fail, at(1));
  s = nextHealth(s, fail, at(2));
  assert.deepEqual([s.health, s.fails], ["suspect", 3]);
  // Weekly cadence: day 0, 7, 14 -> down.
  let w = nextHealth(null, fail, at(0));
  w = nextHealth(w, fail, at(7));
  assert.equal(w.health, "suspect");
  w = nextHealth(w, fail, at(14));
  assert.deepEqual([w.health, w.fails, w.firstFailAt], ["down", 3, at(0).toISOString()]);
  // A bot wall leaves the state alone.
  const same = nextHealth(w, { ok: null, reason: "blocked by a bot check" }, at(21));
  assert.deepEqual([same.health, same.fails], ["down", 3]);
  // Passing recovers.
  assert.deepEqual(nextHealth(w, { ok: true }, at(21)), { health: "live", fails: 0, firstFailAt: null, reason: "" });
});

test("runHealthCheck records states, schedules a recapture for recovered failed captures, and flags not-a-portfolio", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const feed = [
    { name: "Alice Able", url: "https://alice.dev" },
    { name: "Bob Bee", url: "https://bob.dev" },
    { name: "Cara Cee", url: "https://cara.dev" },
  ];
  await db.execute("INSERT INTO portfolios (url, status, retry_at) VALUES ('https://alice.dev', 'error', NULL)");
  await db.execute(`INSERT INTO portfolios (url, status, ai_rubric) VALUES ('https://cara.dev', 'live', '{"is_portfolio":false,"tier":"D"}')`);
  const now = new Date("2026-11-10T00:00:00Z");
  const fetchImpl = fakeFetch({
    "https://alice.dev": { status: 200, body: portfolioPage("Alice Able") },
    "https://bob.dev": { status: 404 },
    "https://cara.dev": { status: 200, body: portfolioPage("Cara Cee") },
  });
  const s = await runHealthCheck({ db, feed, fetchImpl, now, log: () => {} });
  assert.equal(s.aborted, false);
  assert.deepEqual([s.live, s.suspect], [1, 2]);
  const rows = Object.fromEntries(
    (await db.execute("SELECT url, health, health_reason, retry_at FROM portfolios")).rows.map((r) => [r.url, r])
  );
  assert.equal(rows["https://alice.dev"].health, "live");
  assert.equal(rows["https://alice.dev"].retry_at, now.toISOString());
  assert.deepEqual([rows["https://bob.dev"].health, rows["https://bob.dev"].health_reason], ["suspect", "HTTP 404"]);
  assert.match(rows["https://cara.dev"].health_reason, /not a portfolio/);
  assert.match(healthSummary(s), /1 live, 2 suspect/);
});

test("runHealthCheck records nothing when most sites fail at once (the runner, not the sites)", async () => {
  const { db } = tempDb();
  const feed = roster(25);
  const s = await runHealthCheck({ db, feed, fetchImpl: fakeFetch({}), log: () => {} });
  assert.equal(s.aborted, true);
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM portfolios")).rows[0].n, 0);
  assert.match(healthSummary(s), /FAILED/);
});

test("ACTIVE() keeps delisted and down rows out of background jobs", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  await db.batch([
    "INSERT INTO portfolios (url) VALUES ('https://ok.example')",
    "INSERT INTO portfolios (url, health) VALUES ('https://suspect.example', 'suspect')",
    "INSERT INTO portfolios (url, health) VALUES ('https://down.example', 'down')",
    "INSERT INTO portfolios (url, delisted_at) VALUES ('https://gone.example', '2026-11-01')",
  ]);
  const urls = (await db.execute(`SELECT url FROM portfolios WHERE ${ACTIVE()} ORDER BY url`)).rows.map((r) => r.url);
  assert.deepEqual(urls, ["https://ok.example", "https://suspect.example"]);
});

// ---------------------------------------------------------------------------
// exclusions

test("planExclusions adds confirmed-down listed sites with evidence and drops them from the feed", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const feed = roster(30);
  await db.execute({
    sql: `INSERT INTO portfolios (url, health, health_reason, health_fails, health_first_fail_at, health_checked_at)
          VALUES (?, 'down', 'HTTP 404', 3, '2026-11-01T16:00:00Z', '2026-11-15T16:00:00Z')`,
    args: [feed[3].url],
  });
  await db.execute({ sql: "INSERT INTO portfolios (url, health, health_reason) VALUES (?, 'down', 'duplicate of x')", args: [feed[4].url] });
  // Already excluded (legacy string form): not added twice.
  await db.execute({ sql: "INSERT INTO portfolios (url, health) VALUES (?, 'down')", args: [feed[5].url] });
  const plan = await planExclusions({ db, excluded: [feed[5].url], feed, now: new Date("2026-11-15T17:00:00Z") });
  assert.equal(plan.added.length, 2);
  assert.deepEqual(plan.added[0], {
    url: feed[3].url,
    name: feed[3].name,
    reason: "HTTP 404",
    kind: "down",
    removed: "2026-11-15",
    first_failed: "2026-11-01T16:00:00Z",
    last_checked: "2026-11-15T16:00:00Z",
    checks: 3,
  });
  assert.equal(plan.added[1].kind, "duplicate");
  assert.equal(plan.excluded.length, 3);
  assert.equal(plan.feed.length, 28);
  assert.ok(!plan.feed.some((p) => p.url === feed[3].url));
});

test("planExclusions refuses to exclude more than 10% of the list at once", async () => {
  const { db } = tempDb();
  await ensureRosterSchema(db);
  const feed = roster(20);
  for (const p of feed.slice(0, 3)) await db.execute({ sql: "INSERT INTO portfolios (url, health) VALUES (?, 'down')", args: [p.url] });
  await assert.rejects(planExclusions({ db, excluded: [], feed }), /refusing/);
});

test("kindOf maps reasons to removal kinds", () => {
  assert.equal(kindOf("HTTP 404"), "down");
  assert.equal(kindOf("duplicate of https://a.dev"), "duplicate");
  assert.equal(kindOf("AI grading says this is not a portfolio"), "not_portfolio");
});

// ---------------------------------------------------------------------------
// generate_feed.py

test("generate_feed.py honors object exclusions and refuses to shrink the feed by more than --max-shrink", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  const readme = path.join(dir, "README.md");
  const out = path.join(dir, "feed.json");
  const excl = path.join(dir, "excluded.json");
  const lines = Array.from({ length: 100 }, (_, i) => `- [Person ${i}](https://p${i}.example) [Dev]`);
  fs.writeFileSync(readme, lines.join("\n"));
  fs.writeFileSync(excl, JSON.stringify([{ url: "https://p1.example", reason: "HTTP 404", kind: "down" }, "https://p2.example/"]));
  execFileSync("python3", ["pipeline/generate_feed.py", readme, out, "--exclude", excl, "--max-shrink", "0.05"]);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).length, 98);
  // Upstream suddenly lists 80: refused, the old feed stays.
  fs.writeFileSync(readme, lines.slice(0, 80).join("\n"));
  const r = spawnSync("python3", ["pipeline/generate_feed.py", readme, out, "--exclude", excl, "--max-shrink", "0.05"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /refusing to write/);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).length, 98);
  // 95 of 98 is within 5%.
  fs.writeFileSync(readme, lines.slice(0, 97).join("\n"));
  execFileSync("python3", ["pipeline/generate_feed.py", readme, out, "--exclude", excl, "--max-shrink", "0.05"]);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).length, 95);
});
