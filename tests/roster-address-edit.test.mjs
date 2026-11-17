// When the community list only spells a site's address another way (a
// trailing slash, www, http, upper case, the default port, a tracking
// parameter), the site keeps its one row, grade, votes, ratings and
// screenshots, whatever happens to it in between (excluded, removed upstream,
// relisted), and people are sent to the list's current spelling:
//   - one rule decides "same listed site" (pipeline/list-key.mjs listKey),
//     in Node only; generate_feed.py only parses the README;
//   - the feed build gives each entry the address its site is stored under in
//     the database (the durable record) and the list's spelling as `href`;
//   - syncRoster does the same, in place, to the entries a job hands it;
//   - purgeDelisted never deletes a row whose site is listed under another
//     address; syncRoster refuses a mass delist;
//   - scripts/repair-respelled-sites.mjs merges rows split before this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import * as roster from "../pipeline/roster.mjs";
import { CLEANUP_SHARE_ENV, dueForCapture, ensureRosterSchema, purgeDelisted, syncRoster } from "../pipeline/roster.mjs";
import { feedHref, listKey, pinToStored } from "../pipeline/list-key.mjs";
import { buildFeed } from "../pipeline/build-feed.mjs";
import { planOwnerRemovals } from "../pipeline/owner-removals.mjs";
import { planReviewAdditions } from "../pipeline/review-additions.mjs";
import { migrate } from "../lib/schema.mjs";
import {
  LEFT_AS_IS,
  MOVED_COLUMNS,
  NO_SITE_ADDRESS,
  SITE_TABLES,
  applyMove,
  findRespelled,
  planMove,
  repairRespelled,
  schemaOf,
} from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const GENERATOR = path.join(ROOT, "pipeline", "generate_feed.py");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const quiet = () => {};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "respell-"));
async function freshDb({ full = false } = {}) {
  const file = path.join(tmp(), "db.sqlite");
  const db = createClient({ url: `file:${file}` });
  if (full) await migrate(db);
  await ensureRosterSchema(db);
  db.file = file;
  return db;
}
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const readmeOf = (entries) => `${entries.map((p) => `- [${p.name}](${p.url}) [Developer]`).join("\n")}\n`;

/**
 * Runs generate_feed.py the way sync-upstream.yml does: the feed.json being
 * replaced is the output file; `db` is the database it reads (LOCAL_DB_FILE).
 */
function generate({ readme, previous = null, excluded = [], additions = [], env = {}, maxShrink = null, db = null, dir = tmp() }) {
  const file = (f) => path.join(dir, f);
  fs.writeFileSync(file("README.md"), typeof readme === "string" ? readme : readmeOf(readme));
  fs.writeFileSync(file("excluded.json"), JSON.stringify(excluded));
  fs.writeFileSync(file("additions.json"), JSON.stringify(additions));
  if (previous) fs.writeFileSync(file("feed.json"), JSON.stringify(previous));
  const args = [GENERATOR, file("README.md"), file("feed.json"), "--exclude", file("excluded.json"), "--add", file("additions.json")];
  if (maxShrink != null) args.push("--max-shrink", String(maxShrink));
  const base = { ...process.env, [CLEANUP_SHARE_ENV]: "" };
  delete base.LOCAL_DB_FILE;
  delete base.TURSO_DATABASE_URL;
  const r = spawnSync("python3", args, { encoding: "utf8", env: { ...base, ...(db ? { LOCAL_DB_FILE: db.file } : {}), ...env } });
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
/** Listed rows, in one transaction (row by row is slow on a busy disk). */
async function liveRows(db, entries, { graded = false } = {}) {
  await db.batch(
    entries.map((p) =>
      graded ? { ...GRADED, args: [p.url, `k${p.name}`, null] } : { sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] }
    ),
    "write"
  );
}
const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));
const rowsOfSite = async (db, url) => (await all(db, "SELECT url FROM portfolios")).map((r) => String(r.url)).filter((u) => listKey(u) === listKey(url));

