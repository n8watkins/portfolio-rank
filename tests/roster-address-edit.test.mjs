// When the community list only changes how a site's address is written (a
// trailing slash, www, http, upper case, a dropped query), the key follows the
// list: the roster sync moves the site's row and everything keyed by it to the
// new spelling (pipeline/site-move.mjs), so feed.json stays exactly upstream's
// spelling and capture, the health check and the app need no change. Also:
// one rule for "same listed site" (pipeline/list-key.mjs), in Node only; the
// guards on mass delists and mass moves; the one-off merge of sites split
// before moves existed (scripts/repair-respelled-sites.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { CLEANUP_SHARE_ENV, MAX_MOVES, allowedShare, dueForCapture, ensureRosterSchema, moveRespelled, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { keysForList, listKey } from "../pipeline/list-key.mjs";
import { buildFeed } from "../pipeline/build-feed.mjs";
import { normKey, findDuplicates } from "../pipeline/health.mjs";
import { planOwnerRemovals } from "../pipeline/owner-removals.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";
import { LEFT_AS_IS, MOVED_COLUMNS, NO_SITE_ADDRESS, SITE_TABLES, applyMove, findRespellings, planMove, schemaOf } from "../pipeline/site-move.mjs";
import { migrate } from "../lib/schema.mjs";
import { repairRespelled } from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const GENERATOR = path.join(ROOT, "pipeline", "generate_feed.py");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const quiet = () => {};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "respell-"));
/** Runs `fn` with these environment variables set, then puts them back. */
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
  return db;
}
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const readmeOf = (entries) => `${entries.map((p) => `- [${p.name}](${p.url}) [Developer]`).join("\n")}\n`;

/** Runs generate_feed.py the way sync-upstream.yml does (the output file is the feed being replaced). */
function generate({ readme, previous = null, excluded = [], additions = [], env = {}, maxShrink = null, dir = tmp(), raw = {} }) {
  const file = (f) => path.join(dir, f);
  fs.writeFileSync(file("README.md"), typeof readme === "string" ? readme : readmeOf(readme));
  fs.writeFileSync(file("excluded.json"), raw.excluded ?? JSON.stringify(excluded));
  fs.writeFileSync(file("additions.json"), JSON.stringify(additions));
  if (previous) fs.writeFileSync(file("feed.json"), JSON.stringify(previous));
  const args = [GENERATOR, file("README.md"), file("feed.json"), "--exclude", file("excluded.json"), "--add", file("additions.json")];
  if (maxShrink != null) args.push("--max-shrink", String(maxShrink));
  const r = spawnSync("python3", args, { encoding: "utf8", env: { ...process.env, [CLEANUP_SHARE_ENV]: "", ...env } });
  const feed = fs.existsSync(file("feed.json")) ? JSON.parse(fs.readFileSync(file("feed.json"), "utf8")) : null;
  return { status: r.status, stdout: r.stdout + r.stderr, feed };
}

const GRADED = {
  sql: `INSERT INTO portfolios (url, name, status, shot_key, ai_rubric, captured_at, delisted_at)
        VALUES (?, 'Ann Lee', 'live', ?, '{"is_portfolio":true,"tier":"A"}', '2026-10-01T00:00:00Z', ?)`,
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
/** Every row of every table, for "exactly as before". */
async function dump(db) {
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map((r) => String(r.name));
  const out = {};
  for (const t of tables) out[t] = await all(db, `SELECT * FROM "${t}" ORDER BY 1, 2`).catch(() => all(db, `SELECT * FROM "${t}"`));
  return JSON.stringify(out);
}

// [the old spelling, the list's new spelling]: one site, so the row moves.
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
  assert.equal(listKey("https://x.dev/?lang=en"), listKey("https://x.dev/"));
});

