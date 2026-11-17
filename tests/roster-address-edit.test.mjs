// When the community list respells a site (a trailing slash, www, http, upper
// case, a dropped query), no history is ever lost: the old row is delisted
// but never purged while its key is listed, every nightly sync counts the
// split, and scripts/repair-respelled-sites.mjs merges it by hand. One key rule
// (pipeline/list-key.mjs); guards against a list that rewrites its addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { dueForCapture, ensureRosterSchema, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { listKey } from "../pipeline/list-key.mjs";
import { CLEANUP_SHARE_ENV, allowedShare } from "../pipeline/list-util.mjs";
import { buildFeed, refuseFeed } from "../pipeline/build-feed.mjs";
import { normKey } from "../pipeline/health.mjs";
import { planOwnerRemovals } from "../pipeline/owner-removals.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";
import { LEFT_AS_IS, MOVED_COLUMNS, NO_SITE_ADDRESS, SITE_TABLES, StalePlan, applyMove, gradeRank, planMove, schemaOf } from "../pipeline/site-move.mjs";
import { siteKeyOf } from "../lib/grader/url.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { migrate } from "../lib/schema.mjs";
import { MEMBER_TRIGGERS } from "../lib/tiers-db.mjs";
import { releaseLock, repairRespelled, takeLock } from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const quiet = () => {};
const SQLD = process.env.SQLD_BIN ?? path.join(os.homedir(), ".turso", "sqld");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "respell-"));
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
async function setup(db, { full = true } = {}) {
  if (full) {
    await migrate(db);
    for (const sql of MEMBER_TRIGGERS) await db.execute(sql);
  }
  await ensureRosterSchema(db);
  return db;
}
const freshDb = (opts) => setup(createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` }), opts);
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const n = async (db, sql, args = []) => Number((await one(db, sql, args)).n);
async function dump(db) {
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map((r) => String(r.name));
  const out = {};
  for (const t of tables) out[t] = await all(db, `SELECT * FROM "${t}"`);
  return JSON.stringify(out);
}
const GRADE = '{"is_portfolio":true,"tier":"A","model":"m1"}';
async function gradedRow(db, url, { shot = "kold", delisted = null } = {}) {
  await db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric, delisted_at) VALUES (?, 'live', ?, ?, ?)", args: [url, shot, GRADE, delisted] });
}
const liveRows = (db, entries) => db.batch(entries.map((p) => ({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] })), "write");

// ---------------------------------------------------------------------------
// One key rule

test("listKey agrees with the health check's normKey on every address in data/ and the edge cases, and with the app's siteKeyOf", () => {
  const data = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  const urls = [
    ...data("feed.json").map((p) => p.url),
    ...data("additions.json").map((p) => p.url),
    ...data("excluded.json").map((e) => (typeof e === "string" ? e : e.url)),
    "https://ann.dev/", "https://www.ann.dev", "http://ann.dev", "https://ANN.dev/", "https://ann.dev:443/", "https://ann.dev/?utm_source=x",
    "https://ann.dev/#home", "https://host.dev/#/alice", "https://ann.github.io/Portfolio/", "https://straße.de/", "  https://x.dev/a//  ",
    "https://x.dev/index.html", "https://ghomkrosmonaute.github.io/?game", "http://vedant.byethost31.com/portfolio.html?i=1",
  ];
  for (const u of urls) {
    assert.equal(listKey(u), normKey(u), `normKey: ${u}`);
    assert.equal(listKey(u), siteKeyOf(u.trim()), `siteKeyOf: ${u}`);
  }
  // One entry per key on the list, so the app's maps keyed by siteKeyOf (lib/me.ts, lib/tools/server.ts) see each site once.
  const feed = data("feed.json");
  assert.equal(new Set(feed.map((p) => siteKeyOf(p.url))).size, feed.length);
});

test("the build keeps one entry per key (first wins), as upstream spells it, and an exclusion keeps every spelling out", () => {
  const r = buildFeed({
    entries: [
      { name: "Ann", url: "https://ann.dev/?utm_source=github" },
      { name: "Ann again", url: "http://www.ANN.dev/" },
      { name: "Gone", url: "https://gone.dev/en" },
      { name: "Gone root", url: "https://gone.dev:443/#home" },
      { name: "X", url: "https://x.dev/" },
    ],
    excluded: [{ url: "https://www.gone.dev/", kind: "owner_request" }, { url: "https://x.dev/?lang=en", kind: "owner_request" }],
  });
  assert.deepEqual(r.feed, [
    { name: "Ann", url: "https://ann.dev/?utm_source=github" },
    { name: "Gone", url: "https://gone.dev/en" },
  ]);
  assert.deepEqual([r.dupes, r.excludedHits], [1, 2]);
});

test("generate_feed.py writes upstream's spelling, and refuses a data file that is not a list", () => {
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

test("the build refuses a feed that drops more than 15% of the current addresses, before any pull request; the owner's share only raises it", async () => {
  const previous = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev/` }));
  const rewritten = previous.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  assert.match(refuseFeed(previous, rewritten, { env: {} }), /100 of the current 100 addresses are gone/);
  assert.equal(refuseFeed(previous, rewritten.map((p, i) => (i < 15 ? p : previous[i])), { env: {} }), null);
  assert.match(refuseFeed(previous, rewritten.map((p, i) => (i < 16 ? p : previous[i])), { env: {} }), /16 of the current 100/);
  assert.equal(refuseFeed(previous, rewritten, { env: { [CLEANUP_SHARE_ENV]: "1" } }), null);
  assert.match(refuseFeed(previous, previous.slice(0, 90), { maxShrink: 0.05, env: {} }), /90 entries, 10 fewer/);
  assert.equal(allowedShare(0.15, { [CLEANUP_SHARE_ENV]: "0.08" }), 0.15);
  assert.equal(allowedShare(0.05, { [CLEANUP_SHARE_ENV]: "0.08" }), 0.08);
  assert.throws(() => allowedShare(0.15, { [CLEANUP_SHARE_ENV]: "lots" }), /not a share/);
});

