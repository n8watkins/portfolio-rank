// Merging split sites by hand (scripts/repair-respelled-sites.mjs, pipeline/site-move.mjs):
// each delisted row into the listed row with the same key, planned right before it is
// applied, one guarded transaction each, nothing of a site's history lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { dueForCapture, ensureRosterSchema, syncRoster } from "../pipeline/roster.mjs";
import { LEFT_AS_IS, MOVED_COLUMNS, NO_SITE_ADDRESS, SITE_TABLES, StalePlan, applyMove, gradeRank, planMove, schemaOf } from "../pipeline/site-move.mjs";
import { pairKey } from "../lib/ranking/matchmaking.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { migrate } from "../lib/schema.mjs";
import { MEMBER_TRIGGERS } from "../lib/tiers-db.mjs";
import { releaseLock, repairRespelled, takeLock } from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const NOW = new Date("2026-11-16T04:30:00Z");
const DAY = 86400000;
const quiet = () => {};
const SQLD = process.env.SQLD_BIN ?? path.join(os.homedir(), ".turso", "sqld");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
async function setup(db) {
  await migrate(db);
  for (const sql of MEMBER_TRIGGERS) await db.execute(sql);
  await ensureRosterSchema(db);
  return db;
}
const freshDb = () => setup(createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` }));
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const n = async (db, sql, args = []) => Number((await one(db, sql, args)).n);
async function dump(db) {
  const out = {};
  for (const t of (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map((r) => String(r.name))) out[t] = await all(db, `SELECT * FROM "${t}"`);
  return JSON.stringify(out);
}
const GRADE = '{"is_portfolio":true,"tier":"A","model":"m1"}';
const row = (db, url, { status = "live", shot = "kold", grade = GRADE, delisted = null } = {}) =>
  db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric, delisted_at) VALUES (?, ?, ?, ?, ?)", args: [url, status, shot, grade, delisted] });
const vote = (db, w, l, rater, delta = null, pair = pairKey(w, l)) =>
  db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta) VALUES (?, ?, ?, 'human', ?, ?)", args: [w, l, pair, rater, delta] });

async function splitSite(db) {
  const [O, N] = ["https://ann.dev/", "https://ann.dev"];
  await row(db, O, { delisted: "2026-11-01" });
  await row(db, N, { status: "pending", shot: null, grade: null });
  for (const u of ["https://a.dev", "https://b.dev"]) await row(db, u);
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES (?, 'https://a.dev', ?, 'human', 'r1', 1)", args: [O, pairKey(O, "https://a.dev")] });
  await vote(db, "https://b.dev", N, "r3");
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1260, 2), (?, 1190, 1)", args: [O, N] });
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, 1, '2026-10-01')", args: [O] });
  await db.execute({ sql: "INSERT INTO comparisons (created_at, rater_type, method, ranking) VALUES ('2026-10-01', 'ai', 'one_on_one', ?)", args: [JSON.stringify([O, "https://a.dev"])] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, member, seeded) VALUES (?, 25, 8, 1, 1, 0, 1), (?, 24, 8, 1, 1, 0, 1)", args: [O, N] });
  return { O, N, feed: [{ name: "Ann", url: N }, { name: "A", url: "https://a.dev" }, { name: "B", url: "https://b.dev" }] };
}

test("after upstream respellings, the repair merges every split site into one listed row with all its history and tier membership", async () => {
  const db = await freshDb();
  const fillers = Array.from({ length: 520 }, (_, i) => ({ name: `F${i}`, url: `https://filler-${i}.dev` }));
  await db.batch(fillers.map((p) => ({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] })), "write");
  const sites = [
    ["https://ann.dev/", "https://ann.dev"],
    ["https://bob.github.io/portfolio", "https://bob.github.io/Portfolio"],
    ["https://www.cat.dev", "https://cat.dev"],
    ["http://dan.dev", "https://dan.dev"],
    ["https://ghom.github.io/?game", "https://ghom.github.io/"],
  ];
  for (const [i, [old]] of sites.entries()) {
    await row(db, old, { shot: `shot${i}` });
    await vote(db, old, "https://filler-1.dev", `r${i}`, 8);
    await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1208, 1)", args: [old] });
    await db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', 'verified', 't', '2026-10-01', '2026-10-01')", args: [old, `o${i}`] });
    await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)", args: [`r${i}`, old] });
    await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, member, seeded) VALUES (?, 27.5, 6, 9.5, 3, 4, 1, 1)", args: [old] });
    await db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES ('merged', ?, ?, 27.5, 6, 'high')", args: [old, i + 1] });
  }
  const night = async (spelling, at) => {
    const feed = [...fillers, ...sites.map((s) => ({ name: s[0], url: s[spelling] }))];
    await syncRoster(db, feed, { now: at, owner: true });
    for (const p of await dueForCapture(db, feed)) await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [p.url] });
    return feed;
  };
  await night(0, NOW);
  const feed = await night(1, new Date(NOW.getTime() + DAY));
  assert.equal((await syncRoster(db, feed, { now: new Date(NOW.getTime() + 2 * DAY), owner: true })).split, 5);
  const r = await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => assert.fail("no recompute needed") });
  assert.deepEqual([r.failed, r.merged.length], [[], 5]);
  for (const [i, [old, now]] of sites.entries()) {
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [old]), 0);
    const x = await one(db, `SELECT delisted_at, ai_rubric, shot_key, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, [now]);
    assert.deepEqual([x.delisted_at, x.ai_rubric, x.shot_key, Number(x.hidden)], [null, GRADE, `shot${i}`, 0], now);
    for (const [t, c] of [["votes", "winner"], ["ratings", "url"], ["claims", "url"], ["likes", "url"], ["site_ratings", "url"]]) assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [now]), 1, `${now} ${t}`);
    assert.deepEqual(Object.values(await one(db, "SELECT mu, faceoffs, member FROM tier_ratings WHERE url = ?", [now])), [27.5, 4, 1], `${now} tier`);
  }
  assert.equal((await syncRoster(db, feed, { now: new Date(NOW.getTime() + 3 * DAY), owner: true })).split, 0);
});

test("two split sites whose old rows voted against each other: one vote per rater and pair, live pair keys, ratings that match the vote log", async () => {
  const db = await freshDb();
  const [O1, N1, O2, N2] = ["https://one.dev/", "https://one.dev", "https://two.dev/", "https://two.dev"];
  for (const u of [O1, O2]) await row(db, u, { delisted: "2026-11-01" });
  for (const u of [N1, N2]) await row(db, u, { status: "pending", shot: null, grade: null });
  await vote(db, O1, O2, "r", 10);
  await vote(db, N1, N2, "r", 8);
  await vote(db, O2, O1, "s", 6);
  // Ratings as the vote log made them.
  const fromLog = async () => {
    const elo = new Map();
    for (const v of await all(db, "SELECT winner, loser, delta FROM votes")) {
      elo.set(v.winner, (elo.get(v.winner) ?? 1200) + Number(v.delta));
      elo.set(v.loser, (elo.get(v.loser) ?? 1200) - Number(v.delta));
    }
    return elo;
  };
  for (const [u, e] of await fromLog()) await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, ?, 1)", args: [u, e] });
  const r = await repairRespelled(db, [{ name: "One", url: N1 }, { name: "Two", url: N2 }], { write: true, log: quiet });
  assert.deepEqual([r.failed, r.merged.length], [[], 2]);
  const votes = await all(db, "SELECT winner, loser, rater_id, pair_key FROM votes ORDER BY id");
  const pairs = votes.map((v) => `${v.rater_id}|${v.pair_key}`);
  assert.equal(new Set(pairs).size, pairs.length, "one vote per rater and pair");
  for (const v of votes) {
    assert.ok([N1, N2].includes(v.winner) && [N1, N2].includes(v.loser), "live addresses only");
    assert.equal(v.pair_key, pairKey(v.winner, v.loser));
  }
  const expected = await fromLog();
  for (const u of [N1, N2]) assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [u])).elo, expected.get(u), u);
});

test("a site respelled twice is merged oldest first; a key with two listed rows is left alone", async () => {
  const db = await freshDb();
  await row(db, "https://ann.dev", { delisted: "2026-10-01", shot: "k1" });
  await row(db, "https://www.ann.dev", { delisted: "2026-11-01", shot: "k2", grade: null, status: "error" });
  await row(db, "http://ann.dev/", { status: "pending", shot: null, grade: null });
  await row(db, "https://e.dev", {});
  await row(db, "https://e.dev/", {});
  await row(db, "http://e.dev", { delisted: "2026-11-01" });
  const r = await repairRespelled(db, [{ name: "Ann", url: "http://ann.dev/" }, { name: "E", url: "https://e.dev" }, { name: "E2", url: "https://e.dev/" }], { write: true, log: quiet });
  assert.deepEqual(r.merged.map((p) => p.from), ["https://ann.dev", "https://www.ann.dev"]);
  assert.deepEqual(r.unclear.map((u) => u.length), [3]);
  assert.deepEqual(Object.values(await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = 'http://ann.dev/'")), ["k1", GRADE]);
  // The second merge left k2 unused: recorded for a later clean-up, not deleted.
  assert.equal(JSON.parse((await one(db, "SELECT v FROM cache WHERE k = 'orphan-shot:k2'")).v).url, "https://www.ann.dev");
  assert.match(String(r.orphanShots), /k2/);
});

test("a merge of two rated rows keeps everything, is a library member at once, and does not finish without the recompute", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const before = await dump(db);
  assert.equal((await repairRespelled(db, feed, { log: quiet })).merged.length, 1);
  assert.equal(await dump(db), before, "a dry run changes nothing");
  const logs = [];
  const r = await repairRespelled(db, feed, { write: true, log: (m) => logs.push(m) });
  assert.ok(r.needsRecompute && !r.recomputed);
  assert.match(logs.join("\n"), /NOT DONE YET: .*recompute-ratings\.mjs && node scripts\/refresh-tiers\.mjs/);
  assert.deepEqual(Object.values(await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = ?", [N])), ["kold", GRADE]);
  assert.deepEqual(await all(db, "SELECT url, elo, votes FROM ratings"), [{ url: N, elo: 1250, votes: 3 }]);
  assert.deepEqual(await all(db, "SELECT url, n FROM star_counts WHERE n > 0"), [{ url: N, n: 1 }]);
  assert.deepEqual(Object.values(await one(db, "SELECT url, hide_grade FROM portfolio_owner")), [N, 1]);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.deepEqual(await all(db, "SELECT url, member FROM tier_ratings"), [{ url: N, member: 1 }]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
  const script = spawnSync(process.execPath, [path.join(ROOT, "scripts", "repair-respelled-sites.mjs"), "--write", "--feed", "x.json"], { encoding: "utf8" });
  assert.deepEqual([script.status, /--feed is for dry runs only/.test(script.stderr)], [2, true]);
});

test("the better grade stays; a real grade that does not goes to rubric_history, an error is dropped", async () => {
  const REAL = (tier) => JSON.stringify({ tier, is_portfolio: true, model: "m" });
  const ERR = JSON.stringify({ error: "gemini 503" });
  const NOT = JSON.stringify({ tier: "C", is_portfolio: false });
  const cases = [
    { cur: [ERR, true], old: [REAL("A"), false], grade: REAL("A"), shot: "knew", history: [] },
    { cur: [REAL("B"), false], old: [ERR, true], grade: REAL("B"), shot: "kold", history: [] },
    { cur: [REAL("B"), true], old: [REAL("A"), true], grade: REAL("B"), shot: "knew", history: [REAL("A")] },
    { cur: [NOT, true], old: [REAL("A"), true], grade: REAL("A"), shot: "knew", history: [NOT] },
  ];
  for (const c of cases) {
    const db = await freshDb();
    await row(db, "https://ann.dev/", { grade: c.old[0], status: c.old[1] ? "live" : "error", shot: "kold", delisted: "2026-11-01" });
    await row(db, "https://ann.dev", { grade: c.cur[0], status: c.cur[1] ? "live" : "error", shot: "knew" });
    assert.deepEqual((await repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }], { write: true, log: quiet })).failed, []);
    const x = await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = 'https://ann.dev'");
    assert.deepEqual([x.shot_key, x.ai_rubric], [c.shot, c.grade], JSON.stringify(c));
    assert.deepEqual((await all(db, "SELECT url, rubric FROM rubric_history")).map((h) => [h.url, h.rubric]), c.history.map((h) => ["https://ann.dev", h]), JSON.stringify(c));
  }
  assert.deepEqual([gradeRank(null), gradeRank(ERR), gradeRank(NOT), gradeRank(REAL("A"))], [0, 1, 2, 3]);
});

test("a merge drops only a moved vote that duplicates one of the listed row, or of the site against itself, and takes the points back", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  await vote(db, O, "https://a.dev", "ai", 10);
  await vote(db, N, "https://a.dev", "ai", 8);
  await vote(db, O, N, "ai", 6);
  await vote(db, O, "https://b.dev", "local", 4, null);
  await vote(db, O, "https://b.dev", "local", 4, null);
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 24, votes = votes + 4 WHERE url = ?", args: [O] });
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 2, votes = votes + 2 WHERE url = ?", args: [N] });
  await db.execute("INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1182, 2)");
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} })).failed, []);
  const votes = await all(db, "SELECT winner, loser, rater_id FROM votes ORDER BY id");
  assert.ok(votes.every((v) => v.winner !== v.loser));
  assert.equal(votes.filter((v) => v.rater_id === "ai").length, 1);
  assert.equal(votes.filter((v) => v.rater_id === "local").length, 2, "old duplicates from one side stay");
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [N])).elo, 1266);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = 'https://a.dev'")).elo, 1192);
});

test("a merge keeps the stronger claim per owner; star counts are left to the triggers", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const claim = (url, owner, status) => db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', ?, 't', '2026-10-01', '2026-10-01')", args: [url, owner, status] });
  await claim(O, "u1", "verified");
  await claim(N, "u1", "pending");
  await claim(O, "u2", "pending");
  await claim(N, "u2", "verified");
  const schema = await schemaOf(db);
  assert.ok(!(await planMove(db, { from: O, to: N }, { schema })).statements.some((s) => /star_counts/.test(s.sql)));
  schema.triggers.delete("votes_star_update");
  assert.ok((await planMove(db, { from: O, to: N }, { schema })).statements.some((s) => /INSERT INTO star_counts/.test(s.sql)));
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} })).failed, []);
  assert.deepEqual((await all(db, "SELECT owner, status FROM claims ORDER BY owner")).map((c) => [c.owner, c.status]), [["u1", "verified"], ["u2", "verified"]]);
});

test("a plan that went stale is skipped and nothing of it is written; an interrupted or failing merge changes nothing; two runs never overlap", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  const schema = await schemaOf(db);
  const stale = async (change) => {
    const plan = await planMove(db, { from: O, to: N }, { schema });
    await db.execute(change);
    const snapshot = await dump(db);
    await assert.rejects(applyMove(db, plan), StalePlan, change);
    assert.equal(await dump(db), snapshot, change);
  };
  await stale({ sql: "INSERT INTO votes (winner, loser, rater_id) VALUES (?, 'https://b.dev', 'late')", args: [O] });
  await stale({ sql: "UPDATE portfolios SET ai_rubric = ?, status = 'live' WHERE url = ?", args: [JSON.stringify({ tier: "S", model: "m" }), N] });
  await stale({ sql: "UPDATE portfolios SET shot_key = 'knewer' WHERE url = ?", args: [N] });
  await stale({ sql: "INSERT INTO likes (rater_id, url) VALUES ('late', ?)", args: [N] });
  const plan = await planMove(db, { from: O, to: N }, { schema });
  const before = await dump(db);
  for (let at = 0; at <= plan.statements.length; at += 5) {
    await assert.rejects(applyMove(db, { ...plan, statements: [...plan.statements.slice(0, at), { sql: "INSERT INTO no_such_table VALUES (1)", args: [] }, ...plan.statements.slice(at)] }));
    assert.equal(await dump(db), before, `interrupted at ${at}`);
  }
  await row(db, "https://bob.dev/", { delisted: "2026-11-01", shot: "kb" });
  await row(db, "https://bob.dev", { status: "pending", shot: null, grade: null });
  await db.execute("CREATE TRIGGER no_bob BEFORE DELETE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const r = await repairRespelled(db, [{ name: "Bob", url: "https://bob.dev" }, { name: "Ann", url: N }], { write: true, log: quiet, recompute: async () => {} });
  assert.deepEqual(r.failed.map((f) => f.from), ["https://bob.dev/"]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0, "ann merged after bob failed");
  await takeLock(db);
  await assert.rejects(repairRespelled(db, [], { write: true, log: quiet }), /another repair is running/);
  await releaseLock(db);
});

test("every table in the schema is moved, left on purpose, or holds no address; every unique constraint on a moved column survives a clash", async () => {
  const db = await freshDb();
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  for (const t of tables) assert.equal([Object.keys(SITE_TABLES), Object.keys(LEFT_AS_IS), NO_SITE_ADDRESS].filter((l) => l.includes(t)).length, 1, t);
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => /^(url|urls|winner|loser|portfolio_url|item|shown|ranking)$/.test(c)), [], t);
  }
  const schema = await schemaOf(db);
  const [O, N] = ["https://ann.dev/", "https://ann.dev"];
  await row(db, O, { delisted: "2026-11-01" });
  await row(db, N, { status: "pending", shot: null, grade: null });
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

test("every statement binds exactly the arguments it uses, and the merge runs against a real libSQL server (sqld)", { skip: !fs.existsSync(SQLD) && `no sqld at ${SQLD}` }, async () => {
  const strictArgs = (s) => {
    const numbered = [...s.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const plain = (s.sql.replace(/\?\d+/g, "").match(/\?/g) ?? []).length;
    assert.ok(!(numbered.length && plain), s.sql);
    assert.equal((s.args ?? []).length, numbered.length ? Math.max(...numbered) : plain, s.sql.replace(/\s+/g, " "));
  };
  const local = await freshDb();
  const { feed } = await splitSite(local);
  const strict = {
    execute: (s) => (typeof s === "object" && strictArgs(s), local.execute(s)),
    batch: (stmts, mode) => (stmts.forEach((s) => typeof s === "object" && strictArgs(s)), local.batch(stmts, mode)),
  };
  assert.deepEqual((await repairRespelled(strict, feed, { write: true, log: quiet, recompute: async () => {} })).failed, []);
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
    const { O, N } = await splitSite(db);
    const r = await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} });
    assert.deepEqual(r.failed, []);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
    assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = ?", [N])).shot_key, "kold");
  } finally {
    child.kill();
  }
});
