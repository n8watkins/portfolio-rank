// The home page reads the same order /top shows (lib/home.ts boardOrder,
// topTen): with RANKING_V2 off, the people's ELO board (lib/leaderboard.ts
// eloOrder, which loadLeaderboard("elo") renders), never Gemini's order, and
// a database error is not hidden as an empty board. Offline: a throwaway
// SQLite file, lib/*.ts loaded the way Next does.
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
  if (!local) return next(specifier, context);
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

process.env.LOCAL_DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "home-order-")), "db.sqlite");
delete process.env.TURSO_DATABASE_URL;
delete process.env.RANKING_V2;

let db, eloOrder, loadLeaderboard, feed;
before(async () => {
  ({ db } = await import("../lib/db.ts"));
  ({ eloOrder, loadLeaderboard } = await import("../lib/leaderboard.ts"));
  feed = JSON.parse(fs.readFileSync(new URL("../data/feed.json", import.meta.url), "utf8"));
  await (await import("../lib/db.ts")).ensureSchema();
});

test("with RANKING_V2 off, the home order is the ELO board /top renders, place for place", async () => {
  const sites = feed.slice(0, 15).map((p) => p.url);
  // ELO from people's votes; one site with no votes is not on the board. Gemini's letter (here S on the weakest) plays no part.
  for (const [i, url] of sites.entries()) {
    await db().execute({ sql: "INSERT OR REPLACE INTO ratings (url, elo, votes) VALUES (?, ?, ?)", args: [url, 1500 - i * 10, i === 14 ? 0 : 3] });
    await db().execute({ sql: "INSERT OR REPLACE INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', ?)", args: [url, JSON.stringify({ tier: i === 13 ? "S" : "C", is_portfolio: true })] });
  }
  const order = (await eloOrder(100)).map((r) => r.url);
  const board = (await loadLeaderboard("elo", 100)).rows;
  assert.deepEqual(order, board.map((r) => r.url), "the same sites in the same order");
  assert.deepEqual(board.map((r) => r.rank), order.map((_, i) => i + 1), "the same places");
  assert.equal(order.length, 14);
  assert.equal(order[0], sites[0]);
  assert.ok(!order.includes(sites[14]), "no votes, not on the board");
});

test("tied ELO sites keep one order (by address), so the cached pool and /top agree", async () => {
  const sites = feed.slice(30, 34).map((p) => p.url);
  await db().execute("DELETE FROM ratings");
  for (const url of [...sites].reverse()) await db().execute({ sql: "INSERT OR REPLACE INTO ratings (url, elo, votes) VALUES (?, 1500, 3)", args: [url] });
  assert.deepEqual((await eloOrder(10)).map((r) => r.url), [...sites].sort());
});

test("the home page reads /top's order in each flag state, never hides a database error, and caches its pool", () => {
  const src = fs.readFileSync(new URL("../lib/home.ts", import.meta.url), "utf8");
  const has = (re, msg) => assert.ok(re.test(src), msg);
  has(/\?\s*\(await rankedSites\(10\)\)/, "tiers on: the ranked board");
  has(/:\s*\(await eloOrder\(10\)\)/, "tiers off: the ELO board");
  assert.ok(!/rankedSites\([^)]*\)\.catch|eloOrder\([^)]*\)\.catch/.test(src), "an error is not turned into an empty board");
  assert.ok(!/gradedPool/.test(src), "never the AI grade's order");
  has(/cached<\{ sites: PoolSite\[\]; total: number \}>\("home", `pool:/, "the pool is cached");
});