// [stored address, the list's new spelling]
const RESPELLINGS = [
  ["https://ann.dev/", "https://ann.dev"],
  ["https://ann.dev", "https://ann.dev/"],
  ["https://www.ann.dev", "https://ann.dev"],
  ["https://ann.dev", "http://ann.dev"],
  ["https://ann.dev", "https://ANN.dev/"],
  ["https://ann.dev", "https://ann.dev:443/"],
  ["https://ann.dev", "https://ann.dev/?utm_source=github&utm_medium=readme"],
  ["https://ann.dev/?ref=emmabostian", "https://ann.dev"],
  ["https://ann.dev/#home", "https://ann.dev"],
  ["https://ann.github.io/Portfolio/", "https://ann.github.io/portfolio"],
  ["https://straße.de/", "https://xn--strae-oqa.de"],
];
// Different sites: a domain move, another page, another project page, another hash route or query.
const NOT_RESPELLINGS = [
  ["https://ann.dev", "https://annlee.dev"],
  ["https://ann.dev", "https://ann.dev/en"],
  ["https://ann.github.io/portfolio", "https://ann.github.io/portfolio-v2"],
  ["https://host.dev/#/ann", "https://host.dev/#/bob"],
  ["https://host.dev/p?id=1", "https://host.dev/p?id=2"],
  ["https://host.dev/p?id=1", "https://host.dev/p"],
];

// ---------------------------------------------------------------------------
// One rule, one place

test("listKey is the one rule: same key for every respelling, another key for another site", () => {
  for (const [a, b] of RESPELLINGS) assert.equal(listKey(a), listKey(b), `${a} ~ ${b}`);
  for (const [a, b] of NOT_RESPELLINGS) assert.notEqual(listKey(a), listKey(b), `${a} !~ ${b}`);
  // The old two-rule helpers are gone, and nothing is called sameSite here (lib/ownership/verify.mjs has one).
  for (const name of ["siteOf", "sameSite", "matchSameSite"]) assert.equal(roster[name], undefined, name);
});

test("generate_feed.py leaves the site rule to Node: one entry per site, as `new URL` reads addresses", () => {
  const r = generate({
    readme: [
      { name: "A", url: "https://straße.de/" },
      { name: "A again", url: "https://xn--strae-oqa.de" },
      { name: "B", url: "https://x.dev/a^b" },
      { name: "B again", url: "https://x.dev/a%5Eb/" },
    ],
  });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(r.feed.map((p) => p.name), ["A", "B"]);
  const py = fs.readFileSync(GENERATOR, "utf8");
  assert.doesNotMatch(py, /urlsplit|def site_|norm_key/);
});

// ---------------------------------------------------------------------------
// (a) The stored address is the key; the list's spelling is where people go

test("the feed keeps a site's stored address and sends people to the list's current spelling", async () => {
  for (const [stored, now] of RESPELLINGS) {
    const db = await freshDb();
    await gradedRow(db, stored);
    const out = generate({ readme: [{ name: "Ann Lee", url: now }], db });
    assert.equal(out.status, 0, out.stdout);
    assert.deepEqual(out.feed, [{ name: "Ann Lee", url: stored, ...(stored === now ? {} : { href: now }), tagline: "Developer" }], `${stored} -> ${now}`);
    assert.equal(feedHref(out.feed[0]), now);
  }
  for (const [stored, now] of NOT_RESPELLINGS) {
    const db = await freshDb();
    await gradedRow(db, stored);
    const out = generate({ readme: [{ name: "Ann Lee", url: now }], db });
    assert.deepEqual(out.feed.map((p) => [p.url, p.href]), [[now, undefined]], `${stored} -> ${now} is another site`);
  }
});

