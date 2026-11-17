// When the community list only changes how a site's address is written (a
// trailing slash, www, http, upper case, a dropped query), the site loses
// nothing: the feed build keeps the address its row has (read from the
// database), the roster sync does the same for the entries a job holds, the
// purge never deletes the row, and the site waits, fully working, until its
// row is moved by hand after the new spelling is deployed
// (scripts/repair-respelled-sites.mjs, pipeline/site-move.mjs). One rule for
// "the same listed site" (pipeline/list-key.mjs), in Node only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { CLEANUP_SHARE_ENV, allowedShare, dueForCapture, ensureRosterSchema, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { SIBLINGS, feedKeyer, keysForList, listKey } from "../pipeline/list-key.mjs";
import { buildFeed } from "../pipeline/build-feed.mjs";
import { normKey, findDuplicates } from "../pipeline/health.mjs";
import { planOwnerRemovals } from "../pipeline/owner-removals.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";
import { LEFT_AS_IS, MOVED_COLUMNS, NO_SITE_ADDRESS, SITE_TABLES, findRespellings, gradeRank, moveSite, planMove, schemaOf } from "../pipeline/site-move.mjs";
import { HIDDEN_WHERE } from "../lib/hidden.mjs";
import { migrate } from "../lib/schema.mjs";
import { repairRespelled, takeLock, releaseLock } from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const GENERATOR = path.join(ROOT, "pipeline", "generate_feed.py");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const quiet = () => {};

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
async function freshDb({ full = true } = {}) {
  const file = path.join(tmp(), "db.sqlite");
  const db = createClient({ url: `file:${file}` });
  if (full) await migrate(db);
  await ensureRosterSchema(db);
  db.file = file;
  return db;
}
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const readmeOf = (entries) => `${entries.map((p) => `- [${p.name}](${p.url}) [Developer]`).join("\n")}\n`;

/** Runs generate_feed.py the way sync-upstream.yml does; `db` is the database it reads (LOCAL_DB_FILE). */
function generate({ readme, previous = null, excluded = [], additions = [], env = {}, maxShrink = null, dir = tmp(), raw = {}, db = null }) {
  const file = (f) => path.join(dir, f);
  fs.writeFileSync(file("README.md"), typeof readme === "string" ? readme : readmeOf(readme));
  fs.writeFileSync(file("excluded.json"), raw.excluded ?? JSON.stringify(excluded));
  fs.writeFileSync(file("additions.json"), JSON.stringify(additions));
  if (previous) fs.writeFileSync(file("feed.json"), JSON.stringify(previous));
  const args = [GENERATOR, file("README.md"), file("feed.json"), "--exclude", file("excluded.json"), "--add", file("additions.json")];
  if (maxShrink != null) args.push("--max-shrink", String(maxShrink));
  const base = { ...process.env, [CLEANUP_SHARE_ENV]: "" };
  delete base.LOCAL_DB_FILE;
  delete base.TURSO_DATABASE_URL;
  delete base.GITHUB_STEP_SUMMARY;
  const r = spawnSync("python3", args, { encoding: "utf8", env: { ...base, ...(db ? { LOCAL_DB_FILE: db.file } : {}), ...env } });
  const feed = fs.existsSync(file("feed.json")) ? JSON.parse(fs.readFileSync(file("feed.json"), "utf8")) : null;
  return { status: r.status, stdout: r.stdout + r.stderr, feed };
}

const GRADED = {
  sql: `INSERT INTO portfolios (url, name, status, shot_key, ai_rubric, captured_at, delisted_at)
        VALUES (?, 'Ann Lee', 'live', ?, '{"is_portfolio":true,"tier":"A","model":"m1"}', '2026-10-01T00:00:00Z', ?)`,
};
async function gradedRow(db, url, { shot = "kold", delisted = null } = {}) {
  await db.execute({ ...GRADED, args: [url, shot, delisted] });
}
async function liveRows(db, entries) {
  await db.batch(entries.map((p) => ({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] })), "write");
}
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const n = async (db, sql, args = []) => Number((await one(db, sql, args)).n);
async function dump(db) {
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map((r) => String(r.name));
  const out = {};
  for (const t of tables) out[t] = await all(db, `SELECT * FROM "${t}" ORDER BY 1, 2`).catch(() => all(db, `SELECT * FROM "${t}"`));
  return JSON.stringify(out);
}

// [the old spelling, the list's new spelling]: one site.
const RESPELLINGS = [
  ["https://ann.dev/", "https://ann.dev"],
  ["https://www.ann.dev", "https://ann.dev"],
  ["http://ann.dev", "https://ann.dev"],
  ["https://ann.dev", "https://ANN.dev/"],
  ["https://ann.dev", "https://ann.dev:443/"],
  ["https://ann.dev", "https://ann.dev/?utm_source=github&utm_medium=readme"],
  ["https://ann.dev/#home", "https://ann.dev"],
  ["https://ann.github.io/portfolio", "https://ann.github.io/Portfolio"],
  ["https://ghomkrosmonaute.github.io/?game", "https://ghomkrosmonaute.github.io/"],
  ["http://vedant.byethost31.com/portfolio.html?i=1", "http://vedant.byethost31.com/portfolio.html"],
  ["https://straße.de/", "https://xn--strae-oqa.de"],
];
// Another site: a domain move (the owner: a new domain is a new site), another page, another project page.
const NOT_RESPELLINGS = [
  ["https://ann.dev", "https://annlee.dev"],
  ["https://ann.dev", "https://ann.dev/en"],
  ["https://ann.github.io/portfolio", "https://ann.github.io/portfolio-v2"],
];

// ---------------------------------------------------------------------------
// The rule