test("rule 2: a query or hash route tells entries apart only while the list holds two with the same key", () => {
  const twoRoutes = keysForList(["https://host.dev/#/alice", "https://host.dev/#/bob"]);
  assert.notEqual(twoRoutes("https://host.dev/#/alice"), twoRoutes("https://host.dev/#/bob"));
  assert.equal(twoRoutes("https://host.dev/#/alice/"), twoRoutes("https://www.host.dev/#/alice"));
  const twoQueries = keysForList(["https://host.dev/p?id=1", "https://host.dev/p?id=2", "https://host.dev/p?id=1&utm_source=x"]);
  assert.notEqual(twoQueries("https://host.dev/p?id=1"), twoQueries("https://host.dev/p?id=2"));
  assert.equal(twoQueries("https://host.dev/p?id=1"), twoQueries("https://host.dev/p?id=1&utm_source=x"));
  // Alone on the list, the query and route count for nothing.
  const alone = keysForList(["https://host.dev/#/alice"]);
  assert.equal(alone("https://host.dev/#/alice"), alone("https://host.dev/"));
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
  // Two entries with one key: an exclusion of one does not hit the other.
  const pair = buildFeed({ entries: [{ name: "A", url: "https://host.dev/#/alice" }, { name: "B", url: "https://host.dev/#/bob" }], excluded: [{ url: "https://host.dev/#/alice", kind: "down" }] });
  assert.deepEqual(pair.feed.map((p) => p.name), ["B"]);
});

test("the feed holds one entry per site, written as the list spells it", () => {
  const r = buildFeed({
    entries: [
      { name: "A", url: "https://host.example/p?id=1" },
      { name: "B", url: "https://host.example/p?id=2" },
      { name: "C", url: "https://two.example/#/alice" },
      { name: "D", url: "https://two.example/#/bob" },
      { name: "E", url: "https://ann.dev/?utm_source=github" },
      { name: "E again", url: "https://www.ann.dev" },
      { name: "F", url: "https://fred.dev/#home" },
      { name: "F again", url: "https://fred.dev:443" },
    ],
  });
  assert.deepEqual(r.feed.map((p) => p.name), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(r.feed.find((p) => p.name === "E").url, "https://ann.dev/?utm_source=github");
  assert.equal(r.dupes, 2);
  assert.ok(r.feed.every((p) => !("href" in p)));
});

test("generate_feed.py writes upstream's spelling: no previous feed and no database overrides it", () => {
  const r = generate({ readme: [{ name: "Ann", url: "https://ann.dev" }], previous: [{ name: "Ann", url: "https://ann.dev/" }], env: { LOCAL_DB_FILE: "/nonexistent/db.sqlite" } });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.feed, [{ name: "Ann", url: "https://ann.dev", tagline: "Developer" }]);
  const py = fs.readFileSync(GENERATOR, "utf8");
  assert.doesNotMatch(py, /urlsplit|def site_|norm_key/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "pipeline", "build-feed.mjs"), "utf8"), /pipelineDb|createClient|previous\b.*stored/);
});

test("generate_feed.py refuses an exclusions or additions file that is not a list", () => {
  const r = generate({ readme: [{ name: "Gone", url: "https://gone.dev" }], raw: { excluded: JSON.stringify({ url: "https://gone.dev" }) } });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /not a JSON list/);
});

test("owner removals and review relists use the same rule: a dropped query is the same site", () => {
  const feed = [{ name: "One", url: "https://x.dev/?game" }];
  assert.deepEqual(planOwnerRemovals({ removals: [{ url: "https://x.dev/", removedAt: "2026-11-16" }], excluded: [], feed }).feed, []);
  assert.equal(planReviewAdditions({ relists: [{ url: "https://www.x.dev", name: "One" }], additions: [], excluded: [], feed }).added.length, 0);
});

// The health lane's duplicate check and exclusions still use normKey (pull request #247): after it merges,
// pipeline/health.mjs findDuplicates and pipeline/exclusions.mjs must use the rule above. This test waits for that.
test("after #247: the health check's duplicates follow the list's rule (two hash routes are two sites)", { todo: "switch pipeline/health.mjs findDuplicates and pipeline/exclusions.mjs to pipeline/list-key.mjs" }, () => {
  for (const [a, b] of RESPELLINGS) assert.equal(normKey(a), normKey(b), `normKey agrees on ${a} ~ ${b}`);
  const dupes = findDuplicates([{ url: "https://host.dev/#/alice" }, { url: "https://host.dev/#/bob" }]);
  assert.equal(dupes.size, 0, "bob is not a duplicate of alice");
});

// ---------------------------------------------------------------------------
// The nightly move, end to end

