// When the community list only spells a site's address another way (a
// trailing slash, www, http, upper case, the default port, a tracking
// parameter), the site keeps its row, grade, votes, ratings and screenshots:
// generate_feed.py keeps the spelling the feed already had, syncRoster never
// delists a row whose site is still listed, purgeDelisted never deletes one,
// and scripts/repair-respelled-sites.mjs gives back the history of sites split
// before. Also: syncRoster refuses a mass delist, and the feed's exclusion and
// duplicate rules use the same "one site" rule in Python as in JavaScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  CLEANUP_SHARE_ENV,
  ensureRosterSchema,
  matchSameSite,
  purgeDelisted,
  sameSite,
  siteOf,
  syncRoster,
} from "../pipeline/roster.mjs";
import { migrate } from "../lib/schema.mjs";
import {
  LEFT_AS_IS,
  NO_SITE_ADDRESS,
  SITE_TABLES,
  applyMove,
  findRespelled,
  planMove,
  repairRespelled,
} from "../scripts/repair-respelled-sites.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const GENERATOR = path.join(ROOT, "pipeline", "generate_feed.py");
const DAY = 86400000;
const NOW = new Date("2026-11-16T04:30:00Z");
const quiet = () => {};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "respell-"));
async function freshDb({ full = false } = {}) {
  const db = createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` });
  if (full) await migrate(db);
  await ensureRosterSchema(db);
  return db;
}
const fillers = (n = 520) => Array.from({ length: n }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));
const readmeOf = (entries) => `${entries.map((p) => `- [${p.name}](${p.url}) [Developer]`).join("\n")}\n`;

/** Runs generate_feed.py the way sync-upstream.yml does: the feed.json being replaced is the output file. */
function generate({ readme, previous = null, excluded = [], additions = [], env = {}, maxShrink = null }) {
  const dir = tmp();
  const file = (f) => path.join(dir, f);
  fs.writeFileSync(file("README.md"), typeof readme === "string" ? readme : readmeOf(readme));
  fs.writeFileSync(file("excluded.json"), JSON.stringify(excluded));
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
/** Listed rows, in one transaction (row by row is slow on a busy disk). */
async function liveRows(db, entries, { graded = false } = {}) {
  await db.batch(
    entries.map((p) =>
      graded ? { ...GRADED, args: [p.url, `k${p.name}`, null] } : { sql: "INSERT INTO portfolios (url, status) VALUES (?, 'live')", args: [p.url] }
    ),
    "write"
  );
}

// ---------------------------------------------------------------------------
// (a) an address edit upstream

// [the feed's spelling, upstream's new spelling]
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
];
// Different sites: a domain move, another page, another project page, another hash route.
const NOT_RESPELLINGS = [
  ["https://ann.dev", "https://annlee.dev"],
  ["https://ann.dev", "https://ann.dev/en"],
  ["https://ann.github.io/portfolio", "https://ann.github.io/portfolio-v2"],
  ["https://host.dev/#/ann", "https://host.dev/#/bob"],
  ["https://host.dev/p?id=1", "https://host.dev/p?id=2"],
];

test("generate_feed.py keeps the address a site already has when upstream only spells it another way", () => {
  for (const [old, now] of RESPELLINGS) {
    const out = generate({ readme: [{ name: "Ann Lee", url: now }], previous: [{ name: "Ann Lee", url: old }] });
    assert.equal(out.status, 0, out.stdout);
    assert.deepEqual(out.feed.map((p) => p.url), [old], `${old} -> ${now}`);
    assert.match(out.stdout, /1 kept their address/);
  }
  for (const [old, now] of NOT_RESPELLINGS) {
    const out = generate({ readme: [{ name: "Ann Lee", url: now }], previous: [{ name: "Ann Lee", url: old }] });
    assert.deepEqual(out.feed.map((p) => p.url), [now], `${old} -> ${now} is another site`);
  }
  // Ambiguous: the root could be either hash route, so neither spelling is kept for it.
  const amb = generate({
    readme: [{ name: "Host", url: "https://host.dev/" }],
    previous: [{ name: "A", url: "https://host.dev/#/a" }, { name: "B", url: "https://host.dev/#/b" }],
  });
  assert.deepEqual(amb.feed.map((p) => p.url), ["https://host.dev/"]);
  // An addition keeps its spelling too, and upstream's other entries are untouched.
  const add = generate({
    readme: [{ name: "Kept", url: "https://kept.dev" }],
    additions: [{ name: "Ann Lee", url: "https://www.ann.dev/" }],
    previous: [{ name: "Kept", url: "https://kept.dev" }, { name: "Ann Lee", url: "https://ann.dev" }],
  });
  assert.deepEqual(add.feed.map((p) => p.url), ["https://kept.dev", "https://ann.dev"]);
});

test("a respelled site keeps its row, grade and screenshots through the nightly sync and the purge", async () => {
  const db = await freshDb();
  const old = "https://ann.dev/";
  const previous = [...fillers(), { name: "Ann Lee", url: old }];
  await liveRows(db, fillers());
  await gradedRow(db, old);
  // Upstream drops the trailing slash.
  const out = generate({ readme: [...fillers(), { name: "Ann Lee", url: "https://ann.dev" }], previous, maxShrink: 0.05 });
  assert.equal(out.status, 0, out.stdout);
  assert.ok(out.feed.some((p) => p.url === old), "the feed keeps the spelling the database knows");
  const r = await syncRoster(db, out.feed, { now: NOW, log: quiet });
  assert.equal(r.delisted, 0);
  const row = (await db.execute({ sql: "SELECT delisted_at, ai_rubric, shot_key FROM portfolios WHERE url = ?", args: [old] })).rows[0];
  assert.equal(row.delisted_at, null);
  assert.equal(row.shot_key, "kold");
  assert.ok(row.ai_rubric);
  const deleted = [];
  const p = await purgeDelisted(db, { now: new Date(NOW.getTime() + 31 * DAY), deleteShots: async (k) => deleted.push(k), log: quiet });
  assert.deepEqual(p, { due: 0, purged: 0, failed: 0 });
  assert.deepEqual(deleted, []);
});

test("syncRoster never delists a row whose site is still listed under another spelling, and the purge keeps it", async () => {
  const db = await freshDb();
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev/` }));
  await liveRows(db, feed, { graded: true });
  const logs = [];
  // The feed itself carries a new spelling (written before generate_feed.py kept spellings, or by hand).
  const one = feed.map((p, i) => (i === 0 ? { ...p, url: "https://site0.dev" } : p));
  assert.deepEqual(await syncRoster(db, one, { now: NOW, log: (m) => logs.push(m) }), { delisted: 0, relisted: 0, listed: 600, respelled: 1 });
  assert.match(logs.join("\n"), /https:\/\/site0\.dev\/ is listed as https:\/\/site0\.dev now/);
  assert.equal((await db.execute("SELECT delisted_at FROM portfolios WHERE url = 'https://site0.dev/'")).rows[0].delisted_at, null);
  // Every address reformatted at once: nothing is delisted.
  const all = feed.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") }));
  assert.deepEqual(await syncRoster(db, all, { now: NOW, log: quiet }), { delisted: 0, relisted: 0, listed: 600, respelled: 600 });
  // Once the new spelling has a row of its own (the nightly capture made one), the old row is
  // delisted, and 31 days later the purge still keeps it, with its screenshots, for the repair.
  await db.execute("INSERT INTO portfolios (url, status) VALUES ('https://site0.dev', 'pending')");
  assert.equal((await syncRoster(db, one, { now: NOW, log: quiet })).delisted, 1);
  const deleted = [];
  const kept = [];
  const p = await purgeDelisted(db, { now: new Date(NOW.getTime() + 31 * DAY), deleteShots: async (k) => deleted.push(k), log: (m) => kept.push(m) });
  assert.deepEqual(p, { due: 0, purged: 0, failed: 0 });
  assert.deepEqual(deleted, []);
  assert.match(kept.join("\n"), /kept https:\/\/site0\.dev\/: the same site is listed under another spelling/);
  // A row whose site really left is still purged.
  await db.execute({ sql: "UPDATE portfolios SET delisted_at = ? WHERE url = 'https://site5.dev/'", args: [NOW.toISOString()] });
  const p2 = await purgeDelisted(db, { now: new Date(NOW.getTime() + 31 * DAY), deleteShots: async (k) => deleted.push(k), log: quiet });
  assert.deepEqual(p2, { due: 1, purged: 1, failed: 0 });
  assert.deepEqual(deleted, ["kP5"]);
});

