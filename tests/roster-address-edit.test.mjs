// When the community list respells a site, no history is ever lost: the old
// row is delisted but never purged while its key is listed, and every roster
// sync counts the split. One key rule (pipeline/list-key.mjs, exactly the
// health check's normKey); guards against a list that rewrites its addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { dueForCapture, ensureRosterSchema, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { listKey, splitSites } from "../pipeline/list-key.mjs";
import { CLEANUP_SHARE_ENV, allowedShare } from "../pipeline/list-util.mjs";
import { buildFeed, refuseFeed } from "../pipeline/build-feed.mjs";
import { normKey } from "../pipeline/health.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "respell-"));
async function freshDb() {
  const db = createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` });
  await ensureRosterSchema(db);
  return db;
}
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const liveRows = (db, entries) => db.batch(entries.map((p) => ({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] })), "write");
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("listKey is exactly the health check's normKey, on a generated table of addresses", () => {
  const schemes = ["https://", "http://", "HTTPS://", ""];
  const hosts = ["x.dev", "WWW.X.dev", "www.x.dev:443", "x.dev:8080", "bücher.de", "user.github.io"];
  const paths = ["", "/", "/a//", "/José", "/JOSÉ", "/jos%C3%A9", "/jos%c3%a9", "/a b", "/{x}", "/A/index.html", "/p/../q", "/%2F%2f", "/ä/Ö/"];
  const tails = ["", "?utm_source=x", "?id=1#/alice", "#Home", "  "];
  let checked = 0;
  for (const s of schemes) for (const h of hosts) for (const p of paths) for (const t of tails) {
    const url = `${s}${h}${p}${t}`;
    assert.equal(listKey(url), normKey(url), url);
    checked++;
  }
  for (const odd of ["mailto:a@b.c", "", "not a url", "https://", "javascript:alert(1)"]) assert.equal(listKey(odd), normKey(odd), odd);
  assert.ok(checked > 1000);
  // Upper and lower case are one site, also outside ASCII.
  assert.equal(listKey("https://x.dev/JOSÉ"), listKey("https://x.dev/josé"));
  assert.equal(listKey("https://x.dev/jos%C3%A9"), listKey("https://x.dev/jos%c3%a9"));
});

test("the build keeps one entry per key (first wins), as upstream spells it; an exclusion keeps every spelling out", () => {
  const r = buildFeed({
    entries: [
      { name: "Ann", url: "https://ann.dev/?utm_source=github" },
      { name: "Ann again", url: "http://www.ANN.dev/" },
      { name: "Gone", url: "https://gone.dev/en" },
      { name: "Gone root", url: "https://gone.dev/#home" },
      { name: "X", url: "https://x.dev/" },
    ],
    excluded: [{ url: "https://www.gone.dev/", kind: "owner_request" }, { url: "https://x.dev/?lang=en", kind: "owner_request" }],
  });
  assert.deepEqual(r.feed, [{ name: "Ann", url: "https://ann.dev/?utm_source=github" }, { name: "Gone", url: "https://gone.dev/en" }]);
  assert.deepEqual([r.dupes, r.excludedHits], [1, 2]);
});

test("generate_feed.py writes upstream's spelling and refuses a data file that is not a list", () => {
  const dir = tmp();
  const file = (f) => path.join(dir, f);
  fs.writeFileSync(file("README.md"), "- [Ann](https://ann.dev) [Developer]\n- [Ann](https://ann.dev/) [Developer]\n");
  fs.writeFileSync(file("excluded.json"), "[]");
  const run = () => spawnSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), file("README.md"), file("feed.json"), "--exclude", file("excluded.json")], { encoding: "utf8", env: { ...process.env, [CLEANUP_SHARE_ENV]: "" } });
  assert.equal(run().status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file("feed.json"), "utf8")), [{ name: "Ann", url: "https://ann.dev", tagline: "Developer" }]);
  fs.writeFileSync(file("excluded.json"), JSON.stringify({ url: "https://ann.dev" }));
  const bad = run();
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /not a JSON list/);
});

test("the build refuses a feed that drops more than 15% of the current addresses; the owner's share only raises a limit", () => {
  const previous = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev/` }));
  const rewritten = previous.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  const mix = (k) => rewritten.map((p, i) => (i < k ? p : previous[i]));
  assert.match(refuseFeed(previous, rewritten, { env: {} }), /100 of the current 100 addresses are gone/);
  assert.equal(refuseFeed(previous, mix(15), { env: {} }), null);
  assert.match(refuseFeed(previous, mix(16), { env: {} }), /16 of the current 100/);
  assert.equal(refuseFeed(previous, rewritten, { env: { [CLEANUP_SHARE_ENV]: "1" } }), null);
  assert.match(refuseFeed(previous, previous.slice(0, 90), { maxShrink: 0.05, env: {} }), /90 entries, 10 fewer/);
  assert.equal(allowedShare(0.15, { [CLEANUP_SHARE_ENV]: "0.08" }), 0.15);
  assert.equal(allowedShare(0.05, { [CLEANUP_SHARE_ENV]: "0.08" }), 0.08);
  assert.throws(() => allowedShare(0.15, { [CLEANUP_SHARE_ENV]: "lots" }), /not a share/);
});