/** A site with the history the move must carry: grade, screenshots, a vote, a rating, a claim, a like, a list entry. */
async function siteWithHistory(db, url, i) {
  await gradedRow(db, url, { shot: `shot${i}` });
  await db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES (?, 'https://filler-1.dev', ?, 'human', ?)", args: [url, [url, "https://filler-1.dev"].sort().join("\n"), `r${i}`] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES (?, 1216, 1)", args: [url] });
  await db.execute({ sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', 'verified', 't', '2026-10-01', '2026-10-01')", args: [url, `o${i}`] });
  await db.execute({ sql: "INSERT INTO likes (rater_id, url) VALUES (?, ?)", args: [`r${i}`, url] });
  await db.execute({ sql: "INSERT INTO lists (owner, name, slug) VALUES (?, 'Faves', ?)", args: [`r${i}`, `faves-${i}`] });
  await db.execute({ sql: "INSERT INTO list_items (list_id, url) VALUES ((SELECT id FROM lists WHERE slug = ?), ?)", args: [`faves-${i}`, url] });
}

async function assertOneRowWithHistory(db, spellings, current, i, label) {
  const rows = (await all(db, "SELECT url FROM portfolios")).map((r) => String(r.url)).filter((u) => spellings.includes(u));
  assert.deepEqual(rows, [current], `${label}: one row, under ${current}`);
  const row = await one(db, "SELECT ai_rubric, shot_key FROM portfolios WHERE url = ?", [current]);
  assert.ok(row.ai_rubric, `${label}: grade`);
  assert.equal(row.shot_key, `shot${i}`, `${label}: screenshots`);
  for (const [t, c] of [["votes", "winner"], ["ratings", "url"], ["claims", "url"], ["likes", "url"], ["list_items", "url"]]) {
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [current]), 1, `${label}: ${t}`);
    for (const old of spellings.filter((s) => s !== current)) assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [old]), 0, `${label}: ${t} left on ${old}`);
  }
}

test("after every upstream edit, removal, exclusion and relist, each site has one row with all its history", async () => {
  const db = await freshDb();
  const dir = tmp();
  await liveRows(db, fillers());
  // The sites and every spelling the list gives them in turn.
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
  const now = Object.fromEntries(names.map((k) => [k, sites[k][0]]));
  const night = async ({ drop = [], excluded = [], additions = [] } = {}) => {
    const readme = [...fillers(), ...names.filter((k) => !drop.includes(k)).map((k) => ({ name: k, url: now[k] }))];
    const out = generate({ readme, excluded, additions, dir });
    assert.equal(out.status, 0, out.stdout);
    await syncRoster(db, out.feed, { now: NOW, log: quiet });
    // What capture does next with the same feed: insert a row for every entry that has none.
    for (const p of await dueForCapture(db, out.feed)) await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'pending')", args: [p.url] });
    return out.feed;
  };
  const checkAll = async (label) => {
    for (const [i, k] of names.entries()) await assertOneRowWithHistory(db, sites[k], now[k], i, `${label} / ${k}`);
  };
  const feed0 = await night();
  assert.ok(feed0.some((p) => p.url === "https://host.dev/#/ivy") && feed0.some((p) => p.url === "https://host.dev/#/joe"), "two hash routes, two entries");
  await checkAll("start");
  // Upstream edits: a slash, a path's case, www, http to https, a query dropped, ivy's route respelled.
  for (const k of ["slash", "pathCase", "www", "https", "query", "ivy"]) now[k] = sites[k][1];
  const feed1 = await night({ drop: ["readded", "additions"], excluded: [{ url: "https://gil.dev", kind: "down" }] });
  for (const k of ["slash", "pathCase", "www", "https", "query", "ivy"]) assert.ok(feed1.some((p) => p.url === sites[k][1]), `${k}: the feed has upstream's spelling`);
  await checkAll("edits, a removal and an exclusion");
  assert.ok((await one(db, "SELECT delisted_at FROM portfolios WHERE url = 'https://fay.dev'")).delisted_at, "removed upstream: delisted");
  // Within 30 days: re-added under a new spelling, the exclusion lifted under a new spelling, a relist through additions.
  now.readded = sites.readded[1];
  now.lifted = sites.lifted[1];
  now.additions = sites.additions[1];
  await night({ drop: ["additions"], additions: [{ name: "additions", url: sites.additions[1], source: "review" }] });
  await checkAll("re-added, lifted, relisted");
  for (const k of names) assert.equal((await one(db, "SELECT delisted_at FROM portfolios WHERE url = ?", [now[k]])).delisted_at, null, `${k} listed`);
  // A second night changes nothing.
  const before = await dump(db);
  await night({ drop: ["additions"], additions: [{ name: "additions", url: sites.additions[1], source: "review" }] });
  assert.equal(await dump(db), before);
});