// ---------------------------------------------------------------------------
// (b) a mass delist

test("syncRoster refuses to delist more than 10% of the list at once, unless the owner allows a cleanup", async () => {
  const db = await freshDb();
  const feed = Array.from({ length: 600 }, (_, i) => ({ name: `P${i}`, url: `https://site${i}.dev` }));
  await liveRows(db, feed);
  const other = Array.from({ length: 600 }, (_, i) => ({ name: `Q${i}`, url: `https://other${i}.dev` }));
  await assert.rejects(syncRoster(db, other, { now: NOW, log: quiet }), new RegExp(`600 of 600 listed sites.*refusing.*${CLEANUP_SHARE_ENV}`, "s"));
  assert.equal((await db.execute("SELECT COUNT(*) AS n FROM portfolios WHERE delisted_at IS NOT NULL")).rows[0].n, 0);
  // 60 of 600 (10%) is allowed; 61 is not.
  const sixty = feed.map((p, i) => (i < 60 ? other[i] : p));
  const sixtyOne = feed.map((p, i) => (i < 61 ? other[i] : p));
  await assert.rejects(syncRoster(db, sixtyOne, { now: NOW, log: quiet }), /61 of 600/);
  assert.equal((await syncRoster(db, sixty, { now: NOW, log: quiet })).delisted, 60);
  // The owner's override for a real upstream cleanup, as an option and from the environment.
  const db2 = await freshDb();
  await liveRows(db2, feed);
  const half = feed.map((p, i) => (i < 300 ? other[i] : p));
  const before = process.env[CLEANUP_SHARE_ENV];
  try {
    process.env[CLEANUP_SHARE_ENV] = "nonsense";
    await assert.rejects(syncRoster(db2, half, { now: NOW, log: quiet }), /not a share between 0 and 1/);
    process.env[CLEANUP_SHARE_ENV] = "0.5";
    assert.equal((await syncRoster(db2, half, { now: NOW, log: quiet })).delisted, 300);
  } finally {
    if (before === undefined) delete process.env[CLEANUP_SHARE_ENV];
    else process.env[CLEANUP_SHARE_ENV] = before;
  }
  const db3 = await freshDb();
  await liveRows(db3, feed);
  assert.equal((await syncRoster(db3, other, { now: NOW, log: quiet, maxDelistShare: 1 })).delisted, 600);
});