test("syncRoster refuses to delist more than 15% of the list at once (the second line behind the build)", async () => {
  const db = await freshDb({ full: false });
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const mix = (k) => feed.map((p, i) => (i < k ? { name: `Q${i}`, url: `https://other${i}.dev` } : p));
  await assert.rejects(syncRoster(db, mix(91), { now: NOW }), new RegExp(`91 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  await withEnv({ [CLEANUP_SHARE_ENV]: "0.08" }, async () => assert.equal((await syncRoster(db, mix(90), { now: NOW })).delisted, 90));
});

test("owner removals and review relists use the same key: a dropped query is the same site", () => {
  assert.deepEqual(planOwnerRemovals({ removals: [{ url: "https://x.dev/", removedAt: "2026-11-16" }], excluded: [], feed: [{ name: "X", url: "https://x.dev/?game" }] }).feed, []);
  assert.equal(planReviewAdditions({ relists: [{ url: "https://www.x.dev", name: "X" }], additions: [], excluded: [], feed: [{ name: "X", url: "https://x.dev/?game" }] }).added.length, 0);
});

// ---------------------------------------------------------------------------
// The lifecycle: split, never purged, counted, merged by hand

async function siteWithHistory(db, url, i) {
  await gradedRow(db, url, { shot: `shot${i}` });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES (?, 'https://filler-1.dev', ?, 'human', ?)", args: [url, [url, "https://filler-1.dev"].sort().join("\n"), `r${i}`] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1216, 1)", args: [url] });
  await db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', 'verified', 't', '2026-10-01', '2026-10-01')", args: [url, `o${i}`] });
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)", args: [`r${i}`, url] });
  await db.execute({ sql: "INSERT INTO lists (owner, name, slug) VALUES (?, 'Faves', ?)", args: [`r${i}`, `faves-${i}`] });
  await db.execute({ sql: "INSERT INTO list_items (list_id, url) VALUES ((SELECT id FROM lists WHERE slug = ?), ?)", args: [`faves-${i}`, url] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, wins, member, seeded) VALUES (?, 27.5, 6, 9.5, 3, 4, 3, 1, 1)", args: [url] });
  await db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES ('merged', ?, ?, 27.5, 6, 'high')", args: [url, i + 1] });
}

test("after every upstream edit the old row is delisted, never purged and counted; the repair then merges each into one listed row with all its history", async () => {
  const db = await freshDb();
  await liveRows(db, fillers());
  const sites = {
    slash: ["https://ann.dev/", "https://ann.dev"],
    pathCase: ["https://bob.github.io/portfolio", "https://bob.github.io/Portfolio"],
    www: ["https://www.cat.dev", "https://cat.dev"],
    https: ["http://dan.dev", "https://dan.dev"],
    query: ["https://ghom.github.io/?game", "https://ghom.github.io/"],
    readded: ["https://fay.dev", "https://www.fay.dev/"],
    lifted: ["https://gil.dev", "http://gil.dev/"],
    additions: ["https://hal.dev", "https://HAL.dev/?utm_source=x"],
  };
  const names = Object.keys(sites);
  for (const [i, k] of names.entries()) await siteWithHistory(db, sites[k][0], i);
  const spelled = Object.fromEntries(names.map((k) => [k, sites[k][0]]));
  const summary = path.join(tmp(), "summary.md");
  const night = async ({ drop = [], excluded = [], additions = [], at = NOW } = {}) => {
    const entries = [...fillers(), ...names.filter((k) => !drop.includes(k)).map((k) => ({ name: k, url: spelled[k] }))];
    const { feed } = buildFeed({ entries, excluded, additions });
    fs.writeFileSync(summary, "");
    const r = await withEnv({ GITHUB_STEP_SUMMARY: summary }, () => syncRoster(db, feed, { now: at }));
    // Capture: every entry with no row gets one, as a new site.
    for (const p of await dueForCapture(db, feed)) await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [p.url] });
    return { feed, r };
  };
  const neverPurged = async () => {
    for (const days of [31, 400]) await purgeDelisted(db, { now: new Date(NOW.getTime() + days * DAY), deleteShots: async () => {}, log: quiet });
    for (const k of names) assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [sites[k][0]]), 1, `${k}: the old row is never purged`);
  };
  await night();
  // Upstream edits; one site removed upstream, one excluded, one only in our additions later.
  for (const k of ["slash", "pathCase", "www", "https", "query"]) spelled[k] = sites[k][1];
  await night({ drop: ["readded", "additions"], excluded: [{ url: "https://gil.dev", kind: "down" }] });
  await night({ drop: ["readded", "additions"], excluded: [{ url: "https://gil.dev", kind: "down" }] });
  for (const k of ["readded", "lifted", "additions"]) spelled[k] = sites[k][1];
  const { feed } = await night({ drop: ["additions"], additions: [{ name: "additions", url: spelled.additions, source: "review" }] });
  for (const k of names) {
    assert.ok((await one(db, "SELECT delisted_at FROM portfolios WHERE url = ?", [sites[k][0]])).delisted_at, `${k}: old row delisted`);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ? AND delisted_at IS NULL", [spelled[k]]), 1, `${k}: new row listed`);
  }
  await night({ drop: ["additions"], additions: [{ name: "additions", url: spelled.additions, source: "review" }] });
  assert.match(fs.readFileSync(summary, "utf8"), /### Split sites waiting for a merge: 8\n[\s\S]*- https:\/\/ann\.dev\/ -> https:\/\/ann\.dev\n/);
  await neverPurged();
  // The repair, with main's feed (the feed the nights built).
  let recomputed = 0;
  const r = await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => recomputed++ });
  assert.deepEqual(r.failed, []);
  assert.equal(r.merged.length, 8);
  assert.equal(recomputed, 0, "the new rows had no tier or leaderboard rows: nothing to recompute");
  for (const [i, k] of names.entries()) {
    const rows = (await all(db, "SELECT url FROM portfolios")).map((x) => String(x.url)).filter((u) => sites[k].includes(u));
    assert.deepEqual(rows, [spelled[k]], `${k}: one row`);
    const row = await one(db, `SELECT delisted_at, ai_rubric, shot_key, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, [spelled[k]]);
    assert.deepEqual([row.delisted_at, row.ai_rubric, row.shot_key, Number(row.hidden)], [null, GRADE, `shot${i}`, 0], `${k}: listed, graded, screenshots, visible`);
    for (const [t, c] of [["votes", "winner"], ["ratings", "url"], ["claims", "url"], ["likes", "url"], ["list_items", "url"], ["site_ratings", "url"]]) {
      assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [spelled[k]]), 1, `${k}: ${t}`);
    }
    const tier = await one(db, "SELECT mu, faceoffs, member FROM tier_ratings WHERE url = ?", [spelled[k]]);
    assert.deepEqual([tier.mu, tier.faceoffs, tier.member], [27.5, 4, 1], `${k}: tier row, a library member again`);
  }
  assert.equal((await syncRoster(db, feed, { now: NOW })).split, 0);
});