test("syncRoster refuses more than the usual number of moves at once, unless the owner allows a cleanup", async () => {
  const db = await freshDb({ full: false });
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev/` }));
  await liveRows(db, feed);
  const respell = (k) => feed.map((p, i) => (i < k ? { ...p, url: p.url.replace(/\/$/, "") } : p));
  const logs = [];
  await assert.rejects(syncRoster(db, respell(MAX_MOVES + 1), { now: NOW, log: (m) => logs.push(m) }), new RegExp(`respells ${MAX_MOVES + 1} sites at once.*${CLEANUP_SHARE_ENV}`, "s"));
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://site0.dev/'"), 1, "nothing moved");
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE delisted_at IS NOT NULL"), 0, "nothing delisted");
  const summaryFile = path.join(tmp(), "summary.md");
  await withEnv({ GITHUB_STEP_SUMMARY: summaryFile }, async () => {
    assert.equal((await syncRoster(db, respell(MAX_MOVES), { now: NOW, log: quiet })).moved, MAX_MOVES);
  });
  await withEnv({ [CLEANUP_SHARE_ENV]: "0.5" }, async () => {
    assert.equal((await syncRoster(db, respell(300), { now: NOW, log: quiet })).moved, 300 - MAX_MOVES);
  });
  assert.match(fs.readFileSync(summaryFile, "utf8"), /### Address moves\n\n- moved https:\/\/site0\.dev\/ -> https:\/\/site0\.dev: renamed/);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios"), 600);
});

test("a move that fails changes nothing of its site, the others still move, and the sync fails with a notice", async () => {
  const db = await freshDb();
  await liveRows(db, fillers());
  await siteWithHistory(db, "https://ann.dev/", 0);
  await siteWithHistory(db, "https://bob.dev/", 1);
  await db.execute("CREATE TRIGGER no_bob BEFORE UPDATE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const feed = [...fillers(), { name: "Ann", url: "https://ann.dev" }, { name: "Bob", url: "https://bob.dev" }];
  await assert.rejects(syncRoster(db, feed, { now: NOW, log: quiet }), /1 address move\(s\) failed and changed nothing: https:\/\/bob\.dev\/ -> https:\/\/bob\.dev \(.*refused/);
  await assertOneRowWithHistory(db, ["https://ann.dev/", "https://ann.dev"], "https://ann.dev", 0, "ann moved");
  await assertOneRowWithHistory(db, ["https://bob.dev/", "https://bob.dev"], "https://bob.dev/", 1, "bob untouched");
  assert.equal((await one(db, "SELECT delisted_at FROM portfolios WHERE url = 'https://bob.dev/'")).delisted_at, null, "bob not delisted either");
});

test("a move interrupted at any statement leaves the database exactly as it was", async () => {
  const db = await freshDb();
  await liveRows(db, fillers(5));
  await siteWithHistory(db, "https://ann.dev/", 0);
  await db.execute("INSERT INTO comparisons (created_at, rater_type, method, ranking) VALUES ('2026-10-01', 'ai', 'one_on_one', '[\"https://ann.dev/\",\"https://filler-1.dev\"]')");
  const plan = await planMove(db, { from: "https://ann.dev/", to: "https://ann.dev" });
  assert.ok(plan.statements.length > 5);
  const before = await dump(db);
  for (let at = 0; at <= plan.statements.length; at += 3) {
    const broken = { ...plan, statements: [...plan.statements.slice(0, at), { sql: "INSERT INTO no_such_table VALUES (1)", args: [] }, ...plan.statements.slice(at)] };
    await assert.rejects(applyMove(db, broken));
    assert.equal(await dump(db), before, `interrupted at statement ${at}`);
  }
  await applyMove(db, plan);
  assert.notEqual(await dump(db), before);
});

test("history cast on the old address after the move (a page still showing it) follows the site at the next sync", async () => {
  const db = await freshDb();
  await liveRows(db, fillers());
  await siteWithHistory(db, "https://ann.dev/", 0);
  const feed = [...fillers(), { name: "Ann", url: "https://ann.dev" }];
  assert.equal((await syncRoster(db, feed, { now: NOW, log: quiet })).moved, 1);
  // The site deployed before the new feed still shows the old address: a like and a vote land there.
  await db.execute("INSERT INTO likes (rater_id, url) VALUES ('late', 'https://ann.dev/')");
  await db.execute("INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id) VALUES ('https://filler-2.dev', 'https://ann.dev/', 'x', 'human', 'late')");
  const logs = [];
  await syncRoster(db, feed, { now: new Date(NOW.getTime() + DAY), log: (m) => logs.push(m) });
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM likes WHERE url = 'https://ann.dev/'"), 0);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM likes WHERE url = 'https://ann.dev'"), 2);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM votes WHERE loser = 'https://ann.dev'"), 1);
  assert.match(logs.join("\n"), /moved history left on https:\/\/ann\.dev\/ -> https:\/\/ann\.dev/);
  // A move back (upstream reverts the spelling) never ping-pongs the history.
  const back = [...fillers(), { name: "Ann", url: "https://ann.dev/" }];
  await syncRoster(db, back, { now: new Date(NOW.getTime() + 2 * DAY), log: quiet });
  await syncRoster(db, back, { now: new Date(NOW.getTime() + 3 * DAY), log: quiet });
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM likes WHERE url = 'https://ann.dev/'"), 2);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url IN ('https://ann.dev/', 'https://ann.dev')"), 1);
});

test("the purge keeps a delisted row whose site is listed under another address", async () => {
  const db = await freshDb({ full: false });
  await liveRows(db, fillers(20));
  await gradedRow(db, "https://ann.dev/", { delisted: new Date(NOW.getTime() - 40 * DAY).toISOString() });
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://ann.dev', 'live')");
  await db.execute({ sql: "INSERT INTO portfolios (url, shot_key, delisted_at) VALUES ('https://gone.dev', 'kg', ?)", args: [new Date(NOW.getTime() - 40 * DAY).toISOString()] });
  const deleted = [];
  const logs = [];
  assert.deepEqual(await purgeDelisted(db, { now: NOW, deleteShots: async (k) => deleted.push(k), log: (m) => logs.push(m) }), { due: 1, purged: 1, failed: 0 });
  assert.deepEqual(deleted, ["kg"]);
  assert.match(logs.join("\n"), /kept https:\/\/ann\.dev\/: the same site is listed under another/);
});

// ---------------------------------------------------------------------------
// The guards

test("syncRoster refuses to delist more than 15% of the list at once; the owner's share only ever raises a limit", async () => {
  const db = await freshDb({ full: false });
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const other = (i) => ({ name: `Q${i}`, url: `https://other${i}.dev` });
  const mix = (k) => feed.map((p, i) => (i < k ? other(i) : p));
  await assert.rejects(syncRoster(db, mix(600), { now: NOW, log: quiet }), new RegExp(`600 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  await assert.rejects(syncRoster(db, mix(91), { now: NOW, log: quiet }), /91 of 600/);
  // A share below the default must not lower it.
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
  const allowed = generate({ readme: smaller, previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "0.3" } });
  assert.equal(allowed.status, 0, allowed.stdout);
  assert.equal(allowed.feed.length, 80);
  // A share below --max-shrink does not lower it: 4 of 100 still passes with 0.02.
  assert.equal(generate({ readme: all100.slice(0, 96), previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "0.02" } }).status, 0);
  assert.notEqual(generate({ readme: smaller, previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "lots" } }).status, 0);
});

// ---------------------------------------------------------------------------
// What a move does, table by table

test("every table in the schema is either moved, left on purpose, or holds no site address", async () => {
  const db = await freshDb();
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  const lists = [Object.keys(SITE_TABLES), Object.keys(LEFT_AS_IS), NO_SITE_ADDRESS];
  for (const t of tables) assert.equal(lists.filter((l) => l.includes(t)).length, 1, `table ${t}: add it to exactly one list in pipeline/site-move.mjs`);
  const ADDRESS_COLUMN = /^(url|urls|winner|loser|portfolio_url|item|shown|ranking|from_url|to_url)$/;
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => ADDRESS_COLUMN.test(c)), [], `${t} has an address column`);
  }
  // tier_undo.w and .l are packed rating deltas (lib/tiers-db.mjs pack), not addresses.
  assert.ok(NO_SITE_ADDRESS.includes("tier_undo"));
  assert.ok(!MOVED_COLUMNS.some(([t]) => t === "tier_undo"));
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
    // A unique constraint without the address would make the two rows clash on their own: a person must decide.
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
  const r = await repairRespelled(db, [{ name: "Ann", url: N }], { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  for (const tc of clashing) {
    const [t, c] = tc.split(".");
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [O]), 0, `${tc} left behind`);
    assert.equal(await n(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [N]), 1, `${tc} kept`);
  }
});

test("a merge takes the grade from whichever row has one and the capture from whichever is live, apart", async () => {
  const cases = [
    // [listed row: graded, live] x [old row: graded, live] -> expected grade, shot
    { cur: { graded: true, live: false }, old: { graded: false, live: true }, grade: "cur", shot: "kold" },
    { cur: { graded: false, live: true }, old: { graded: true, live: false }, grade: "old", shot: "knew" },
    { cur: { graded: false, live: false }, old: { graded: true, live: true }, grade: "old", shot: "kold" },
    { cur: { graded: true, live: true }, old: { graded: true, live: true }, grade: "cur", shot: "knew" },
  ];
  for (const c of cases) {
    const db = await freshDb();
    const insert = (url, side, shot) =>
      db.execute({
        sql: "INSERT INTO portfolios (url, status, shot_key, ai_rubric) VALUES (?, ?, ?, ?)",
        args: [url, side.live ? "live" : "error", shot, side.graded ? JSON.stringify({ tier: shot }) : null],
      });
    await insert("https://ann.dev/", c.old, "kold");
    await insert("https://ann.dev", c.cur, "knew");
    await repairRespelled(db, [{ name: "Ann", url: "https://ann.dev" }], { write: true, log: quiet });
    const row = await one(db, "SELECT status, shot_key, ai_rubric FROM portfolios WHERE url = 'https://ann.dev'");
    const label = JSON.stringify(c);
    assert.equal(row.shot_key, c.shot, `${label}: capture`);
    assert.equal(row.status, c.shot === "kold" ? (c.old.live ? "live" : "error") : c.cur.live ? "live" : "error", `${label}: status goes with the capture`);
    assert.equal(JSON.parse(String(row.ai_rubric)).tier, c.grade === "cur" ? "knew" : "kold", `${label}: grade`);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://ann.dev/'"), 0);
  }
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
  await db.execute({ sql: "INSERT INTO rubric_history (url, model, rubric, judged_at, replaced_at) VALUES (?, 'm', '{}', '2026-10-01', '2026-10-02')", args: [O] });
  await db.execute({ sql: "INSERT INTO comparisons (created_at, rater_type, method, ranking) VALUES ('2026-10-01', 'ai', 'one_on_one', ?)", args: [JSON.stringify([O, "https://a.dev"])] });
  await db.execute({ sql: "INSERT INTO tier_ratings (url, mu, sigma, rating, bucket) VALUES (?, 25, 8, 1, 1)", args: [O] });
  await db.execute({ sql: "INSERT INTO cache (k, v, at) VALUES (?, '{}', 1)", args: [`psi:${O}`] });
  const feed = [{ name: "Ann Lee", url: N }, ...["a", "b", "c"].map((x) => ({ name: x, url: `https://${x}.dev` }))];
  return { O, N, feed };
}

test("the repair merges a split site's grade, screenshots, votes, ratings and owner settings into its listed address", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const before = await dump(db);
  const dry = await repairRespelled(db, feed, { log: quiet });
  assert.deepEqual(dry.merges.map((p) => [p.from, p.to]), [[O, N]]);
  assert.equal(await dump(db), before, "a dry run changes nothing");
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0);
  const row = await one(db, "SELECT status, shot_key, ai_rubric FROM portfolios WHERE url = ?", [N]);
  assert.deepEqual([row.status, row.shot_key], ["live", "kold"]);
  assert.match(String(row.ai_rubric), /"tier":"A"/);
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
  assert.equal((await one(db, "SELECT url FROM list_items")).url, N);
  assert.deepEqual(Object.values(await one(db, "SELECT url, hide_grade FROM portfolio_owner")), [N, 1]);
  assert.equal((await one(db, "SELECT url FROM rubric_history")).url, N);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?", [O]), 0);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM cache"), 0);
  const again = await repairRespelled(db, feed, { log: quiet });
  assert.deepEqual([again.merges, again.moves], [[], []]);
});