test("rule 1: the key ignores scheme, www, case, the trailing slash, the port, the query and the fragment", () => {
  for (const [a, b] of RESPELLINGS) assert.equal(listKey(a), listKey(b), `${a} ~ ${b}`);
  for (const [a, b] of NOT_RESPELLINGS) assert.notEqual(listKey(a), listKey(b), `${a} !~ ${b}`);
});

test("rule 2: a query or hash route tells entries apart only while the whole list holds two with one key", () => {
  const two = keysForList(["https://host.dev/#/alice", "https://host.dev/#/bob"]);
  assert.notEqual(two("https://host.dev/#/alice"), two("https://host.dev/#/bob"));
  assert.equal(two("https://host.dev/#/alice/"), two("https://www.host.dev/#/alice"));
  const alone = keysForList(["https://host.dev/#/alice"]);
  assert.equal(alone("https://host.dev/#/alice"), alone("https://host.dev/"));
  // After alice was excluded, bob's siblings mark still keeps the two apart.
  const feed = buildFeed({ entries: [{ name: "A", url: "https://host.dev/#/alice" }, { name: "B", url: "https://host.dev/#/bob" }], excluded: [{ url: "https://host.dev/#/alice", kind: "down" }] }).feed;
  assert.deepEqual(feed, [{ name: "B", url: "https://host.dev/#/bob", [SIBLINGS]: true }]);
  const keyOf = feedKeyer(feed);
  assert.notEqual(keyOf("https://host.dev/#/alice"), keyOf("https://host.dev/#/bob"));
});

test("an exclusion keeps every spelling of its site out, and only that site", () => {
  const excluded = [
    { url: "https://www.gone.dev/", kind: "owner_request" },
    { url: "https://x.dev/?lang=en", kind: "owner_request" },
    { url: "https://user.github.io/portfolio", kind: "not_portfolio" },
  ];
  const out = [
    "https://www.gone.dev/", "https://gone.dev", "http://gone.dev/", "HTTPS://WWW.GONE.DEV", "https://gone.dev/?utm=x",
    "https://gone.dev/?page=2", "https://gone.dev/#home", "https://gone.dev:443/", "http://gone.dev:80",
    "https://x.dev/", "https://x.dev/?lang=de", "https://user.github.io/portfolio/", "https://user.github.io/Portfolio",
  ];
  // (/index.html stays a page of its own until lib/grader/url.mjs siteKeyOf says otherwise.)
  const listed = ["https://gone.dev/en", "https://blog.gone.dev", "https://user.github.io/portfolio-v2", "https://user.github.io"];
  for (const url of [...out, ...listed]) {
    assert.deepEqual(buildFeed({ entries: [{ name: "X", url }], excluded }).feed.map((p) => p.url), listed.includes(url) ? [url] : [], url);
  }
});

test("the feed holds one entry per site, written as the list spells it, siblings marked", () => {
  const r = buildFeed({
    entries: [
      { name: "A", url: "https://host.example/p?id=1" },
      { name: "B", url: "https://host.example/p?id=2" },
      { name: "E", url: "https://ann.dev/?utm_source=github" },
      { name: "E again", url: "https://www.ann.dev" },
      { name: "F", url: "https://fred.dev/#home" },
      { name: "F again", url: "https://fred.dev:443" },
    ],
  });
  assert.deepEqual(r.feed.map((p) => [p.name, p.url, Boolean(p[SIBLINGS])]), [
    ["A", "https://host.example/p?id=1", true],
    ["B", "https://host.example/p?id=2", true],
    ["E", "https://ann.dev/?utm_source=github", true],
    ["F", "https://fred.dev/#home", true],
  ]);
  assert.equal(r.dupes, 2);
});

test("generate_feed.py keeps a respelled site at its stored address, read from the database only", async () => {
  const db = await freshDb({ full: false });
  await gradedRow(db, "https://ann.dev/", { delisted: "2026-11-01T00:00:00Z" });
  // Without a database: upstream's spelling, whatever the previous feed said.
  const plain = generate({ readme: [{ name: "Ann", url: "https://ann.dev" }], previous: [{ name: "Ann", url: "https://www.ann.dev" }] });
  assert.deepEqual(plain.feed, [{ name: "Ann", url: "https://ann.dev", tagline: "Developer" }]);
  // With it: the stored address, no href, counted in the job summary. Also after the site left the feed (delisted row).
  const summary = path.join(tmp(), "summary.md");
  const pinned = generate({ readme: [{ name: "Ann", url: "https://ann.dev" }], previous: [{ name: "Ann", url: "https://www.ann.dev" }], db, env: { GITHUB_STEP_SUMMARY: summary } });
  assert.equal(pinned.status, 0, pinned.stdout);
  assert.deepEqual(pinned.feed, [{ name: "Ann", url: "https://ann.dev/", tagline: "Developer" }]);
  assert.match(pinned.stdout, /1 waiting for an address move/);
  assert.match(fs.readFileSync(summary, "utf8"), /### Waiting for an address move[\s\S]*- https:\/\/ann\.dev\/ \(the list says https:\/\/ann\.dev\)/);
  // A configured database that cannot be read fails the build.
  const bad = path.join(tmp(), "not-a-db.sqlite");
  fs.writeFileSync(bad, "this is not a database");
  const broken = generate({ readme: [{ name: "Ann", url: "https://ann.dev" }], env: { LOCAL_DB_FILE: bad } });
  assert.notEqual(broken.status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "pipeline", "generate_feed.py"), "utf8"), /urlsplit|def site_|norm_key/);
});