test("a site keeps one row and its history through upstream edits, removals, exclusions and relists", async () => {
  const db = await freshDb({ full: true });
  const dir = tmp();
  const ann = (url) => ({ name: "Ann Lee", url });
  // The nightly sync: the feed build (with the database), then the roster sync and the capture queue on the same entries.
  const night = async (readme, { excluded = [], additions = [] } = {}) => {
    const out = generate({ readme: [...fillers(), ...readme], excluded, additions, db, dir });
    assert.equal(out.status, 0, out.stdout);
    await syncRoster(db, out.feed, { now: NOW, log: quiet });
    for (const p of await dueForCapture(db, out.feed)) {
      await db.execute({ sql: "INSERT OR IGNORE INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] });
    }
    return out.feed;
  };
  await liveRows(db, fillers());
  await gradedRow(db, "https://ann.dev/");
  await db.execute("INSERT INTO votes (winner, loser, rater_id) VALUES ('https://ann.dev/', 'https://filler-1.dev', 'r1')");
  const check = async (feed, href) => {
    assert.deepEqual(await rowsOfSite(db, "https://ann.dev"), ["https://ann.dev/"], "one row, the stored one");
    const row = await one(db, "SELECT ai_rubric, shot_key FROM portfolios WHERE url = 'https://ann.dev/'");
    assert.ok(row.ai_rubric && row.shot_key === "kold", "its grade and screenshots stay");
    if (feed) {
      const e = feed.find((p) => p.name === "Ann Lee");
      assert.equal(e.url, "https://ann.dev/");
      assert.equal(feedHref(e), href);
    }
  };
  // 1. Upstream drops the trailing slash.
  await check(await night([ann("https://ann.dev")]), "https://ann.dev");
  // 2. Upstream removes the site: delisted, still one row.
  await night([]);
  assert.ok((await one(db, "SELECT delisted_at FROM portfolios WHERE url = 'https://ann.dev/'")).delisted_at);
  await check(null);
  // 3. Upstream lists it again as http://www: relisted under its stored address.
  await check(await night([ann("http://www.ann.dev")]), "http://www.ann.dev");
  assert.equal((await one(db, "SELECT delisted_at FROM portfolios WHERE url = 'https://ann.dev/'")).delisted_at, null);
  // 4. Excluded (down) under another spelling, then the exclusion is lifted: same row.
  await night([ann("https://www.ann.dev/")], { excluded: [{ url: "https://ann.dev", kind: "down" }] });
  await check(await night([ann("https://www.ann.dev/")]), "https://www.ann.dev/");
  // 5. Relisted by the owner through additions, spelled yet another way, while upstream no longer has it.
  await check(await night([], { additions: [{ name: "Ann Lee", url: "https://Ann.dev/?utm_source=x", source: "review" }] }), "https://Ann.dev/?utm_source=x");
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = 'https://ann.dev/'")).n, 1);
});

test("syncRoster gives the entries a job holds their stored address, so the job never inserts a second row", async () => {
  const db = await freshDb();
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev/` }));
  await liveRows(db, feed, { graded: true });
  // A feed built without the database spells every address another way.
  const respelled = feed.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  const logs = [];
  assert.deepEqual(await syncRoster(db, respelled, { now: NOW, log: (m) => logs.push(m) }), { delisted: 0, relisted: 0, listed: 600, respelled: 600 });
  assert.match(logs[0], /https:\/\/site0\.dev is stored as https:\/\/site0\.dev\//);
  assert.deepEqual([respelled[0].url, respelled[0].href], ["https://site0.dev/", "https://site0.dev"]);
  // The capture queue (pipeline/capture.mjs) works on the same entries: nothing new to capture.
  assert.deepEqual(await dueForCapture(db, respelled), []);
  // A later job (judge, compare) reads the feed again: still nothing delisted, still 600 rows.
  const again = feed.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  assert.equal((await syncRoster(db, again, { now: NOW, log: quiet })).delisted, 0);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios")).n, 600);
  // And 31 days later nothing is purged.
  assert.deepEqual(await purgeDelisted(db, { now: new Date(NOW.getTime() + 31 * DAY), deleteShots: async () => {}, log: quiet }), { due: 0, purged: 0, failed: 0 });
});

test("scripts/check-data.mjs accepts an href only as another web address", async () => {
  const { checkData } = await import("../scripts/check-data.mjs");
  const feed = (extra) => Array.from({ length: 120 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev/`, ...(i === 0 ? extra : {}) }));
  const run = (extra) => checkData({ feed: feed(extra), additions: [], excluded: [] });
  assert.deepEqual(run({ href: "https://p0.dev" }), []);
  assert.match(run({ href: "https://p0.dev/" }).join(), /href that is not another web address/);
  assert.match(run({ href: "mailto:a@b.c" }).join(), /href that is not another web address/);
});