test("star counts are left to the votes triggers; recounted only where the triggers are missing", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  const withTriggers = await planMove(db, { from: O, to: N });
  assert.ok(!withTriggers.statements.some((s) => /star_counts/.test(s.sql)));
  const schema = await schemaOf(db);
  schema.triggers.delete("votes_star_update");
  const without = await planMove(db, { from: O, to: N }, schema);
  assert.ok(without.statements.some((s) => /INSERT INTO star_counts/.test(s.sql)));
});

test("a move collapses only the duplicate votes it makes, never older ones, and takes their points back", async () => {
  const db = await freshDb();
  const { O, N, feed } = await splitSite(db);
  const vote = (w, l, rater, delta, pairKey = [w, l].sort().join("\n")) =>
    db.execute({ sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta) VALUES (?, ?, ?, 'ai', ?, ?)", args: [w, l, pairKey, rater, delta] });
  // The AI rater voted on (ann, a) under both addresses, and once ann against itself.
  await vote(O, "https://a.dev", "ai", 10);
  await vote(N, "https://a.dev", "ai", 8);
  await vote(O, N, "ai", 6);
  // Two old duplicate votes (NULL pair_key, which the unique index allows) that never involved the old address.
  await vote(N, "https://b.dev", "legacy", 4, null);
  await vote(N, "https://b.dev", "legacy", 4, null);
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 10 + 6, votes = votes + 2 WHERE url = ?", args: [O] });
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 8 - 6 + 8, votes = votes + 4 WHERE url = ?", args: [N] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1182, 2)" });
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  const votes = await all(db, "SELECT winner, loser, rater_id, pair_key FROM votes ORDER BY id");
  assert.ok(votes.every((v) => v.winner !== v.loser), "no vote of a site against itself");
  assert.ok(votes.every((v) => !String(v.pair_key ?? "").includes(O)), "no pair key names the old address");
  // The vote that did not move stays; the moved duplicate goes.
  assert.deepEqual(votes.filter((v) => v.rater_id === "ai").map((v) => v.winner), [N]);
  assert.equal(votes.filter((v) => v.rater_id === "legacy").length, 2, "older duplicates are not the move's business");
  // ELO: (1260 + 16) + (1190 + 10) - 1200 = 1276; the dropped moved vote (10) and the self-vote (6, cancels) come back off: 1266.
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [N])).elo, 1266);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = 'https://a.dev'")).elo, 1192);
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
  assert.deepEqual((await repairRespelled(db, feed, { write: true, log: quiet })).failed, []);
  assert.deepEqual(
    (await all(db, "SELECT url, owner, status FROM claims ORDER BY owner")).map((c) => [c.url, c.owner, c.status]),
    [[N, "u1", "verified"], [N, "u2", "verified"], [N, "u3", "review"]]
  );
});