test("generate_feed.py refuses an exclusions or additions file that is not a list", () => {
  const r = generate({ readme: [{ name: "Gone", url: "https://gone.dev" }], raw: { excluded: JSON.stringify({ url: "https://gone.dev" }) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not a JSON list/);
});

test("owner removals and review relists use the build's rule, siblings included", () => {
  // Rule 1: a dropped query is the same site.
  assert.deepEqual(planOwnerRemovals({ removals: [{ url: "https://x.dev/", removedAt: "2026-11-16" }], excluded: [], feed: [{ name: "X", url: "https://x.dev/?game" }] }).feed, []);
  // Rule 2: alice is excluded, bob is listed; bob's owner removes him.
  const feed = [{ name: "Bob", url: "https://host.dev/#/bob", [SIBLINGS]: true }, { name: "Cy", url: "https://cy.dev" }];
  const excluded = [{ url: "https://host.dev/#/alice", kind: "owner_request" }];
  const r = planOwnerRemovals({ removals: [{ url: "https://host.dev/#/bob", removedAt: "2026-11-16" }], excluded, feed });
  assert.deepEqual(r.added.map((a) => a.url), ["https://host.dev/#/bob"]);
  assert.deepEqual(r.feed.map((p) => p.name), ["Cy"]);
  // Relisting alice (once excluded as not a portfolio) lifts only alice's exclusion.
  const rel = planReviewAdditions({
    relists: [{ url: "https://host.dev/#/alice", name: "Alice" }],
    additions: [],
    excluded: [{ url: "https://host.dev/#/alice", kind: "not_portfolio" }, { url: "https://host.dev/#/zed", kind: "not_portfolio" }],
    feed,
  });
  assert.deepEqual(rel.added.map((a) => a.url), ["https://host.dev/#/alice"]);
  assert.deepEqual(rel.excluded.map((e) => e.url), ["https://host.dev/#/zed"]);
});

// The health lane's duplicate check and exclusions still use normKey (pull request #247): after it merges,
// pipeline/health.mjs findDuplicates and pipeline/exclusions.mjs must use the rule above. This test waits for that.
test("after #247: the health check's duplicates follow the list's rule (two hash routes are two sites)", { todo: "switch pipeline/health.mjs findDuplicates and pipeline/exclusions.mjs to pipeline/list-key.mjs" }, () => {
  for (const [a, b] of RESPELLINGS) assert.equal(normKey(a), normKey(b), `normKey agrees on ${a} ~ ${b}`);
  const dupes = findDuplicates([{ url: "https://host.dev/#/alice" }, { url: "https://host.dev/#/bob" }]);
  assert.equal(dupes.size, 0, "bob is not a duplicate of alice");
});

// ---------------------------------------------------------------------------
// The site waits, fully working, until the move

/** A site with the history a move must carry. */
async function siteWithHistory(db, url, i) {
  await gradedRow(db, url, { shot: `shot${i}` });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES (?, 'https://filler-1.dev', ?, 'human', ?)", args: [url, [url, "https://filler-1.dev"].sort().join("\n"), `r${i}`] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1216, 1)", args: [url] });
  await db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', 'verified', 't', '2026-10-01', '2026-10-01')", args: [url, `o${i}`] });
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)", args: [`r${i}`, url] });
  await db.execute({ sql: "INSERT INTO lists (owner, name, slug) VALUES (?, 'Faves', ?)", args: [`r${i}`, `faves-${i}`] });
  await db.execute({ sql: "INSERT INTO list_items (list_id, url) VALUES ((SELECT id FROM lists WHERE slug = ?), ?)", args: [`faves-${i}`, url] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, wins, member) VALUES (?, 27.5, 6, 9.5, 3, 4, 3, 1)", args: [url] });
  await db.execute({ sql: "INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES ('merged', ?, ?, 27.5, 6, 'high')", args: [url, i + 1] });
}

async function assertOneRowWithHistory(db, spellings, current, i, label) {
  const rows = (await all(db, "SELECT url FROM portfolios")).map((r) => String(r.url)).filter((u) => spellings.includes(u));
  assert.deepEqual(rows, [current], `${label}: one row, under ${current}`);
  const row = await one(db, "SELECT ai_rubric, shot_key FROM portfolios WHERE url = ?", [current]);
  assert.ok(row.ai_rubric, `${label}: grade`);
  assert.equal(row.shot_key, `shot${i}`, `${label}: screenshots`);
  for (const [t, c] of [["votes", "winner"], ["ratings", "url"], ["claims", "url"], ["likes", "url"], ["list_items", "url"], ["tier_ratings", "url"], ["site_ratings", "url"]]) {
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [current]), 1, `${label}: ${t}`);
    for (const old of spellings.filter((s) => s !== current)) assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [old]), 0, `${label}: ${t} left on ${old}`);
  }
  const tier = await one(db, "SELECT mu, faceoffs, wins, member FROM tier_ratings WHERE url = ?", [current]);
  assert.deepEqual([tier.mu, tier.faceoffs, tier.wins, tier.member], [27.5, 4, 3, 1], `${label}: tier rating intact`);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [current])).elo, 1216, `${label}: ELO intact`);
}