// ---------------------------------------------------------------------------
// The merge, table by table

test("every table in the schema is either moved, left on purpose, or holds no site address", async () => {
  const db = await freshDb();
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  const lists = [Object.keys(SITE_TABLES), Object.keys(LEFT_AS_IS), NO_SITE_ADDRESS];
  for (const t of tables) assert.equal(lists.filter((l) => l.includes(t)).length, 1, `table ${t}: add it to exactly one list in pipeline/site-move.mjs`);
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => /^(url|urls|winner|loser|portfolio_url|item|shown|ranking)$/.test(c)), [], `${t} has an address column`);
  }
});

test("every unique constraint on a moved column survives a clash: the listed row's stays, nothing is left behind", async () => {
  const db = await freshDb();
  const schema = await schemaOf(db);
  const [O, N] = ["https://ann.dev/", "https://ann.dev"];
  await gradedRow(db, O, { delisted: "2026-11-01T00:00:00Z" });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'pending')", args: [N] });
  const clashing = [];
  for (const [t, c] of MOVED_COLUMNS) {
    const s = schema.get(t);
    if (!s.unique.some((u) => u.has(c))) continue;
    const info = (await db.execute(`PRAGMA table_info(${t})`)).rows;
    const pk = info.filter((r) => Number(r.pk) > 0);
    const auto = pk.length === 1 && /INT/i.test(String(pk[0].type)) ? [String(pk[0].name)] : [];
    for (const u of s.unique) assert.ok(u.has(c) || [...u].every((x) => auto.includes(x)), `${t}: a unique constraint without ${c}`);
    const cols = info.filter((r) => (Number(r.notnull) === 1 || Number(r.pk) > 0) && r.dflt_value == null && !auto.includes(String(r.name))).map((r) => String(r.name));
    if (!cols.includes(c)) cols.push(c);
    const typeOf = (x) => String(info.find((r) => String(r.name) === x).type);
    for (const url of [O, N]) await db.execute({ sql: `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((x) => (x === c ? url : /INT|REAL/i.test(typeOf(x)) ? 1 : "x")) });
    clashing.push(`${t}.${c}`);
  }
  assert.ok(["status_reviews.url", "likes.url", "rank_history.url", "list_items.url"].every((t) => clashing.includes(t)), clashing.join(", "));
  assert.deepEqual((await repairRespelled(db, [{ name: "Ann", url: N }], { write: true, log: quiet })).failed, []);
  for (const tc of clashing) {
    const [t, c] = tc.split(".");
    assert.deepEqual([await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [O]), await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [N])], [0, 1], tc);
  }
});

test("a merge keeps the better grade (a real one over an error) and the live capture, decided apart; the other grade goes to history", async () => {
  const REAL = (tier) => JSON.stringify({ tier, is_portfolio: true, model: "m" });
  const ERR = JSON.stringify({ error: "gemini 503" });
  const NOT = JSON.stringify({ tier: "C", is_portfolio: false });
  const cases = [
    { cur: [ERR, true], old: [REAL("A"), false], grade: REAL("A"), shot: "knew", history: ERR },
    { cur: [REAL("B"), false], old: [ERR, true], grade: REAL("B"), shot: "kold", history: ERR },
    { cur: [null, false], old: [REAL("A"), true], grade: REAL("A"), shot: "kold", history: null },
    { cur: [REAL("B"), true], old: [REAL("A"), true], grade: REAL("B"), shot: "knew", history: REAL("A") },
    { cur: [NOT, true], old: [REAL("A"), true], grade: REAL("A"), shot: "knew", history: NOT },
  ];
  for (const c of cases) {
    const db = await freshDb();
    const insert = (url, [grade, live], shot, delisted) =>
      db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric, delisted_at) VALUES (?, ?, ?, ?, ?)", args: [url, live ? "live" : "error", shot, grade, delisted] });
    await insert("https://ann.dev/", c.old, "kold", "2026-11-01");
    await insert("https://ann.dev", c.cur, "knew", null);
    assert.deepEqual((await repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }], { write: true, log: quiet })).failed, []);
    const row = await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = 'https://ann.dev'");
    assert.deepEqual([row.shot_key, row.ai_rubric], [c.shot, c.grade], JSON.stringify(c));
    assert.deepEqual((await all(db, "SELECT url, rubric FROM rubric_history")).map((h) => [h.url, h.rubric]), c.history ? [["https://ann.dev", c.history]] : [], JSON.stringify(c));
  }
  assert.deepEqual([gradeRank(null), gradeRank(ERR), gradeRank(NOT), gradeRank(REAL("A"))], [0, 1, 2, 3]);
});

async function splitSite(db) {
  const [O, N] = ["https://ann.dev/", "https://ann.dev"];
  await gradedRow(db, O, { delisted: "2026-11-01T00:00:00Z" });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'pending')", args: [N] });
  for (const u of ["https://a.dev", "https://b.dev"]) await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [u] });
  const vote = (w, l, rater, starred = 0) => db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES (?, ?, ?, 'human', ?, ?)", args: [w, l, [w, l].sort().join("\n"), rater, starred] });
  await vote(O, "https://a.dev", "r1", 1);
  await vote("https://b.dev", N, "r3");
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1260, 2), (?, 1190, 1)", args: [O, N] });
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, 1, '2026-10-01')", args: [O] });
  await db.execute({ sql: "INSERT INTO comparisons (created_at, rater_type, method, ranking) VALUES ('2026-10-01', 'ai', 'one_on_one', ?)", args: [JSON.stringify([O, "https://a.dev"])] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, member, seeded) VALUES (?, 25, 8, 1, 1, 0, 1), (?, 24, 8, 1, 1, 0, 1)", args: [O, N] });
  const feed = [{ name: "Ann", url: N }, { name: "A", url: "https://a.dev" }, { name: "B", url: "https://b.dev" }];
  return { O, N, feed };
}

test("a merge of two rated rows keeps everything, is a library member at once, and does not finish without the recompute", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const before = await dump(db);
  assert.equal((await repairRespelled(db, feed, { log: quiet })).merged.length, 1);
  assert.equal(await dump(db), before, "a dry run changes nothing");
  const logs = [];
  const r = await repairRespelled(db, feed, { write: true, log: (m) => logs.push(m) });
  assert.ok(r.needsRecompute && !r.recomputed);
  assert.match(logs.join("\n"), /NOT DONE YET: .*node scripts\/recompute-ratings\.mjs && node scripts\/refresh-tiers\.mjs/);
  assert.deepEqual(Object.values(await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = ?", [N])), ["kold", GRADE]);
  assert.deepEqual((await all(db, "SELECT winner, pair_key FROM votes ORDER BY id")).map((v) => [v.winner, v.pair_key]), [[N, [N, "https://a.dev"].sort().join("\n")], ["https://b.dev", [N, "https://b.dev"].sort().join("\n")]]);
  assert.deepEqual(await all(db, "SELECT url, elo, votes FROM ratings"), [{ url: N, elo: 1250, votes: 3 }]);
  assert.deepEqual(await all(db, "SELECT url, n FROM star_counts WHERE n > 0"), [{ url: N, n: 1 }]);
  assert.deepEqual(Object.values(await one(db, "SELECT url, hide_grade FROM portfolio_owner")), [N, 1]);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.deepEqual(await all(db, "SELECT url, member FROM tier_ratings"), [{ url: N, member: 1 }]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
  const script = spawnSync(process.execPath, [path.join(ROOT, "scripts", "repair-respelled-sites.mjs"), "--write", "--feed", "x.json"], { encoding: "utf8" });
  assert.deepEqual([script.status, /--feed is for dry runs only/.test(script.stderr)], [2, true]);
});

test("a merge drops only a moved vote that duplicates one of the listed row, or of the site against itself, and takes the points back", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const vote = (w, l, rater, delta, pair = [w, l].sort().join("\n")) => db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta) VALUES (?, ?, ?, 'ai', ?, ?)", args: [w, l, pair, rater, delta] });
  await vote(O, "https://a.dev", "ai", 10);
  await vote(N, "https://a.dev", "ai", 8);
  await vote(O, N, "ai", 6);
  await vote(O, "https://b.dev", "local", 4, null);
  await vote(O, "https://b.dev", "local", 4, null);
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 24, votes = votes + 4 WHERE url = ?", args: [O] });
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 2, votes = votes + 2 WHERE url = ?", args: [N] });
  await db.execute("INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1182, 2)");
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet })).failed, []);
  const votes = await all(db, "SELECT winner, loser, rater_id FROM votes ORDER BY id");
  assert.ok(votes.every((v) => v.winner !== v.loser));
  assert.deepEqual(votes.filter((v) => v.rater_id === "ai").length, 1);
  assert.equal(votes.filter((v) => v.rater_id === "local").length, 2, "old duplicates from one side stay");
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [N])).elo, 1266);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = 'https://a.dev'")).elo, 1192);
});

test("star counts are left to the votes triggers; recounted only where the triggers are missing", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  const schema = await schemaOf(db);
  assert.ok(!(await planMove(db, { from: O, to: N }, { schema })).statements.some((s) => /star_counts/.test(s.sql)));
  schema.triggers.delete("votes_star_update");
  assert.ok((await planMove(db, { from: O, to: N }, { schema })).statements.some((s) => /INSERT INTO star_counts/.test(s.sql)));
});

test("a merge keeps the stronger claim when an owner claimed both addresses", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const claim = (url, owner, status) => db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', ?, 't', '2026-10-01', '2026-10-01')", args: [url, owner, status] });
  await claim(O, "u1", "verified");
  await claim(N, "u1", "pending");
  await claim(O, "u2", "pending");
  await claim(N, "u2", "verified");
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet })).failed, []);
  assert.deepEqual((await all(db, "SELECT owner, status FROM claims ORDER BY owner")).map((c) => [c.owner, c.status]), [["u1", "verified"], ["u2", "verified"]]);
});

test("a stale plan or a failing statement changes nothing; a failed pair is reported and the run goes on; two runs never overlap", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  const schema = await schemaOf(db);
  // A vote cast after the plan: the guard skips the pair, nothing written.
  const stale = await planMove(db, { from: O, to: N }, { schema });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, rater_id) VALUES (?, 'https://b.dev', 'late')", args: [O] });
  const withLate = await dump(db);
  await assert.rejects(applyMove(db, stale), StalePlan);
  assert.equal(await dump(db), withLate);
  const plan = await planMove(db, { from: O, to: N }, { schema });
  const before = withLate;
  // Interrupted at any statement: nothing written.
  for (let at = 0; at <= plan.statements.length; at += 4) {
    await assert.rejects(applyMove(db, { ...plan, statements: [...plan.statements.slice(0, at), { sql: "INSERT INTO no_such_table VALUES (1)", args: [] }, ...plan.statements.slice(at)] }));
    assert.equal(await dump(db), before, `interrupted at ${at}`);
  }
  // One pair fails, the other merges.
  await gradedRow(db, "https://bob.dev/", { shot: "kb", delisted: "2026-11-01" });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://bob.dev', 'pending')");
  await db.execute("CREATE TRIGGER no_bob BEFORE DELETE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const r = await repairRespelled(db, [{ name: "Bob", url: "https://bob.dev" }, { name: "Ann", url: N }], { write: true, log: quiet });
  assert.deepEqual(r.failed.map((f) => f.from), ["https://bob.dev/"]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://bob.dev/'"), 1);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
  await takeLock(db);
  await assert.rejects(repairRespelled(db, [], { write: true, log: quiet }), /another repair is running/);
  await releaseLock(db);
});

test("a group that is not one delisted and one listed row is left alone", async () => {
  const db = await freshDb();
  await gradedRow(db, "https://two.dev/", { delisted: "2026-11-01" });
  await gradedRow(db, "http://two.dev", { delisted: "2026-11-01" });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://two.dev', 'live')");
  const r = await repairRespelled(db, [{ name: "Two", url: "https://two.dev" }], { log: quiet });
  assert.deepEqual([r.merged, r.unclear.map((u) => u.length)], [[], [3]]);
});

// ---------------------------------------------------------------------------
// A remote libSQL server

function assertStrictArgs(statements) {
  for (const s of statements) {
    const numbered = [...s.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const plain = (s.sql.replace(/\?\d+/g, "").match(/\?/g) ?? []).length;
    const want = numbered.length ? Math.max(...numbered) : plain;
    assert.ok(!(numbered.length && plain), s.sql);
    assert.equal((s.args ?? []).length, want, s.sql.replace(/\s+/g, " "));
  }
}

test("every statement binds exactly the arguments it uses (a remote server refuses extra ones)", async () => {
  const db = await freshDb();
  const { feed } = await splitSite(db);
  const strict = {
    execute: (s) => (typeof s === "object" && assertStrictArgs([s]), db.execute(s)),
    batch: (stmts, mode) => (assertStrictArgs(stmts.filter((s) => typeof s === "object")), db.batch(stmts, mode)),
  };
  const r = await repairRespelled(strict, feed, { write: true, log: quiet, recompute: async () => {} });
  assert.deepEqual([r.failed, r.merged.length], [[], 1]);
});

test("the repair runs against a real libSQL server (sqld)", { skip: !fs.existsSync(SQLD) && `no sqld at ${SQLD}` }, async () => {
  const port = 18000 + Math.floor(Math.random() * 900);
  const child = spawn(SQLD, ["--db-path", path.join(tmp(), "db"), "--http-listen-addr", `127.0.0.1:${port}`], { stdio: "ignore" });
  try {
    const db = createClient({ url: `http://127.0.0.1:${port}` });
    for (let i = 0; i < 80; i++) {
      try {
        await db.execute("SELECT 1");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    await setup(db);
    const { O, N, feed } = await splitSite(db);
    assert.deepEqual((await repairRespelled(db, feed, { log: quiet })).failed, []);
    const r = await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} });
    assert.deepEqual(r.failed, []);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
    assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = ?", [N])).shot_key, "kold");
  } finally {
    child.kill();
  }
});
