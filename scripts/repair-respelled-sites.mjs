#!/usr/bin/env node
// Merges split sites by hand (pipeline/site-move.mjs; AUTOMATION.md "Respelled sites").
//
// When the community list respells a site, the roster sync delists the old row
// (with the grade, votes and screenshots) and the new spelling gets a row of
// its own; the purge keeps the old row and every nightly sync counts it under
// "Split sites waiting for a merge". This merges each delisted row into the
// listed row with the same key (pipeline/list-key.mjs), oldest first when a
// site was respelled more than once, when that listed row is on origin/main's
// data/feed.json (the feed the deployed app has). A key with two listed rows
// is reported and left alone.
//
// Each merge is planned right before it is applied, so it sees every merge
// before it, and applied as one transaction whose first statement checks
// that nothing the plan read has changed (else that merge is skipped and
// reported). A merge that fails changes nothing and the run goes on (exit
// code 1). Two runs never overlap (a lock row in `cache`). Screenshots a
// merge leaves unused are recorded in `cache` (orphan-shot:<key>) for a later
// clean-up of R2; this script deletes nothing from R2. Dry run by default.
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
import { StalePlan, applyMove, describeMove, jsonHits, planMove, schemaOf } from "../pipeline/site-move.mjs";

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

/** The merges to make, in order: { pairs: [{ from, to }], unclear: [urls] }. */
export async function findSplits(db, feed) {
  const onFeed = new Set(feed.map((p) => p.url));
  const rows = (await db.execute("SELECT url, delisted_at FROM portfolios")).rows.map((r) => ({ url: String(r.url), delistedAt: r.delisted_at == null ? null : String(r.delisted_at) }));
  const { splits, unclear } = splitSites(rows);
  const pairs = [];
  for (const s of splits) {
    if (onFeed.has(s.to)) for (const from of s.from) pairs.push({ from, to: s.to });
    else unclear.push([...s.from, s.to]);
  }
  return { pairs, unclear };
}

/**
 * Plans and, with `write`, applies every merge, one at a time, then runs
 * `recompute` when a merge needs it.
 * Returns { merged, failed, unclear, orphanShots, needsRecompute, recomputed }.
 */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log, recompute = null } = {}) {
  if (write) await takeLock(db);
  try {
    const found = await findSplits(db, feed);
    const pairs = only ? found.pairs.filter((p) => p.from === only) : found.pairs;
    const out = { merged: [], failed: [], unclear: found.unclear, orphanShots: [], needsRecompute: false, recomputed: false };
    if (pairs.length) {
      const schema = await schemaOf(db);
      const json = await jsonHits(db, pairs.map((p) => p.from), schema);
      for (const pair of pairs) {
        try {
          const plan = await planMove(db, pair, { schema, json });
          if (write) await applyMove(db, plan);
          out.merged.push(plan);
          out.orphanShots.push(...plan.orphanShots.map((o) => o.key));
          out.needsRecompute ||= plan.needsRecompute;
          log(`${write ? "merged" : "would merge"} ${describeMove(plan)}`);
        } catch (e) {
          out.failed.push({ ...pair, stale: e instanceof StalePlan, error: String(e?.message ?? e) });
          log(`${e instanceof StalePlan ? "SKIPPED (changed since planned)" : "FAILED"} ${pair.from} -> ${pair.to}: ${String(e?.message ?? e).slice(0, 300)} (nothing of it changed)`);
        }
      }
    }
    for (const u of found.unclear) log(`left alone, a person decides: ${u.join(", ")}`);
    log(
      `${out.merged.length} merge(s) ${write ? "done" : "to do (dry run; --write --then-recompute applies them)"}, ${out.failed.length} failed or skipped, ${found.unclear.length} left alone.` +
        (out.orphanShots.length ? ` ${out.orphanShots.length} screenshot folder(s) no row uses any more${write ? " are recorded in cache as orphan-shot:<key>" : " would be recorded"}.` : "")
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