test("after every upstream edit a site keeps one listed, graded, visible row and waits; the manual move then loses nothing", async () => {
  const db = await freshDb();
  const dir = tmp();
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
    ivy: ["https://host.dev/#/ivy", "https://host.dev/#/ivy/"],
    joe: ["https://host.dev/#/joe"],
  };
  const names = Object.keys(sites);
  for (const [i, k] of names.entries()) await siteWithHistory(db, sites[k][0], i);
  // What upstream lists for each site now.
  const spelled = Object.fromEntries(names.map((k) => [k, sites[k][0]]));
  const night = async ({ drop = [], excluded = [], additions = [], withDb = true } = {}) => {
    const readme = [...fillers(), ...names.filter((k) => !drop.includes(k) && !additions.some((a) => a.name === k)).map((k) => ({ name: k, url: spelled[k] }))];
    const out = generate({ readme, excluded, additions, dir, db: withDb ? db : null });
    assert.equal(out.status, 0, out.stdout);
    await syncRoster(db, out.feed, { now: NOW, log: quiet });
    // What capture does next with the same entries: insert a row for every entry that has none.
    for (const p of await dueForCapture(db, out.feed)) await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [p.url] });
    return out;
  };
  const listedNow = (out) => names.filter((k) => out.feed.some((p) => p.name === k));
  const checkWaiting = async (out, label) => {
    let waiting = 0;
    for (const [i, k] of names.entries()) {
      await assertOneRowWithHistory(db, sites[k], sites[k][0], i, `${label} / ${k}`);
      if (!listedNow(out).includes(k)) continue;
      const entry = out.feed.find((p) => p.name === k);
      assert.equal(entry.url, sites[k][0], `${label} / ${k}: the feed keeps the stored address`);
      const row = await one(db, `SELECT delisted_at, (${HIDDEN_WHERE}) AS hidden FROM portfolios WHERE url = ?`, [sites[k][0]]);
      assert.equal(row.delisted_at, null, `${label} / ${k}: listed`);
      assert.equal(Number(row.hidden), 0, `${label} / ${k}: visible`);
      if (spelled[k] !== sites[k][0]) waiting++;
    }
    if (waiting) assert.match(out.stdout, new RegExp(`${waiting} waiting for an address move`), label);
  };
  await checkWaiting(await night(), "start");
  for (const k of ["slash", "pathCase", "www", "https", "query", "ivy"]) spelled[k] = sites[k][1];
  const removed = await night({ drop: ["readded", "additions"], excluded: [{ url: "https://gil.dev", kind: "down" }] });
  await checkWaiting(removed, "edits, a removal and an exclusion");
  for (const k of ["readded", "lifted", "additions"]) spelled[k] = sites[k][1];
  const back = await night({ additions: [{ name: "additions", url: spelled.additions, source: "review" }] });
  await checkWaiting(back, "re-added, lifted, relisted");
  // A second night changes nothing.
  const before = await dump(db);
  await night({ additions: [{ name: "additions", url: spelled.additions, source: "review" }] });
  assert.equal(await dump(db), before);
  // The new spellings reach main and are deployed (here: a feed built as upstream spells it); then the manual move.
  const main = generate({ readme: [...fillers(), ...names.filter((k) => k !== "additions").map((k) => ({ name: k, url: spelled[k] }))], additions: [{ name: "additions", url: spelled.additions, source: "review" }] }).feed;
  let recomputed = 0;
  const r = await repairRespelled(db, main, { write: true, log: quiet, recompute: async () => recomputed++ });
  assert.deepEqual(r.failed, []);
  assert.equal(r.moves.length, 9);
  assert.equal(r.merges.length, 0);
  assert.equal(recomputed, 0, "a rename needs no recompute: tier and leaderboard rows move with the site");
  for (const [i, k] of names.entries()) await assertOneRowWithHistory(db, sites[k], spelled[k], i, `moved / ${k}`);
  // The next nightly sync on that feed finds nothing to do.
  const mainCopy = main.map((p) => ({ ...p }));
  assert.equal((await syncRoster(db, mainCopy, { now: NOW, log: quiet })).waiting, 0);
});

test("syncRoster keeps the entries a job holds at their stored address, so no job delists the row or inserts a second one", async () => {
  const db = await freshDb({ full: false });
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev/` }));
  await liveRows(db, feed);
  const respelled = feed.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  const summary = path.join(tmp(), "summary.md");
  const r = await withEnv({ GITHUB_STEP_SUMMARY: summary }, () => syncRoster(db, respelled, { now: NOW, log: quiet }));
  assert.deepEqual(r, { delisted: 0, relisted: 0, listed: 600, waiting: 600 });
  assert.equal(respelled[0].url, "https://site0.dev/");
  assert.deepEqual(await dueForCapture(db, respelled), []);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios"), 600);
  assert.match(fs.readFileSync(summary, "utf8"), /### Waiting for an address move\n\n600 site\(s\)/);
});

test("the purge keeps a row whose site is listed under another address, by the feed's rule", async () => {
  const db = await freshDb({ full: false });
  await liveRows(db, fillers(20));
  const old = new Date(NOW.getTime() - 40 * DAY).toISOString();
  await gradedRow(db, "https://ann.dev/", { delisted: old });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://ann.dev', 'live')");
  // Alice left the list (excluded); her sibling bob is listed: alice is another site and goes.
  await gradedRow(db, "https://host.dev/#/alice", { shot: "ka", delisted: old });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://host.dev/#/bob', 'live')");
  const feed = [...fillers(20), { name: "Ann", url: "https://ann.dev" }, { name: "Bob", url: "https://host.dev/#/bob", [SIBLINGS]: true }];
  const deleted = [];
  const logs = [];
  assert.deepEqual(await purgeDelisted(db, { now: NOW, deleteShots: async (k) => deleted.push(k), log: (m) => logs.push(m), feed }), { due: 1, purged: 1, failed: 0 });
  assert.deepEqual(deleted, ["ka"]);
  assert.match(logs.join("\n"), /kept https:\/\/ann\.dev\/: the same site is listed under another/);
});

// ---------------------------------------------------------------------------
// The guards

test("syncRoster refuses to delist more than 15% of the list at once; the owner's share only ever raises a limit", async () => {
  const db = await freshDb({ full: false });
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const mix = (k) => feed.map((p, i) => (i < k ? { name: `Q${i}`, url: `https://other${i}.dev` } : p));
  await assert.rejects(syncRoster(db, mix(600), { now: NOW, log: quiet }), new RegExp(`600 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  await assert.rejects(syncRoster(db, mix(91), { now: NOW, log: quiet }), /91 of 600/);
  await withEnv({ [CLEANUP_SHARE_ENV]: "0.08" }, async () => {
    assert.equal(allowedShare(0.15), 0.15);
    assert.equal(allowedShare(0.05), 0.08);
    assert.equal((await syncRoster(db, mix(90), { now: NOW, log: quiet })).delisted, 90);
  });
  await withEnv({ [CLEANUP_SHARE_ENV]: "nonsense" }, async () => {
    await assert.rejects(syncRoster(db, feed, { now: NOW, log: quiet }), /not a share between 0 and 1/);
  });
});

test("generate_feed.py lets a bigger upstream cleanup through once when the owner sets the cleanup share", () => {
  const all100 = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev` }));
  const smaller = all100.slice(0, 80);
  const refused = generate({ readme: smaller, previous: all100, maxShrink: 0.05 });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, new RegExp(`refusing to write.*${CLEANUP_SHARE_ENV}`));
  assert.equal(generate({ readme: smaller, previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "0.3" } }).status, 0);
  assert.notEqual(generate({ readme: smaller, previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "lots" } }).status, 0);
  // The build loads neither the database client nor the health check unless a database is configured.
  const src = fs.readFileSync(path.join(ROOT, "pipeline", "build-feed.mjs"), "utf8");
  assert.doesNotMatch(src, /from "\.\/(roster|exclusions|health)\.mjs"|^import .*@libsql/m);
});

