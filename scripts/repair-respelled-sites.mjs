#!/usr/bin/env node
// Merges split sites by hand (pipeline/site-move.mjs; AUTOMATION.md "Respelled sites").
//
// When the community list respells a site, the roster sync delists the old row
// (with the grade, votes and screenshots) and the new spelling gets a row of
// its own. The purge never deletes such an old row, and every nightly sync
// counts these under "Split sites waiting for a merge". This merges each one:
// a delisted row and a listed row with the same key (pipeline/list-key.mjs),
// exactly one of each, the listed one on origin/main's data/feed.json (the
// feed the deployed app has). Any other group is reported and left alone.
//
// Every pair is planned first, outside any transaction; each is then written
// as one transaction whose first statement checks that the pair's votes and
// claims have not changed since the plan (else that pair is skipped, nothing
// of it written). A pair that fails changes nothing and the run goes on (exit
// code 1). Two runs never overlap (a lock row in `cache`). Dry run by default.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/repair-respelled-sites.mjs
//       dry run against that database (production), with origin/main's data/feed.json
//   ... --write --then-recompute
//       merge them, then rebuild the leaderboards and tiers where both rows had
//       one (node scripts/recompute-ratings.mjs, node scripts/refresh-tiers.mjs);
//       without --then-recompute a merge that needs them exits 2 and says so
//   ... --only URL          one old address only
//   ... --feed FILE         another feed, dry run only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { splitSites } from "../pipeline/list-key.mjs";
import { pipelineDb } from "../pipeline/roster.mjs";
import { applyMove, describeMove, jsonHits, planMove, schemaOf } from "../pipeline/site-move.mjs";

const ROOT = path.join(import.meta.dirname, "..");
export const LOCK_KEY = "lock:repair-respelled-sites";
const LOCK_STALE_MS = 2 * 3600000;

/** Takes the lock row, or throws when another run holds it (a run older than two hours is taken over). */
export async function takeLock(db, now = Date.now()) {
  const r = await db.execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, ?, ?)
          ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at WHERE cache.at < ?`,
    args: [LOCK_KEY, String(process.pid), now, now - LOCK_STALE_MS],
  });
  if (r.rowsAffected !== 1) throw new Error("another repair is running (cache row lock:repair-respelled-sites); try again when it ends");
}
export const releaseLock = (db) => db.execute({ sql: "DELETE FROM cache WHERE k = ?", args: [LOCK_KEY] });

/** The recompute a merge of two rated rows needs: the leaderboards and the tiers. */
export function recomputeScripts() {
  for (const script of ["scripts/recompute-ratings.mjs", "scripts/refresh-tiers.mjs"]) {
    execFileSync(process.execPath, [path.join(ROOT, script)], { stdio: "inherit", env: process.env });
  }
}

/** The pairs to merge: { pairs: [{ from, to }], unclear: [urls] }. */
export async function findSplits(db, feed) {
  const onFeed = new Set(feed.map((p) => p.url));
  const rows = (await db.execute("SELECT url, delisted_at FROM portfolios")).rows.map((r) => ({ url: String(r.url), listed: r.delisted_at == null }));
  const { pairs, unclear } = splitSites(rows);
  return {
    pairs: pairs.filter((p) => onFeed.has(p.to)),
    unclear: [...unclear, ...pairs.filter((p) => !onFeed.has(p.to)).map((p) => [p.from, p.to])],
  };
}

/**
 * Plans every merge, then with `write` applies each (guarded, one transaction
 * each) and runs `recompute` when a merge needs it.
 * Returns { merged, failed, unclear, orphanShots, needsRecompute, recomputed }.
 */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log, recompute = null } = {}) {
  if (write) await takeLock(db);
  try {
    const found = await findSplits(db, feed);
    const pairs = only ? found.pairs.filter((p) => p.from === only) : found.pairs;
    const schema = await schemaOf(db);
    const json = await jsonHits(db, pairs.map((p) => p.from), schema);
    const out = { merged: [], failed: [], unclear: found.unclear, orphanShots: [], needsRecompute: false, recomputed: false };
    const plans = [];
    for (const pair of pairs) {
      try {
        plans.push(await planMove(db, pair, { schema, json }));
      } catch (e) {
        out.failed.push({ ...pair, error: String(e?.message ?? e) });
      }
    }
    for (const plan of plans) {
      try {
        if (write) await applyMove(db, plan);
        out.merged.push(plan);
        out.orphanShots.push(...plan.orphanShots);
        out.needsRecompute ||= plan.needsRecompute;
        log(`${write ? "merged" : "would merge"} ${describeMove(plan)}`);
      } catch (e) {
        out.failed.push({ from: plan.from, to: plan.to, error: String(e?.message ?? e) });
      }
    }
    for (const f of out.failed) log(`FAILED ${f.from} -> ${f.to}: ${f.error.slice(0, 300)} (nothing of it changed)`);
    for (const u of found.unclear) log(`left alone, a person decides: ${u.join(", ")}`);
    log(
      `${out.merged.length} merge(s) ${write ? "done" : "to do (dry run; --write --then-recompute applies them)"}, ${out.failed.length} failed, ${found.unclear.length} left alone.` +
        (out.orphanShots.length ? ` Screenshots no row refers to${write ? "" : " after --write"}: ${out.orphanShots.join(", ")}.` : "")
    );
    if (write && out.needsRecompute) {
      if (recompute) {
        await recompute();
        out.recomputed = true;
      } else {
        log("NOT DONE YET: both rows of a site had tier or leaderboard rows. Run now: node scripts/recompute-ratings.mjs && node scripts/refresh-tiers.mjs");
      }
    }
    return out;
  } finally {
    if (write) await releaseLock(db);
  }
}

/** origin/main's data/feed.json (fetched first): what the deployed app bundles. */
export function mainFeed() {
  execFileSync("git", ["-C", ROOT, "fetch", "--quiet", "origin", "main"], { stdio: "inherit" });
  return JSON.parse(execFileSync("git", ["-C", ROOT, "show", "origin/main:data/feed.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const write = args.includes("--write");
  const feedPath = flag("--feed");
  if (feedPath && write) {
    console.error("--feed is for dry runs only: --write always reads origin/main's data/feed.json, the feed the deployed app has.");
    process.exit(2);
  }
  const feed = feedPath ? JSON.parse(fs.readFileSync(feedPath, "utf8")) : mainFeed();
  console.log(`database: ${process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL" : "local file"}; feed: ${feedPath ?? "origin/main:data/feed.json"} (${feed.length} entries)`);
  const r = await repairRespelled(pipelineDb(ROOT), feed, { write, only: flag("--only"), recompute: args.includes("--then-recompute") ? recomputeScripts : null });
  process.exitCode = r.failed.length ? 1 : write && r.needsRecompute && !r.recomputed ? 2 : 0;
}