test("a mass delist fails only the job that owns the sync; any other job warns, leaves the roster as it is, and carries on", async () => {
  const db = await freshDb();
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const mix = (k) => feed.map((p, i) => (i < k ? { name: `Q${i}`, url: `https://other${i}.dev` } : p));
  await assert.rejects(syncRoster(db, mix(91), { now: NOW, owner: true }), new RegExp(`91 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  const logs = [];
  assert.deepEqual(await syncRoster(db, mix(91), { now: NOW, owner: false, log: (m) => logs.push(m) }), { delisted: 0, relisted: 0, listed: 509, split: 0, skipped: true });
  assert.match(logs.join("\n"), /::warning::syncRoster: 91 of 600.*leaves the roster as it is/s);
  assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM portfolios WHERE delisted_at IS NOT NULL")).rows[0].n), 0);
  // The owner is the nightly sync workflow (GITHUB_WORKFLOW), or ROSTER_SYNC_OWNER=1.
  await withEnv({ GITHUB_WORKFLOW: "Sync upstream + ingest" }, () => assert.rejects(syncRoster(db, mix(91), { now: NOW }), /refusing/));
  await withEnv({ GITHUB_WORKFLOW: "Health check", ROSTER_SYNC_OWNER: "" }, async () => assert.equal((await syncRoster(db, mix(91), { now: NOW, log: () => {} })).skipped, true));
  await withEnv({ [CLEANUP_SHARE_ENV]: "0.2" }, async () => assert.equal((await syncRoster(db, mix(91), { now: NOW, owner: true })).delisted, 91));
});

test("a respelled site's old row is never purged, and every sync counts the split, respelled-twice and unclear groups apart", async () => {
  const db = await freshDb();
  await liveRows(db, fillers());
  const graded = (url) => db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric) VALUES (?, 'live', 'k', '{\"tier\":\"A\"}')", args: [url] });
  for (const u of ["https://ann.dev/", "https://bob.github.io/portfolio", "http://cat.dev", "https://dan.dev/?game", "https://two.dev"]) await graded(u);
  const night = async (sites, at) => {
    const feed = [...fillers(), ...sites.map((url) => ({ name: url, url }))];
    const summary = path.join(tmp(), "summary.md");
    const r = await withEnv({ GITHUB_STEP_SUMMARY: summary }, () => syncRoster(db, feed, { now: at, owner: true }));
    for (const p of await dueForCapture(db, feed)) await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [p.url] });
    return { r, summary: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "" };
  };
  await night(["https://ann.dev/", "https://bob.github.io/portfolio", "http://cat.dev", "https://dan.dev/?game", "https://two.dev"], NOW);
  // Slash, path case, http to https, a query dropped; two.dev respelled twice.
  await night(["https://ann.dev", "https://bob.github.io/Portfolio", "https://cat.dev", "https://dan.dev/", "https://www.two.dev"], new Date(NOW.getTime() + DAY));
  const last = ["https://ann.dev", "https://bob.github.io/Portfolio", "https://cat.dev", "https://dan.dev/", "http://two.dev/"];
  await night(last, new Date(NOW.getTime() + 2 * DAY));
  // The new spelling's row is made by that night's capture, after the sync: the next sync counts the split.
  const { r, summary } = await night(last, new Date(NOW.getTime() + 3 * DAY));
  assert.equal(r.split, 5);
  assert.match(summary, /### Split sites waiting for a merge: 5\n[\s\S]*- https:\/\/ann\.dev\/ -> https:\/\/ann\.dev\n/);
  assert.match(summary, /Respelled more than once \(1\):\n- https:\/\/two\.dev, https:\/\/www\.two\.dev -> http:\/\/two\.dev\//);
  for (const days of [31, 400]) {
    const logs = [];
    await purgeDelisted(db, { now: new Date(NOW.getTime() + days * DAY), excluded: [], deleteShots: async () => {}, log: (m) => logs.push(m) });
    assert.match(logs.join("\n"), /kept https:\/\/ann\.dev\/: its site is listed under another address/);
  }
  for (const u of ["https://ann.dev/", "https://bob.github.io/portfolio", "http://cat.dev", "https://dan.dev/?game", "https://two.dev", "https://www.two.dev"]) {
    const row = (await db.execute({ sql: "SELECT ai_rubric, delisted_at FROM portfolios WHERE url = ?", args: [u] })).rows[0];
    assert.ok(row && row.delisted_at, `${u}: kept, delisted`);
  }
  // A site we took off the list (data/excluded.json) is still purged.
  await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES ('https://gone.dev', 'kg', ?)", args: [NOW.toISOString()] });
  const deleted = [];
  await purgeDelisted(db, { now: new Date(NOW.getTime() + 31 * DAY), excluded: [{ url: "https://gone.dev", kind: "dead" }], deleteShots: async (k) => deleted.push(k), log: () => {} });
  assert.deepEqual(deleted, ["kg"]);
  // Two listed rows for one key are reported as unclear.
  assert.deepEqual(splitSites([{ url: "https://e.dev", delistedAt: null }, { url: "https://e.dev/", delistedAt: null }, { url: "http://e.dev", delistedAt: "x" }]).unclear.length, 1);
});