// ---------------------------------------------------------------------------
// The manual move, table by table

test("every table in the schema is either moved, left on purpose, or holds no site address", async () => {
  const db = await freshDb();
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  const lists = [Object.keys(SITE_TABLES), Object.keys(LEFT_AS_IS), NO_SITE_ADDRESS];
  for (const t of tables) assert.equal(lists.filter((l) => l.includes(t)).length, 1, `table ${t}: add it to exactly one list in pipeline/site-move.mjs`);
  const ADDRESS_COLUMN = /^(url|urls|winner|loser|portfolio_url|item|shown|ranking)$/;
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => ADDRESS_COLUMN.test(c)), [], `${t} has an address column`);
  }
  assert.ok(NO_SITE_ADDRESS.includes("tier_undo") && !MOVED_COLUMNS.some(([t]) => t === "tier_undo"));
});

test("every unique constraint on a moved column survives a clash: the new address's row stays, nothing is left behind", async () => {
  const db = await freshDb();
  const schema = await schemaOf(db);
  const O = "https://ann.dev/";
  const N = "https://ann.dev";
  await gradedRow(db, O, { delisted: "2026-11-01T00:00:00Z" });
  await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'pending')", args: [N] });
  const clashing = [];
  for (const [t, c] of MOVED_COLUMNS) {
    const s = schema.get(t);
    if (!s || !s.unique.some((u) => u.has(c))) continue;
    const info = (await db.execute(`PRAGMA table_info(${t})`)).rows;
    const pkCols = info.filter((r) => Number(r.pk) > 0);
    const auto = pkCols.length === 1 && /INT/i.test(String(pkCols[0].type)) ? [String(pkCols[0].name)] : [];
    for (const u of s.unique) assert.ok(u.has(c) || [...u].every((x) => auto.includes(x)), `${t}: a unique constraint without ${c}`);
    const cols = info.filter((r) => (Number(r.notnull) === 1 || Number(r.pk) > 0) && r.dflt_value == null && !auto.includes(String(r.name))).map((r) => String(r.name));
    if (!cols.includes(c)) cols.push(c);
    const typeOf = (x) => String(info.find((r) => String(r.name) === x).type);
    for (const url of [O, N]) {
      await db.execute({ sql: `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((x) => (x === c ? url : /INT|REAL/i.test(typeOf(x)) ? 1 : "x")) });
    }
    clashing.push(`${t}.${c}`);
  }
  for (const t of ["status_reviews.url", "likes.url", "rank_history.url", "list_items.url"]) assert.ok(clashing.includes(t), `${t} in ${clashing.join(", ")}`);
  const r = await repairRespelled(db, [{ name: "Ann", url: N }], { write: true, log: quiet, recompute: async () => {} });
  assert.deepEqual(r.failed, []);
  for (const tc of clashing) {
    const [t, c] = tc.split(".");
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [O]), 0, `${tc} left behind`);
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [N]), 1, `${tc} kept`);
  }
});

test("a merge keeps the better grade (a real one over an error) and the live capture, decided apart; the other grade goes to history", async () => {
  const REAL = (tier) => JSON.stringify({ tier, is_portfolio: true, model: "m" });
  const ERR = JSON.stringify({ error: "gemini 503" });
  const cases = [
    { cur: { grade: ERR, live: true }, old: { grade: REAL("A"), live: false }, grade: REAL("A"), shot: "knew", history: ERR },
    { cur: { grade: REAL("B"), live: false }, old: { grade: ERR, live: true }, grade: REAL("B"), shot: "kold", history: ERR },
    { cur: { grade: null, live: false }, old: { grade: REAL("A"), live: true }, grade: REAL("A"), shot: "kold", history: null },
    { cur: { grade: REAL("B"), live: true }, old: { grade: REAL("A"), live: true }, grade: REAL("B"), shot: "knew", history: REAL("A") },
    { cur: { grade: JSON.stringify({ tier: "C", is_portfolio: false }), live: true }, old: { grade: REAL("A"), live: true }, grade: REAL("A"), shot: "knew", history: JSON.stringify({ tier: "C", is_portfolio: false }) },
  ];
  for (const c of cases) {
    const db = await freshDb();
    const insert = (url, side, shot) =>
      db.execute({ sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric) VALUES (?, ?, ?, ?)", args: [url, side.live ? "live" : "error", shot, side.grade] });
    await insert("https://ann.dev/", c.old, "kold");
    await insert("https://ann.dev", c.cur, "knew");
    const r = await repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }], { write: true, log: quiet, recompute: async () => {} });
    assert.deepEqual(r.failed, []);
    const row = await one(db, "SELECT status, shot_key, ai_rubric FROM portfolios WHERE url = 'https://ann.dev'");
    const label = JSON.stringify(c);
    assert.equal(row.shot_key, c.shot, `${label}: capture`);
    assert.equal(row.ai_rubric, c.grade, `${label}: grade`);
    assert.deepEqual((await all(db, "SELECT url, rubric FROM rubric_history")).map((h) => [h.url, h.rubric]), c.history ? [["https://ann.dev", c.history]] : [], `${label}: history`);
  }
  assert.deepEqual([gradeRank(null), gradeRank(ERR), gradeRank('{"tier":"C","is_portfolio":false}'), gradeRank(REAL("A"))], [0, 1, 2, 3]);
});

async function splitSite(db) {
  const O = "https://ann.dev/";
  const N = "https://ann.dev";
  await gradedRow(db, O, { delisted: "2026-11-01T00:00:00Z" });
  await db.execute({ sql: "INSERT INTO portfolios (url, name, status) VALUES (?, 'Ann Lee', 'pending')", args: [N] });
  for (const u of ["https://a.dev", "https://b.dev", "https://c.dev"]) await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [u] });
  const vote = (w, l, rater, starred = 0) =>
    db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES (?, ?, ?, 'human', ?, ?)", args: [w, l, [w, l].sort().join("\n"), rater, starred] });
  await vote(O, "https://a.dev", "r1", 1);
  await vote("https://b.dev", O, "r2");
  await vote("https://c.dev", N, "r3");
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1260, 2), (?, 1190, 1)", args: [O, N] });
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES ('r1', ?), ('r2', ?), ('r2', ?)", args: [O, O, N] });
  await db.execute({ sql: "INSERT INTO lists (owner, name, slug) VALUES ('r1', 'Faves', 'faves')" });
  await db.execute({ sql: "INSERT INTO list_items (list_id, url) VALUES (1, ?)", args: [O] });
  await db.execute({ sql: "INSERT INTO portfolio_owner (url, hide_grade, updated_at) VALUES (?, 1, '2026-10-01')", args: [O] });
  await db.execute({ sql: "INSERT INTO comparisons (created_at, rater_type, method, ranking) VALUES ('2026-10-01', 'ai', 'one_on_one', ?)", args: [JSON.stringify([O, "https://a.dev"])] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket) VALUES (?, 25, 8, 1, 1), (?, 24, 8, 1, 1)", args: [O, N] });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, '{}', 1)", args: [`psi:${O}`] });
  const feed = [{ name: "Ann Lee", url: N }, ...["a", "b", "c"].map((x) => ({ name: x, url: `https://${x}.dev` }))];
  return { O, N, feed };
}

test("the repair merges a split site into its listed address and does not finish without the recompute", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const before = await dump(db);
  const dry = await repairRespelled(db, feed, { log: quiet });
  assert.deepEqual(dry.merges.map((p) => [p.from, p.to]), [[O, N]]);
  assert.equal(await dump(db), before, "a dry run changes nothing");
  const logs = [];
  const noRecompute = await repairRespelled(db, feed, { write: true, log: (m) => logs.push(m) });
  assert.ok(noRecompute.needsRecompute && !noRecompute.recomputed);
  assert.match(logs.join("\n"), /NOT DONE YET: .*node scripts\/recompute-ratings\.mjs && node scripts\/refresh-tiers\.mjs/);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
  const row = await one(db, "SELECT status, shot_key, ai_rubric FROM portfolios WHERE url = ?", [N]);
  assert.deepEqual([row.status, row.shot_key], ["live", "kold"]);
  assert.deepEqual(
    (await all(db, "SELECT winner, loser, pair_key FROM votes ORDER BY id")).map((v) => [v.winner, v.loser, v.pair_key]),
    [
      [N, "https://a.dev", [N, "https://a.dev"].sort().join("\n")],
      ["https://b.dev", N, [N, "https://b.dev"].sort().join("\n")],
      ["https://c.dev", N, [N, "https://c.dev"].sort().join("\n")],
    ]
  );
  assert.deepEqual(await all(db, "SELECT url, elo, votes FROM ratings"), [{ url: N, elo: 1250, votes: 3 }]);
  assert.deepEqual(await all(db, "SELECT url, n FROM star_counts WHERE n > 0"), [{ url: N, n: 1 }]);
  assert.deepEqual((await all(db, "SELECT rater_id, url FROM likes ORDER BY rater_id")).map((l) => [l.rater_id, l.url]), [["r1", N], ["r2", N]]);
  assert.deepEqual(Object.values(await one(db, "SELECT url, hide_grade FROM portfolio_owner")), [N, 1]);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.deepEqual(await all(db, "SELECT url, dirty FROM tier_ratings"), [{ url: N, dirty: 1 }]);
  // The script's exit code for this case, and the run that does the recompute.
  const script = spawnSync(process.execPath, [path.join(ROOT, "scripts", "repair-respelled-sites.mjs"), "--write", "--feed", "x.json"], { encoding: "utf8" });
  assert.equal(script.status, 2);
  assert.match(script.stderr, /--feed is for dry runs only/);
  const db2 = await freshDb();
  const split2 = await splitSite(db2);
  let ran = 0;
  const done = await repairRespelled(db2, split2.feed, { write: true, log: quiet, recompute: async () => ran++ });
  assert.ok(done.recomputed);
  assert.equal(ran, 1);
});

test("a rename keeps every vote, even old duplicates, and renames the tier and leaderboard rows", async () => {
  const db = await freshDb();
  await gradedRow(db, "https://ann.dev/");
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://a.dev', 'live')");
  // Old duplicate votes from the JSON import (NULL pair_key, rater 'local'), all on the old address.
  for (let i = 0; i < 3; i++) await db.execute("INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('https://ann.dev/', 'https://a.dev', NULL, 'human', 'local')");
  await db.execute("INSERT INTO ratings (url, elo, votes) VALUES ('https://ann.dev/', 1248, 3)");
  await db.execute("INSERT INTO tier_ratings (url, mu, sigma, rating, bucket, faceoffs, wins, member) VALUES ('https://ann.dev/', 27.5, 6, 9.5, 3, 3, 3, 1)");
  await db.execute("INSERT INTO site_ratings (view, url, rank, mu, sigma, confidence) VALUES ('merged', 'https://ann.dev/', 4, 27.5, 6, 'high')");
  const r = await repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }, { name: "A", url: "https://a.dev" }], { write: true, log: quiet });
  assert.deepEqual(r.moves.map((p) => p.kind), ["rename"]);
  assert.equal(r.needsRecompute, false);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = 'https://ann.dev'"), 3);
  assert.deepEqual(Object.values(await one(db, "SELECT url, elo, votes FROM ratings")), ["https://ann.dev", 1248, 3]);
  assert.deepEqual(Object.values(await one(db, "SELECT url, mu, faceoffs, wins, member FROM tier_ratings")), ["https://ann.dev", 27.5, 3, 3, 1]);
  assert.deepEqual(Object.values(await one(db, "SELECT url, rank FROM site_ratings")), ["https://ann.dev", 4]);
});