test("a repair pair that fails is reported, changes nothing, and the run goes on with the rest", async () => {
  const db = await freshDb();
  const { O, N } = await splitSite(db);
  await gradedRow(db, "https://bob.dev/", { shot: "kb", delisted: "2026-11-01T00:00:00Z" });
  const review = (url) =>
    db.execute({ sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('b1', ?, 'g', 'c', 'p', 1, '{}', '2026-10-01')", args: [url] });
  await review(O);
  await review(N);
  await db.execute("CREATE TRIGGER no_bob BEFORE UPDATE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const logs = [];
  const r = await repairRespelled(db, [{ name: "Bob", url: "https://bob.dev" }, { name: "Ann", url: N }], { write: true, log: (m) => logs.push(m) });
  assert.deepEqual(r.failed.map((f) => f.from), ["https://bob.dev/"]);
  assert.match(logs.join("\n"), /FAILED https:\/\/bob\.dev\/ -> https:\/\/bob\.dev: .*refused/);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://bob.dev/'"), 1);
  assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O]), 0, "ann merged after bob failed");
  assert.deepEqual((await all(db, "SELECT url FROM status_reviews")).map((x) => x.url), [N]);
});

test("findRespellings: a rename keeps the screenshots' key; two rows or two entries for one key wait for a person", async () => {
  const db = await freshDb();
  await gradedRow(db, "https://ann.dev/");
  await gradedRow(db, "https://two.dev/", { shot: "k1" });
  await gradedRow(db, "http://two.dev", { shot: "k2" });
  const feed = [{ name: "Ann", url: "https://ANN.dev" }, { name: "Two", url: "https://www.two.dev" }];
  const { moves, merges, skipped } = await findRespellings(db, feed);
  assert.deepEqual(moves, [{ from: "https://ann.dev/", to: "https://ANN.dev" }]);
  assert.deepEqual(merges, []);
  assert.deepEqual(skipped.map((s) => s.rows.sort()), [["http://two.dev", "https://two.dev/"]]);
  const plan = await planMove(db, moves[0]);
  assert.equal(plan.portfolios, "renamed");
  await applyMove(db, plan);
  assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = 'https://ANN.dev'")).shot_key, "kold");
  assert.equal((await one(db, "SELECT to_url FROM site_moves WHERE from_url = 'https://ann.dev/'")).to_url, "https://ANN.dev");
});

