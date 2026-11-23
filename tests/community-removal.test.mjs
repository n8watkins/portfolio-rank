// A site the community list drops stays on our list (owner, 2026-11-22: "a
// community list remove shouldnt change anything on our side"). The feed build
// (pipeline/build-feed.mjs) carries it forward and records it in
// data/additions.json (source LEFT_LIST, the day it left), so only our own
// machinery takes a site off: the health check, data/excluded.json and an
// owner's removal through the claim process. The purge deletes only what we
// removed (pipeline/roster.mjs purgeDelisted).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { LEFT_LIST, buildFeed, refuseFeed } from "../pipeline/build-feed.mjs";
import { isWebAddress, listKey } from "../pipeline/list-key.mjs";
import { ensureRosterSchema, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { CLEANUP_SHARE_ENV } from "../pipeline/list-util.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DAY = 86400000;
const NOW = new Date("2026-11-22T04:30:00Z");
const TODAY = "2026-11-22";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "community-removal-"));
const fillers = Array.from({ length: 520 }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const ann = { name: "Ann", url: "https://ann.dev", tagline: "Designer" };

test("a site the community list drops stays on the feed, recorded with the day it left", () => {
  const r = buildFeed({ entries: fillers, current: [...fillers, ann], today: TODAY });
  assert.deepEqual(r.feed.at(-1), ann);
  assert.equal(r.feed.length, fillers.length + 1);
  const record = { ...ann, source: LEFT_LIST, left_on: TODAY };
  assert.deepEqual(r.stayed, [record]);
  assert.deepEqual(r.additions, [record]);
  assert.equal(refuseFeed([...fillers, ann], r.feed, { maxShrink: 0.05, stayed: r.stayed.length, env: {} }), null);
});

test("the record is durable: the next nights keep the site and its first day, and our own additions are untouched", () => {
  const review = { name: "Rev", url: "https://rev.dev", source: "review" };
  const night1 = buildFeed({ entries: fillers, current: [...fillers, ann, review], additions: [review], today: TODAY });
  const night2 = buildFeed({ entries: fillers, current: night1.feed, additions: night1.additions, today: "2026-11-23" });
  assert.deepEqual(night2.feed, night1.feed);
  assert.deepEqual(night2.additions, [review, { ...ann, source: LEFT_LIST, left_on: TODAY }]);
  assert.deepEqual(night2.stayed, []);
  // Even if something took it out of feed.json, the record lists it again.
  const night3 = buildFeed({ entries: fillers, current: fillers, additions: night2.additions, today: "2026-11-24" });
  assert.ok(night3.feed.some((p) => p.url === ann.url));
});

test("our own exclusions still remove: a dead, duplicate or not-a-portfolio site, and an owner's removal, are never carried", () => {
  for (const kind of ["dead", "down", "duplicate", "not_portfolio", "owner_request"]) {
    const excluded = [{ url: "https://www.ann.dev/", kind, reason: kind, removed: TODAY }];
    const r = buildFeed({ entries: fillers, current: [...fillers, ann], excluded, today: TODAY });
    assert.ok(!r.feed.some((p) => listKey(p.url) === listKey(ann.url)), kind);
    assert.deepEqual(r.stayed, [], kind);
    assert.deepEqual(r.additions, [], kind);
  }
  // A recorded site excluded later stays out while the exclusion stands, and the record waits (an undone owner removal brings it back).
  const additions = [{ ...ann, source: LEFT_LIST, left_on: "2026-11-01" }];
  const owner = buildFeed({ entries: fillers, current: [...fillers, ann], additions, excluded: [{ url: ann.url, kind: "owner_request" }], today: TODAY });
  assert.ok(!owner.feed.some((p) => p.url === ann.url));
  assert.deepEqual(owner.additions, additions);
  const undone = buildFeed({ entries: fillers, current: fillers, additions, today: TODAY });
  assert.ok(undone.feed.some((p) => p.url === ann.url));
});

test("a respelled site is the same site: its old spelling is not carried, so it is listed once", () => {
  const cases = [
    // Path case: one list key, two spelling keys; the list's new spelling is listed and the old row retired, as before.
    ["https://bob.github.io/Portfolio", "https://bob.github.io/portfolio"],
    // An encoded path: one spelling key, two list keys.
    ["https://x.dev/caf%C3%A9", "https://x.dev/café"],
    // Sticky spelling: the feed keeps its own.
    ["https://www.cat.dev/", "https://cat.dev"],
  ];
  for (const [was, now] of cases) {
    const r = buildFeed({ entries: [...fillers, { name: "N", url: now }], current: [...fillers, { name: "N", url: was }], today: TODAY });
    assert.equal(r.feed.length, fillers.length + 1, was);
    assert.deepEqual(r.stayed, [], was);
  }
});

test("a malformed README line read as an address by an older parser is not carried", () => {
  const bad = ["<[Portfolio-Link](https://khushm.netlify.app", "https\\://shreyanshportfolio.in", "abass.wanecrea.com", "mailto:a@b.c", ""];
  for (const url of bad) assert.equal(isWebAddress(url), false, url);
  for (const url of ["https://ann.dev", "http://www.x.co.uk/a/b?c=d#e", "https://akshayabraham.vercel.app?utm_source=github&utm_campaign=dev_portfolios\""]) assert.equal(isWebAddress(url), true, url);
  const current = [...fillers, ...bad.filter(Boolean).map((url) => ({ name: "Bad", url }))];
  const r = buildFeed({ entries: fillers, current, today: TODAY });
  assert.deepEqual(r.feed, fillers);
  assert.deepEqual(r.stayed, []);
  assert.deepEqual(r.notAddresses, bad.filter(Boolean));
});

test("a recorded site back on the community list is listed once, as the feed spells it, and leaves the record", () => {
  const additions = [{ ...ann, source: LEFT_LIST, left_on: "2026-11-10" }, { name: "Rev", url: "https://rev.dev", source: "review" }];
  for (const back of ["https://ann.dev", "https://www.ann.dev/", "http://ANN.dev"]) {
    const r = buildFeed({ entries: [...fillers, { name: "Ann", url: back, tagline: "New tagline" }], current: [...fillers, ann, additions[1]], additions, today: TODAY });
    assert.deepEqual(r.feed.filter((p) => listKey(p.url) === listKey(ann.url)), [{ name: "Ann", url: ann.url, tagline: "New tagline" }], back);
    assert.deepEqual(r.returned, [ann.url], back);
    assert.deepEqual(r.additions, [additions[1]], back);
  }
  // It can leave again later: a new record with that day.
  const again = buildFeed({ entries: fillers, current: [...fillers, ann], additions: [], today: "2026-12-01" });
  assert.deepEqual(again.additions, [{ ...ann, source: LEFT_LIST, left_on: "2026-12-01" }]);
});

test("the guards: a README cut short or rewritten is refused instead of filling the record; the owner's share allows a real cleanup", () => {
  const previous = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev/` }));
  const cut = buildFeed({ entries: previous.slice(0, 94), current: previous, today: TODAY });
  // Nothing leaves the feed, so the shrink and drop guards alone would pass it.
  assert.equal(cut.feed.length, 100);
  assert.equal(refuseFeed(previous, cut.feed, { maxShrink: 0.05, stayed: cut.stayed.length, env: {} }).includes("6 of the current 100"), true);
  const few = buildFeed({ entries: previous.slice(0, 95), current: previous, today: TODAY });
  assert.equal(refuseFeed(previous, few.feed, { maxShrink: 0.05, stayed: few.stayed.length, env: {} }), null);
  assert.equal(refuseFeed(previous, cut.feed, { maxShrink: 0.05, stayed: cut.stayed.length, env: { [CLEANUP_SHARE_ENV]: "0.1" } }), null);
  // Without --max-shrink the 15% drop share applies.
  assert.match(refuseFeed(previous, cut.feed, { stayed: 16, env: {} }), /16 of the current 100/);
  assert.equal(refuseFeed(previous, cut.feed, { stayed: 15, env: {} }), null);
});

test("generate_feed.py, as the nightly sync runs it, keeps a dropped site and writes the record to data/additions.json", () => {
  const dir = tmp();
  const file = (f) => path.join(dir, f);
  const current = [...fillers, ann];
  fs.writeFileSync(file("feed.json"), JSON.stringify(current));
  fs.writeFileSync(file("excluded.json"), "[]");
  fs.writeFileSync(file("additions.json"), "[]\n");
  fs.writeFileSync(file("README.md"), fillers.map((p) => `- [${p.name}](${p.url})`).join("\n") + "\n");
  const run = () =>
    spawnSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), file("README.md"), file("feed.json"), "--exclude", file("excluded.json"), "--add", file("additions.json"), "--max-shrink", "0.05"], {
      encoding: "utf8",
      env: { ...process.env, [CLEANUP_SHARE_ENV]: "", GITHUB_STEP_SUMMARY: "" },
    });
  const first = run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /1 left the community list and stay/);
  const feed = JSON.parse(fs.readFileSync(file("feed.json"), "utf8"));
  assert.deepEqual(feed.at(-1), ann);
  const [record] = JSON.parse(fs.readFileSync(file("additions.json"), "utf8"));
  assert.equal(record.url, ann.url);
  assert.equal(record.source, LEFT_LIST);
  assert.match(record.left_on, /^\d{4}-\d{2}-\d{2}$/);
  // The next night changes nothing.
  const before = fs.readFileSync(file("additions.json"), "utf8");
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file("additions.json"), "utf8"), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(file("feed.json"), "utf8")), feed);
});

async function freshDb() {
  const db = createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` });
  await ensureRosterSchema(db);
  return db;
}