test("a merge drops only the votes it makes duplicate (one from each side) or of the site against itself, and takes their points back", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const vote = (w, l, rater, delta, pair = [w, l].sort().join("\n")) =>
    db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta) VALUES (?, ?, ?, 'ai', ?, ?)", args: [w, l, pair, rater, delta] });
  await vote(O, "https://a.dev", "ai", 10);
  await vote(N, "https://a.dev", "ai", 8);
  await vote(O, N, "ai", 6);
  // Old duplicates on the old address alone (one side only): kept.
  await vote(O, "https://b.dev", "local", 4, null);
  await vote(O, "https://b.dev", "local", 4, null);
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 10 + 6 + 8, votes = votes + 4 WHERE url = ?", args: [O] });
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 8 - 6, votes = votes + 2 WHERE url = ?", args: [N] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1182, 2)" });
  const r = await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} });
  assert.deepEqual(r.failed, []);
  const votes = await all(db, "SELECT winner, loser, rater_id, pair_key FROM votes ORDER BY id");
  assert.ok(votes.every((v) => v.winner !== v.loser), "no vote of a site against itself");
  assert.deepEqual(votes.filter((v) => v.rater_id === "ai").map((v) => v.winner), [N], "the vote from the listed side stays");
  assert.equal(votes.filter((v) => v.rater_id === "local").length, 2, "duplicates from one side are not the merge's business");
  // (1260 + 24) + (1190 + 2) - 1200 = 1276; the dropped moved vote (10) and the self-vote (6, cancels) come off: 1266.
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [N])).elo, 1266);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = 'https://a.dev'")).elo, 1192);
});