test("moveRespelled's dry run lists the moves and changes nothing", async () => {
  const db = await freshDb();
  await liveRows(db, fillers());
  await siteWithHistory(db, "https://ann.dev/", 0);
  const before = await dump(db);
  const logs = [];
  const plans = await moveRespelled(db, [...fillers(), { name: "Ann", url: "https://ann.dev" }], { dryRun: true, log: (m) => logs.push(m) });
  assert.deepEqual(plans.map((p) => [p.from, p.to]), [["https://ann.dev/", "https://ann.dev"]]);
  assert.match(logs.join("\n"), /would move https:\/\/ann\.dev\/ -> https:\/\/ann\.dev: renamed; votes 1/);
  assert.equal(await dump(db), before);
});

// ---------------------------------------------------------------------------
// A remote libSQL server

/** What a remote libSQL server (Turso, sqld) checks: exactly as many arguments as placeholders. */
function assertStrictArgs(statements) {
  for (const s of statements) {
    const numbered = [...s.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const plain = (s.sql.replace(/\?\d+/g, "").match(/\?/g) ?? []).length;
    assert.ok(!(numbered.length && plain), `mixed placeholders: ${s.sql}`);
    const want = numbered.length ? Math.max(...numbered) : plain;
    assert.equal((s.args ?? []).length, want, `${want} placeholder(s), ${(s.args ?? []).length} argument(s): ${s.sql.replace(/\s+/g, " ")}`);
  }
}
const strictClient = (db) => ({
  execute: (stmt) => {
    if (typeof stmt === "object") assertStrictArgs([stmt]);
    return db.execute(stmt);
  },
  batch: (stmts, mode) => {
    assertStrictArgs(stmts.filter((s) => typeof s === "object"));
    return db.batch(stmts, mode);
  },
});

test("every statement of a move binds exactly the arguments it uses (a remote server refuses extra ones)", async () => {
  const db = await freshDb();
  const { feed } = await splitSite(db);
  await gradedRow(db, "https://moved.dev/");
  const both = [...feed, { name: "Moved", url: "https://moved.dev" }];
  const r = await repairRespelled(strictClient(db), both, { write: true, log: quiet });
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
    const r = await repairRespelled(db, both, { write: true, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.equal(await n(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url IN (?, 'https://moved.dev/')", [O]), 0);
    assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = ?", [N])).shot_key, "kold");
  } finally {
    child.kill();
  }
});