test("the roster sync delists nothing when the community list drops a site, and lists a recorded site again", async () => {
  const db = await freshDb();
  await db.batch([...fillers, ann].map((p) => ({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric) VALUES (?, 'live', 'k', '{\"tier\":\"A\"}')", args: [p.url] })), "write");
  const r = buildFeed({ entries: fillers, current: [...fillers, ann], today: TODAY });
  assert.deepEqual(await syncRoster(db, r.feed, { now: NOW, owner: true }), { delisted: 0, relisted: 0, listed: fillers.length + 1, split: 0, skipped: false });
  // A site delisted before this change, recorded by hand: listed again with its grade and screenshots.
  await db.execute({ sql: "UPDATE portfolios SET delisted_at = ? WHERE url = ?", args: ["2026-11-16T04:30:00.000Z", ann.url] });
  const back = buildFeed({ entries: fillers, current: fillers, additions: [{ ...ann, source: LEFT_LIST, left_on: "2026-11-16" }], today: TODAY });
  assert.equal((await syncRoster(db, back.feed, { now: NOW, owner: true })).relisted, 1);
  const row = (await db.execute({ sql: "SELECT delisted_at, status, shot_key, ai_rubric FROM portfolios WHERE url = ?", args: [ann.url] })).rows[0];
  assert.deepEqual({ ...row }, { delisted_at: null, status: "live", shot_key: "k", ai_rubric: '{"tier":"A"}' });
});

test("the purge deletes only what we removed: our exclusions and old spellings, never a site only because it left the list", async () => {
  const db = await freshDb();
  for (let i = 0; i < 40; i++) await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [`https://live${i}.dev`] });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES ('https://shreyanshportfolio.in', 'live')" });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES ('https://x.dev/café', 'live')" });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES ('https://bob.github.io/Portfolio', 'live')" });
  const old = new Date(NOW.getTime() - 40 * DAY).toISOString();
  const delisted = {
    "https://dropped.dev": "kd", // left the community list before this change: kept
    "https://dead.dev": "kx", // our exclusion (dead): purged
    "https://www.owner.dev/": "ko", // an owner's removal, another spelling of the entry: purged
    "https\\://shreyanshportfolio.in": "km", // not an address: purged
    "https://x.dev/caf%C3%A9": "kc", // an old spelling of a listed site: purged
    "https://bob.github.io/portfolio": "kb", // a split site (same list key as a listed row): kept until merged
  };
  for (const [url, key] of Object.entries(delisted)) await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES (?, ?, ?)", args: [url, key, old] });
  const excluded = [{ url: "https://dead.dev/", kind: "dead" }, { url: "https://owner.dev", kind: "owner_request" }];
  const deleted = [];
  const logs = [];
  const r = await purgeDelisted(db, { now: NOW, excluded, deleteShots: async (k) => deleted.push(k), log: (m) => logs.push(m) });
  assert.deepEqual(deleted.sort(), ["kc", "km", "ko", "kx"]);
  assert.deepEqual(r, { due: 4, purged: 4, failed: 0, notOurs: 1 });
  assert.match(logs.join("\n"), /kept https:\/\/dropped\.dev: .*not removed by us/);
  const left = (await db.execute("SELECT url FROM portfolios WHERE delisted_at IS NOT NULL ORDER BY url")).rows.map((x) => String(x.url));
  assert.deepEqual(left, ["https://bob.github.io/portfolio", "https://dropped.dev"]);
  await assert.rejects(purgeDelisted(db, { now: NOW, deleteShots: async () => {} }), /excluded/);
});

test("data: the 25 sites the community list removed before 2026-11-22 are recorded and back on the feed", () => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  const feed = new Set(read("feed.json").map((p) => p.url));
  const excluded = new Set(read("excluded.json").map((e) => listKey(typeof e === "string" ? e : e.url)));
  const record = read("additions.json").filter((a) => a.source === LEFT_LIST);
  assert.ok(record.length >= 25);
  for (const a of record) {
    assert.ok(isWebAddress(a.url), a.url);
    assert.match(a.left_on, /^\d{4}-\d{2}-\d{2}$/, a.url);
    assert.ok(String(a.name ?? "").trim(), a.url);
    assert.ok(feed.has(a.url) || excluded.has(listKey(a.url)), `${a.url} is on the feed`);
  }
  for (const url of ["https://aprameyak.vercel.app", "https://ccm.securityops.com.br", "https://www.sudevmagar.tech"]) assert.ok(record.some((a) => a.url === url), url);
});