test("star counts are left to the votes triggers; recounted only where the triggers are missing", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  assert.ok(!(await planMove(db, { from: O, to: N })).statements.some((s) => /star_counts/.test(s.sql)));
  const schema = await schemaOf(db);
  schema.triggers.delete("votes_star_update");
  assert.ok((await planMove(db, { from: O, to: N }, schema)).statements.some((s) => /INSERT INTO star_counts/.test(s.sql)));
});

test("a merge keeps the stronger claim when an owner claimed both addresses", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const claim = (url, owner, status) =>
    db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', ?, 't', '2026-10-01', '2026-10-01')", args: [url, owner, status] });
  await claim(O, "u1", "verified");
  await claim(N, "u1", "pending");
  await claim(O, "u2", "pending");
  await claim(N, "u2", "verified");
  await claim(O, "u3", "review");
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet, recompute: async () => {} })).failed, []);
  assert.deepEqual(
    (await all(db, "SELECT url, owner, status FROM claims ORDER BY owner")).map((c) => [c.url, c.owner, c.status]),
    [[N, "u1", "verified"], [N, "u2", "verified"], [N, "u3", "review"]]
  );
});

test("findRespellings never takes a sibling that left the feed for another site", async () => {
  const db = await freshDb();
  await gradedRow(db, "https://host.dev/#/alice", { shot: "ka", delisted: "2026-11-01T00:00:00Z" });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://host.dev/#/bob', 'live')");
  await gradedRow(db, "https://two.dev/", { shot: "k1" });
  await gradedRow(db, "http://two.dev", { shot: "k2" });
  const feed = [{ name: "Bob", url: "https://host.dev/#/bob", [SIBLINGS]: true }, { name: "Two", url: "https://www.two.dev" }];
  const r = await findRespellings(db, feed);
  assert.deepEqual([r.merges, r.moves], [[], []]);
  assert.deepEqual(r.skipped.map((s) => s.rows.sort()), [["http://two.dev", "https://two.dev/"]]);
});