test("pinToStored gives an address to one entry only, prefers the listed row, and keeps an exact match", () => {
  const stored = [
    { url: "http://x.dev", listed: false, graded: true },
    { url: "https://x.dev/", listed: true, graded: false },
    { url: "https://y.dev", listed: true, graded: false },
  ];
  const entries = [{ url: "https://www.x.dev" }, { url: "https://X.dev?utm_source=a" }, { url: "https://y.dev" }, { url: "https://x.dev/p?id=1" }];
  pinToStored(entries, stored);
  assert.deepEqual(entries, [
    { url: "https://x.dev/", href: "https://www.x.dev" },
    { url: "http://x.dev", href: "https://X.dev?utm_source=a" },
    { url: "https://y.dev" },
    { url: "https://x.dev/p?id=1" },
  ]);
});

test("the purge keeps a delisted row whose site is listed under another address", async () => {
  const db = await freshDb();
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
// (b) a mass delist

test("syncRoster refuses to delist more than 15% of the list at once, unless the owner allows a cleanup", async () => {
  const db = await freshDb();
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const other = () => Array.from({ length: 600 }, (_, i) => ({ name: `Q${i}`, url: `https://other${i}.dev` }));
  await assert.rejects(syncRoster(db, other(), { now: NOW, log: quiet }), new RegExp(`600 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE delisted_at IS NOT NULL")).n, 0);
  const mix = (n) => feed.map((p, i) => (i < n ? other()[i] : p));
  await assert.rejects(syncRoster(db, mix(91), { now: NOW, log: quiet }), /91 of 600/);
  assert.equal((await syncRoster(db, mix(90), { now: NOW, log: quiet })).delisted, 90);
  const db2 = await freshDb();
  await liveRows(db2, feed);
  const before = process.env[CLEANUP_SHARE_ENV];
  try {
    process.env[CLEANUP_SHARE_ENV] = "nonsense";
    await assert.rejects(syncRoster(db2, mix(300), { now: NOW, log: quiet }), /not a share between 0 and 1/);
    process.env[CLEANUP_SHARE_ENV] = "0.5";
    assert.equal((await syncRoster(db2, mix(300), { now: NOW, log: quiet })).delisted, 300);
  } finally {
    if (before === undefined) delete process.env[CLEANUP_SHARE_ENV];
    else process.env[CLEANUP_SHARE_ENV] = before;
  }
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
  assert.notEqual(generate({ readme: smaller, previous: all100, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "lots" } }).status, 0);
});

// ---------------------------------------------------------------------------
// (c) exclusions and duplicates

test("an excluded site stays out under every spelling of it, and only those", () => {
  const excluded = [{ url: "https://www.gone.dev/", kind: "owner_request" }, { url: "https://user.github.io/portfolio", kind: "not_portfolio" }];
  const out = [
    "https://www.gone.dev/", "https://gone.dev", "http://gone.dev/", "HTTPS://WWW.GONE.DEV", "https://gone.dev/?utm=x",
    "https://gone.dev/?utm_source=github", "https://gone.dev/#home", "https://gone.dev:443/", "http://gone.dev:80",
    "https://user.github.io/portfolio/", "https://user.github.io/Portfolio",
  ];
  // Other sites: another page, another subdomain, the account's root and its other project pages, a real query.
  // (/index.html stays a page of its own until lib/grader/url.mjs siteKeyOf says otherwise.)
  const listed = ["https://gone.dev/en", "https://blog.gone.dev", "https://user.github.io/portfolio-v2", "https://user.github.io", "https://gone.dev/?page=2"];
  for (const url of [...out, ...listed]) {
    const feed = buildFeed({ entries: [{ name: "X", url }], excluded }).feed;
    assert.deepEqual(feed.map((p) => p.url), listed.includes(url) ? [url] : [], url);
  }
});

test("two entries that only a real query or a hash route tells apart are both kept; real duplicates go", () => {
  const r = buildFeed({
    entries: [
      { name: "A", url: "https://host.example/p?id=1" },
      { name: "B", url: "https://host.example/p?id=2" },
      { name: "C", url: "https://host.example/#/alice" },
      { name: "D", url: "https://host.example/#/bob" },
      { name: "E", url: "https://ann.dev/?utm_source=github" },
      { name: "E again", url: "https://www.ann.dev" },
      { name: "F", url: "https://fred.dev/#home" },
      { name: "F again", url: "https://fred.dev:443" },
    ],
  });
  assert.deepEqual(r.feed.map((p) => p.name), ["A", "B", "C", "D", "E", "F"]);
  assert.equal(r.dupes, 2);
});

test("owner removals and review relists use the same rule: another query is another site", () => {
  const feed = [{ name: "One", url: "https://host.dev/p?id=1" }, { name: "Two", url: "https://host.dev/p?id=2" }];
  const removed = planOwnerRemovals({ removals: [{ url: "https://host.dev/p?id=1", removedAt: "2026-11-16" }], excluded: [], feed });
  assert.deepEqual(removed.feed.map((p) => p.name), ["Two"]);
  const relisted = planReviewAdditions({ relists: [{ url: "https://host.dev/p?id=2", name: "Two" }], additions: [], excluded: [], feed: [feed[0]] });
  assert.deepEqual(relisted.added.map((a) => a.url), ["https://host.dev/p?id=2"]);
  // And a respelling is still the same site.
  assert.equal(planReviewAdditions({ relists: [{ url: "https://www.host.dev/p/?id=1", name: "One" }], additions: [], excluded: [], feed }).added.length, 0);
});

// ---------------------------------------------------------------------------
// (d) the one-off repair

test("every table in the schema is either moved by the repair, left on purpose, or holds no site address", async () => {
  const db = await freshDb({ full: true });
  const tables = (await db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map((r) => String(r.name));
  const lists = [Object.keys(SITE_TABLES), Object.keys(LEFT_AS_IS), NO_SITE_ADDRESS];
  for (const t of tables) {
    assert.equal(lists.filter((l) => l.includes(t)).length, 1, `table ${t}: add it to exactly one list in scripts/repair-respelled-sites.mjs`);
  }
  const ADDRESS_COLUMN = /^(url|urls|winner|loser|w|l|portfolio_url|item|shown|ranking)$/;
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => ADDRESS_COLUMN.test(c)), [], `${t} has an address column`);
  }
});

test("every unique constraint on a moved column survives a clash: the listed address's row stays, nothing is left behind", async () => {
  const db = await freshDb({ full: true });
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
      await db.execute({
        sql: `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        args: cols.map((x) => (x === c ? url : /INT|REAL/i.test(typeOf(x)) ? 1 : "x")),
      });
    }
    clashing.push(`${t}.${c}`);
  }
  for (const t of ["status_reviews.url", "likes.url", "rank_history.url", "list_items.url"]) assert.ok(clashing.includes(t), `${t} in ${clashing.join(", ")}`);
  const r = await repairRespelled(db, [{ name: "Ann", url: N }], { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  for (const tc of clashing) {
    const [t, c] = tc.split(".");
    assert.equal((await one(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [O])).n, 0, `${tc} left behind`);
    assert.equal((await one(db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = ?`, [N])).n, 1, `${tc} kept`);
  }
});

async function splitSite(db, { listedGraded = false } = {}) {
  const O = "https://ann.dev/";
  const N = "https://ann.dev";
  await gradedRow(db, O, { delisted: "2026-11-01T00:00:00Z" });
  await db.execute({
    sql: "INSERT INTO portfolios (url, name, status, shot_key, ai_rubric) VALUES (?, 'Ann Lee', ?, ?, ?)",
    args: listedGraded ? [N, "live", "knew", '{"is_portfolio":true,"tier":"B"}'] : [N, "pending", null, null],
  });
  for (const u of ["https://a.dev", "https://b.dev", "https://c.dev"]) await db.execute({ sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [u] });
  const vote = (w, l, rater, starred = 0) =>
    db.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, starred) VALUES (?, ?, ?, 'human', ?, ?)",
      args: [w, l, [w, l].sort().join("\n"), rater, starred],
    });
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

/** A client that refuses what a remote server refuses, around a local one. */
function strictClient(db) {
  return {
    execute: (stmt) => {
      if (typeof stmt === "object") assertStrictArgs([stmt]);
      return db.execute(stmt);
    },
    batch: (stmts, mode) => {
      assertStrictArgs(stmts.filter((s) => typeof s === "object"));
      return db.batch(stmts, mode);
    },
  };
}

test("every statement of the repair binds exactly the arguments it uses (a remote server refuses extra ones)", async () => {
  const db = await freshDb({ full: true });
  const { feed } = await splitSite(db);
  const r = await repairRespelled(strictClient(db), feed, { log: quiet });
  assert.deepEqual(r.failed, []);
  assert.equal(r.plans.length, 1);
  assertStrictArgs(r.plans[0].statements);
  const w = await repairRespelled(strictClient(db), feed, { write: true, log: quiet });
  assert.deepEqual(w.failed, []);
});

test("the repair runs against a real libSQL server when one is available (SQLD_BIN)", { skip: !process.env.SQLD_BIN && "SQLD_BIN not set" }, async () => {
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
    const dry = await repairRespelled(db, feed, { log: quiet });
    assert.deepEqual(dry.failed, []);
    const r = await repairRespelled(db, feed, { write: true, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O])).n, 0);
    assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = ?", [N])).shot_key, "kold");
  } finally {
    child.kill();
  }
});

test("the repair dry run finds the split site and changes nothing", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db);
  const snapshot = async () => JSON.stringify(await Promise.all(["portfolios", "votes", "ratings", "likes", "comparisons"].map((t) => all(db, `SELECT * FROM ${t}`))));
  const before = await snapshot();
  const logs = [];
  const r = await repairRespelled(db, feed, { log: (m) => logs.push(m) });
  assert.deepEqual(r.plans.map((p) => [p.from, p.to]), [[O, N]]);
  assert.match(logs.join("\n"), /would move https:\/\/ann\.dev\/ -> https:\/\/ann\.dev: the listed row takes the old capture and grade; votes 2/);
  assert.equal(await snapshot(), before);
});

test("the repair moves a split site's grade, screenshots, votes, ratings and owner settings to its listed address", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db);
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.orphanShots, []);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O])).n, 0);
  const row = await one(db, "SELECT status, shot_key, ai_rubric, delisted_at FROM portfolios WHERE url = ?", [N]);
  assert.deepEqual([row.status, row.shot_key, row.delisted_at], ["live", "kold", null]);
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
  const owner = await one(db, "SELECT url, hide_grade FROM portfolio_owner");
  assert.deepEqual([owner.url, owner.hide_grade], [N, 1]);
  assert.equal((await one(db, "SELECT url FROM rubric_history")).url, N);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?", [O])).n, 0);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM cache")).n, 0);
  assert.deepEqual((await repairRespelled(db, feed, { log: quiet })).plans, []);
});

test("the repair keeps one vote per rater and pair, drops a vote of the site against itself, and takes their points back", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db);
  const vote = (w, l, rater, delta) =>
    db.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, delta) VALUES (?, ?, ?, 'ai', ?, ?)",
      args: [w, l, [w, l].sort().join("\n"), rater, delta],
    });
  // The AI rater voted on the pair (ann, a) under both addresses, and once ann against itself.
  await vote(O, "https://a.dev", "ai", 10);
  await vote(N, "https://a.dev", "ai", 8);
  await vote(O, N, "ai", 6);
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 10, votes = votes + 2 WHERE url = ?", args: [O] });
  await db.execute({ sql: "UPDATE ratings SET elo = elo + 8 - 6, votes = votes + 2 WHERE url = ?", args: [N] });
  await db.execute({ sql: "INSERT INTO ratings (url, elo, votes) VALUES ('https://a.dev', 1182, 2)" });
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  const votes = await all(db, "SELECT id, winner, loser, rater_id, pair_key FROM votes ORDER BY id");
  assert.ok(votes.every((v) => v.winner !== v.loser), "no vote of a site against itself");
  assert.ok(votes.every((v) => !String(v.pair_key).includes(O)), "no pair key names the old address");
  assert.deepEqual(votes.filter((v) => v.rater_id === "ai").map((v) => [v.winner, v.pair_key]), [[N, [N, "https://a.dev"].sort().join("\n")]], "one vote per rater and pair: the earliest");
  // ELO: (1260 + 10) + (1190 + 2) - 1200 = 1262; the later duplicate (+8 to ann, -8 to a) is taken back, the self-vote cancels: 1254.
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [N])).elo, 1254);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = 'https://a.dev'")).elo, 1190);
});

test("the repair keeps the stronger claim when an owner claimed both addresses", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db);
  const claim = (url, owner, status) =>
    db.execute({
      sql: "INSERT INTO claims (url, owner, login, status, token, created_at, updated_at) VALUES (?, ?, 'gh', ?, 't', '2026-10-01', '2026-10-01')",
      args: [url, owner, status],
    });
  await claim(O, "u1", "verified");
  await claim(N, "u1", "pending");
  await claim(O, "u2", "pending");
  await claim(N, "u2", "verified");
  await claim(O, "u3", "review");
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(
    (await all(db, "SELECT url, owner, status FROM claims ORDER BY owner")).map((c) => [c.url, c.owner, c.status]),
    [[N, "u1", "verified"], [N, "u2", "verified"], [N, "u3", "review"]]
  );
});

test("a pair that fails is reported, changes nothing, and the run goes on with the rest", async () => {
  const db = await freshDb({ full: true });
  const { O, N } = await splitSite(db);
  await gradedRow(db, "https://bob.dev/", { shot: "kb", delisted: "2026-11-01T00:00:00Z" });
  // A review batch that holds both of ann's addresses (UNIQUE (batch, url)) must not stop the run.
  const review = (url) =>
    db.execute({
      sql: "INSERT INTO status_reviews (batch, url, grp, current, proposed, agreed, verdicts, created_at) VALUES ('b1', ?, 'g', 'c', 'p', 1, '{}', '2026-10-01')",
      args: [url],
    });
  await review(O);
  await review(N);
  // Bob's move fails (a stand-in for anything the database refuses).
  await db.execute("CREATE TRIGGER no_bob BEFORE UPDATE ON portfolios WHEN OLD.url = 'https://bob.dev/' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  const feed = [{ name: "Bob", url: "https://bob.dev" }, { name: "Ann", url: N }];
  const logs = [];
  const r = await repairRespelled(db, feed, { write: true, log: (m) => logs.push(m) });
  assert.deepEqual(r.failed.map((f) => f.from), ["https://bob.dev/"]);
  assert.match(logs.join("\n"), /FAILED https:\/\/bob\.dev\/ -> https:\/\/bob\.dev: .*refused/);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://bob.dev/'")).n, 1);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O])).n, 0, "ann was merged after bob failed");
  assert.deepEqual((await all(db, "SELECT url FROM status_reviews")).map((x) => x.url), [N]);
});

test("the repair renames a row whose listed address has no row yet, and skips a key two feed entries share", async () => {
  const db = await freshDb({ full: true });
  await gradedRow(db, "https://ann.dev/");
  await gradedRow(db, "https://host.dev/", { shot: "kh" });
  const feed = [
    { name: "Ann", url: "https://ANN.dev" },
    { name: "A", url: "https://host.dev" },
    { name: "B", url: "http://host.dev" },
  ];
  const { pairs, skipped } = await findRespelled(db, feed);
  assert.deepEqual(pairs, [{ from: "https://ann.dev/", to: "https://ANN.dev" }]);
  assert.deepEqual(skipped.map((s) => s.entries), [["https://host.dev", "http://host.dev"]]);
  const plan = await planMove(db, pairs[0]);
  assert.equal(plan.portfolios, "renamed");
  await applyMove(db, plan);
  assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = 'https://ANN.dev'")).shot_key, "kold");
});
