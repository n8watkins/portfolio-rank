// The home page's pool (lib/home.ts rankedPool) is cached an hour; a site
// hidden after it was cached must leave the showcase and the portfolio of the
// day at once (visiblePool), and every hide path's clear drops the cached pool
// (lib/games/pool.mjs clearPoolStatement, HOME_POOL_KEYS). Its own process:
// the hidden list (lib/roster.ts hiddenUrls) is read for the first time after
// the site is hidden, as on a fresh server. Offline: a throwaway SQLite file,
// lib/*.ts loaded the way Next does.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
const root = ${JSON.stringify(new URL("../", import.meta.url).href)};
const EXT = ["", ".ts", ".tsx", ".mjs", ".js"];
export async function resolve(specifier, context, next) {
  const local = specifier.startsWith("@/") ? root + specifier.slice(2) : /^\\.\\.?\\//.test(specifier) && context.parentURL?.endsWith(".ts") ? new URL(specifier, context.parentURL).href : null;
  if (!local) {
    try {
      return await next(specifier, context);
    } catch (e) {
      // A package subpath without its extension, as a bundler resolves it (next/server).
      if (/^next\\//.test(specifier)) return next(specifier + ".js", context);
      throw e;
    }
  }
  let last;
  for (const ext of EXT) {
    try {
      return await next(local + ext, context);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}
export async function load(url, context, next) {
  if (!url.endsWith(".json")) return next(url, context);
  const r = await next(url, { ...context, format: "json", importAttributes: { type: "json" } });
  return { format: "module", source: "export default " + String(r.source), shortCircuit: true };
}`)
);

process.env.LOCAL_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "home-hidden-")), "db.sqlite");
delete process.env.TURSO_DATABASE_URL;
delete process.env.RANKING_V2;

let db, feed;
before(async () => {
  ({ db } = await import("../lib/db.ts"));
  feed = JSON.parse(fs.readFileSync(new URL("../data/feed.json", import.meta.url), "utf8"));
  await (await import("../lib/db.ts")).ensureSchema();
});

test("the recently graded list skips text that is not JSON instead of failing", async () => {
  const { RECENT_GRADES_SQL } = await import("../lib/home.ts");
  await db().execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: ["https://broken-json.dev", "{not json"] });
  await db().execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: ["https://graded.dev", JSON.stringify({ rubric_version: 3, is_portfolio: true, judged_at: "2026-11-20T00:00:00Z" })] });
  const rows = (await db().execute(RECENT_GRADES_SQL)).rows.map((r) => String(r.url));
  assert.ok(rows.includes("https://graded.dev") && !rows.includes("https://broken-json.dev"), rows.join(","));
});

test("a site hidden after the home pool was cached is not on the home page; the hide paths drop the cached pool", async () => {
  const { rankedPool, visiblePool } = await import("../lib/home.ts");
  const { clearPoolStatement, HOME_POOL_KEYS } = await import("../lib/games/pool.mjs");
  const sites = feed.slice(20, 26).map((p) => ({ url: p.url, name: p.name ?? p.url, rank: 0, tier: null }));
  sites.forEach((s, i) => (s.rank = i + 1));
  for (const s of sites) await db().execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status) VALUES (?, 'live')", args: [s.url] });
  // The pool as it was cached a minute ago, every site in it.
  await db().execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES ('home:pool:elo', ?, ?)", args: [JSON.stringify({ sites, total: sites.length }), Date.now() - 60_000] });
  // Then the top site goes down (hidden).
  await db().execute({ sql: "UPDATE portfolios SET health = 'down' WHERE url = ?", args: [sites[0].url] });
  assert.equal((await rankedPool()).pool[0].url, sites[0].url, "the cached copy still holds it");
  const { pool, hidden } = await visiblePool();
  assert.ok(hidden.has(sites[0].url));
  assert.ok(!pool.some((p) => p.url === sites[0].url), "not in the pool the showcase and the portfolio of the day read");
  assert.deepEqual(pool.map((p) => p.url), sites.slice(1).map((s) => s.url));
  // homeData hands that pool to both.
  const src = fs.readFileSync(new URL("../lib/home.ts", import.meta.url), "utf8");
  assert.match(src, /const \{ pool, total: ranked, hidden \} = await visiblePool\(\);/);
  assert.match(src, /showcase\(pool\)/);
  assert.match(src, /portfolioOfTheDay\(pool, ranked,/);
  // Every hide path's clear (health, admin review, removals, owner actions, claims) drops the home pool too, in both flag states.
  await db().execute({ sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES ('home:pool:tiers', '{}', ?)", args: [Date.now()] });
  await db().execute(clearPoolStatement());
  for (const k of HOME_POOL_KEYS) assert.equal((await db().execute({ sql: "SELECT 1 FROM cache WHERE k = ?", args: [k] })).rows.length, 0, k);
  assert.match(src, /\("home", `pool:\$\{rankingV2\(\) \? "tiers" : "elo"\}`/, "the keys home.ts writes are the ones cleared");
});