test("a repair pair that fails is reported, changes nothing, and the run goes on", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  await gradedRow(db, "https://bob.dev/", { shot: "kb", delisted: "2026-11-01T00:00:00Z" });
  const review = (url) =>
    db.execute({ sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('b1', ?, 'g', 'c', 'p', 1, '{}', '2026-10-01')", args: [url] });
  await review(O);
  await review(N);
  await db.execute("CREATE TRIGGER no_bob BEFORE UPDATE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const logs = [];
  const r = await repairRespelled(db, [{ name: "Bob", url: "https://bob.dev" }, { name: "Ann", url: N }], { write: true, log: (m) => logs.push(m), recompute: async () => {} });
  assert.deepEqual(r.failed.map((f) => f.from), ["https://bob.dev/"]);
  assert.match(logs.join("\n"), /FAILED https:\/\/bob\.dev\/ -> https:\/\/bob\.dev: .*refused/);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://bob.dev/'"), 1);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0, "ann merged");
  assert.deepEqual((await all(db, "SELECT url FROM status_reviews")).map((x) => x.url), [N]);
});

test("a move is planned and written in one transaction: interrupted anywhere it changes nothing, and nobody writes in between", async () => {
  const db = await freshDb();
  await liveRows(db, fillers(5));
  await siteWithHistory(db, "https://ann.dev/", 0);
  const pair = { from: "https://ann.dev/", to: "https://ann.dev" };
  const before = await dump(db);
  const total = (await planMove(db, pair)).statements.length;
  assert.ok(total > 5);
  for (let at = 0; at <= total; at += 3) {
    const edit = (stmts) => [...stmts.slice(0, at), { sql: "INSERT INTO no_such_table VALUES (1)", args: [] }, ...stmts.slice(at)];
    await assert.rejects(moveSite(db, pair, { edit }));
    assert.equal(await dump(db), before, `interrupted at statement ${at}`);
  }
  // While the move holds its transaction, another writer (a vote) has to wait.
  const other = createClient({ url: `file:${db.file}` });
  let blocked = null;
  await moveSite(db, pair, {
    edit: (stmts) => {
      blocked = other.execute("INSERT INTO votes (winner, loser, rater_id) VALUES ('https://ann.dev/', 'x', 'late')").then(() => "written", (e) => `refused: ${e.message}`);
      return stmts;
    },
  });
  assert.match(await blocked, /refused|written/);
  if ((await blocked) === "written") assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE rater_id = 'late' AND winner = 'https://ann.dev/'"), 1, "a vote written after the move, not lost in between");
  // Two repairs never run at once.
  await takeLock(db);
  await assert.rejects(repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }], { write: true, log: quiet }), /another repair is running/);
  await releaseLock(db);
});

// ---------------------------------------------------------------------------
// A remote libSQL server

function assertStrictArgs(statements) {
  for (const s of statements) {
    const numbered = [...s.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const plain = (s.sql.replace(/\?\d+/g, "").match(/\?/g) ?? []).length;
    assert.ok(!(numbered.length && plain), `mixed placeholders: ${s.sql}`);
    const want = numbered.length ? Math.max(...numbered) : plain;
    assert.equal((s.args ?? []).length, want, `${want} placeholder(s), ${(s.args ?? []).length} argument(s): ${s.sql.replace(/\s+/g, " ")}`);
  }
}
const strict = (c) => ({
  execute: (stmt) => {
    if (typeof stmt === "object") assertStrictArgs([stmt]);
    return c.execute(stmt);
  },
  batch: (stmts, mode) => {
    assertStrictArgs(stmts.filter((s) => typeof s === "object"));
    return c.batch(stmts, mode);
  },
});
const strictClient = (db) => ({
  ...strict(db),
  transaction: async (mode) => {
    const tx = await db.transaction(mode);
    return { ...strict(tx), commit: () => tx.commit(), rollback: () => tx.rollback(), close: () => tx.close() };
  },
});

test("every statement of a move binds exactly the arguments it uses (a remote server refuses extra ones)", async () => {
  const db = await freshDb();
  const { feed } = await splitSite(db);
  await gradedRow(db, "https://moved.dev/");
  const r = await repairRespelled(strictClient(db), [...feed, { name: "Moved", url: "https://moved.dev" }], { write: true, log: quiet, recompute: async () => {} });
  assert.deepEqual(r.failed, []);
  assert.equal(r.merges.length + r.moves.length, 2);
});

test("a move runs against a real libSQL server when one is available (SQLD_BIN)", { skip: !process.env.SQLD_BIN && "SQLD_BIN not set" }, async () => {
  const dir = tmp();
  const port = 18000 + Math.floor(Math.random() * 900);
  const child = spawn(process.env.SQLD_BIN, ["--db-path", path.join(dir, "db"), "--http-listen-addr", `127.0.0.1:${port}`], { stdio: "ignore" });
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
    await migrate(db);
    await ensureRosterSchema(db);
    const { O, N, feed } = await splitSite(db);
    await gradedRow(db, "https://moved.dev/");
    const both = [...feed, { name: "Moved", url: "https://moved.dev" }];
    assert.deepEqual((await repairRespelled(db, both, { log: quiet })).failed, []);
    const r = await repairRespelled(db, both, { write: true, log: quiet, recompute: async () => {} });
    assert.deepEqual(r.failed, []);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url IN (?, 'https://moved.dev/')", [O]), 0);
    assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = ?", [N])).shot_key, "kold");
  } finally {
    child.kill();
  }
});