test("generate_feed.py lets a bigger upstream cleanup through once when the owner sets the cleanup share", () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev` }));
  const previous = all;
  const smaller = all.slice(0, 80);
  const refused = generate({ readme: smaller, previous, maxShrink: 0.05 });
  assert.equal(refused.status, 2);
  assert.match(refused.stdout, new RegExp(`refusing to write.*${CLEANUP_SHARE_ENV}`));
  const allowed = generate({ readme: smaller, previous, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "0.3" } });
  assert.equal(allowed.status, 0, allowed.stdout);
  assert.equal(allowed.feed.length, 80);
  assert.notEqual(generate({ readme: smaller, previous, maxShrink: 0.05, env: { [CLEANUP_SHARE_ENV]: "lots" } }).status, 0);
});

// ---------------------------------------------------------------------------
// (c) exclusions and duplicates in the feed

test("generate_feed.py keeps an excluded site out under every spelling of it, and only those", () => {
  const excluded = [{ url: "https://www.gone.dev/", kind: "owner_request" }, { url: "https://user.github.io/portfolio", kind: "not_portfolio" }];
  const out = [
    "https://www.gone.dev/", "https://gone.dev", "http://gone.dev/", "HTTPS://WWW.GONE.DEV", "https://gone.dev/?utm=x",
    "https://gone.dev/?utm_source=github", "https://gone.dev/#home", "https://gone.dev:443/", "http://gone.dev:80",
    "https://user.github.io/portfolio/", "https://user.github.io/Portfolio",
  ];
  // Other sites: another page, another subdomain, the account's root and its other project pages.
  // (/index.html stays a page of its own until lib/grader/url.mjs siteKeyOf says otherwise.)
  const listed = ["https://gone.dev/en", "https://blog.gone.dev", "https://user.github.io/portfolio-v2", "https://user.github.io"];
  for (const u of [...out, ...listed]) {
    const r = generate({ readme: [{ name: "X", url: u }], excluded });
    assert.deepEqual(r.feed.map((p) => p.url), listed.includes(u) ? [u] : [], u);
  }
});

test("generate_feed.py keeps two entries that only a query or a hash route tells apart, and drops real duplicates", () => {
  const r = generate({
    readme: [
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
  assert.match(r.stdout, /2 dup\(s\)/);
});

test("the Python and JavaScript site rules agree on every address in data/ and on the edge cases", () => {
  const data = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8"));
  const urls = [
    ...data("feed.json").map((p) => p.url),
    ...data("additions.json").map((p) => p.url),
    ...data("excluded.json").map((e) => (typeof e === "string" ? e : e.url)),
    ...RESPELLINGS.flat(),
    ...NOT_RESPELLINGS.flat(),
    "https://x.dev/index.html", "https://x.dev/a/../b", "https://x.dev/a/./b/", "https://x.dev/é path", "https://x.dev/%2e%2E/c",
    "https://x.dev\\a\\b", "https://bücher.de/", "https://x.dev:abc/", "https://", "www.x.dev", "mailto:a@b.c",
    "https://x.dev/#!/", "https://x.dev/?B=2&A=1&utm_source=x#/Bob/", "https://x.dev/?ref=a&id=3#about", "  https://x.dev/  ",
  ];
  const file = path.join(tmp(), "urls.txt");
  fs.writeFileSync(file, `${urls.join("\n")}\n`);
  const py = JSON.parse(execFileSync("python3", [GENERATOR, "--site-keys", file], { encoding: "utf8" }));
  assert.equal(py.length, urls.length);
  urls.forEach((u, i) => {
    const js = siteOf(u);
    assert.deepEqual([js.site, js.extra], py[i], u);
  });
});

test("sameSite and matchSameSite: one site, and a pairing only when it is unambiguous", () => {
  for (const [a, b] of RESPELLINGS) assert.ok(sameSite(a, b), `${a} ~ ${b}`);
  for (const [a, b] of NOT_RESPELLINGS) assert.ok(!sameSite(a, b), `${a} !~ ${b}`);
  const m = matchSameSite(
    ["https://ann.dev/", "https://host.dev/", "https://two.dev/", "http://two.dev"],
    ["https://ann.dev", "https://host.dev/#/a", "https://host.dev/#/b", "https://two.dev"]
  );
  assert.deepEqual([...m], [["https://ann.dev/", "https://ann.dev"]]);
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
  // A table with an address column cannot be filed as having none.
  const ADDRESS_COLUMN = /^(url|urls|winner|loser|w|l|portfolio_url|item|shown|ranking)$/;
  for (const t of NO_SITE_ADDRESS.filter((x) => tables.includes(x))) {
    const cols = (await db.execute(`PRAGMA table_info(${t})`)).rows.map((r) => String(r.name));
    assert.deepEqual(cols.filter((c) => ADDRESS_COLUMN.test(c)), [], `${t} has an address column`);
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

const one = async (db, sql, args = []) => (await db.execute({ sql, args })).rows[0];
const all = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map((r) => ({ ...r }));

test("the repair dry run finds the split site and changes nothing", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db);
  const snapshot = async () => JSON.stringify(await Promise.all(["portfolios", "votes", "ratings", "likes", "comparisons"].map((t) => all(db, `SELECT * FROM ${t}`))));
  const before = await snapshot();
  const logs = [];
  const r = await repairRespelled(db, feed, { log: (m) => logs.push(m) });
  assert.deepEqual(r.plans.map((p) => [p.from, p.to]), [[O, N]]);
  assert.match(logs.join("\n"), /would move https:\/\/ann\.dev\/ -> https:\/\/ann\.dev: the listed row takes the old capture and grade; votes 2/);
  assert.match(logs.join("\n"), /dry run; --write applies it/);
  assert.equal(await snapshot(), before);
});

test("the repair moves a split site's grade, screenshots, votes, ratings and owner settings to its listed spelling", async () => {
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
  assert.deepEqual([(await one(db, "SELECT url, hide_grade FROM portfolio_owner")).url, (await one(db, "SELECT hide_grade FROM portfolio_owner")).hide_grade], [N, 1]);
  assert.equal((await one(db, "SELECT url FROM rubric_history")).url, N);
  assert.deepEqual(JSON.parse((await one(db, "SELECT ranking FROM comparisons")).ranking), [N, "https://a.dev"]);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM tier_ratings WHERE url = ?", [O])).n, 0);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM cache")).n, 0);
  // Nothing is left under the old spelling, and a second run finds nothing to do.
  assert.deepEqual((await repairRespelled(db, feed, { log: quiet })).plans, []);
});

test("the repair keeps a listed row's own newer grade, and names the old screenshots nothing uses", async () => {
  const db = await freshDb({ full: true });
  const { O, N, feed } = await splitSite(db, { listedGraded: true });
  const r = await repairRespelled(db, feed, { write: true, log: quiet });
  assert.deepEqual(r.orphanShots, ["kold"]);
  const row = await one(db, "SELECT shot_key, ai_rubric FROM portfolios WHERE url = ?", [N]);
  assert.equal(row.shot_key, "knew");
  assert.match(String(row.ai_rubric), /"tier":"B"/);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = ?1 OR loser = ?1", [O])).n, 0);
  assert.equal((await one(db, "SELECT votes FROM ratings WHERE url = ?", [N])).votes, 3);
});

test("the repair renames a row whose listed spelling has no row yet, and skips an ambiguous one", async () => {
  const db = await freshDb({ full: true });
  await gradedRow(db, "https://ann.dev/");
  await gradedRow(db, "https://host.dev/", { shot: "kh" });
  const feed = [
    { name: "Ann", url: "https://ANN.dev" },
    { name: "A", url: "https://host.dev/#/a" },
    { name: "B", url: "https://host.dev/#/b" },
  ];
  const { pairs, ambiguous } = await findRespelled(db, feed);
  assert.deepEqual(pairs, [{ from: "https://ann.dev/", to: "https://ANN.dev" }]);
  assert.deepEqual(ambiguous.map((a) => a.from), ["https://host.dev/"]);
  const plan = await planMove(db, pairs[0]);
  assert.equal(plan.portfolios, "renamed");
  await applyMove(db, plan);
  assert.equal((await one(db, "SELECT shot_key FROM portfolios WHERE url = 'https://ANN.dev'")).shot_key, "kold");
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = 'https://host.dev/'")).n, 1);
});

test("a repair that fails part way changes nothing", async () => {
  const db = await freshDb({ full: true });
  const { O, N } = await splitSite(db);
  const plan = await planMove(db, { from: O, to: N });
  plan.statements.push({ sql: "INSERT INTO no_such_table VALUES (1)", args: [] });
  await assert.rejects(applyMove(db, plan));
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM portfolios WHERE url = ?", [O])).n, 1);
  assert.equal((await one(db, "SELECT COUNT(*) AS n FROM votes WHERE winner = ?1 OR loser = ?1", [O])).n, 2);
  assert.equal((await one(db, "SELECT elo FROM ratings WHERE url = ?", [O])).elo, 1260);
});
