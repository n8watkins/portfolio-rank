#!/usr/bin/env node
// Address moves, by hand (pipeline/site-move.mjs; AUTOMATION.md "Address moves").
//
// Reads the feed on origin/main: the one the deployed app bundles. Run it only
// after the data pull request carrying a new spelling has merged and the app
// with it has deployed; moving a row ahead of the deployed app would hide it
// there. For every entry of that feed:
//   - merges: the entry has a row and other rows have its key (sites split
//     before this existed, most of them delisted with their grade and votes):
//     the old row and everything keyed by it merge into the listed one;
//   - moves: the entry has no row while exactly one stored row has its key:
//     that row and everything keyed by it take the entry's spelling.
// Sites the feed build keeps at their stored address ("Waiting for an address
// move" in the nightly summary) are not in main's feed under the new spelling
// yet, so they are not moved here; the automatic move after deploy will do it.
//
// Each site is read and written in one transaction; a site that fails is
// reported, changes nothing, and the run goes on (exit code 1). Two runs never
// overlap (a lock row in `cache`). Dry run by default: prints every move and
// changes nothing.
//
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/repair-respelled-sites.mjs
//       dry run against that database (production), with origin/main's data/feed.json
//   ... --write --then-recompute
//       apply them, then rebuild the leaderboards and tiers a merge changed
//       (node scripts/recompute-ratings.mjs, node scripts/refresh-tiers.mjs).
//       Without --then-recompute a write that needs them exits 2 and says so.
//   ... --only URL          one old address only
//   ... --feed FILE         another feed, dry run only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pipelineDb } from "../pipeline/roster.mjs";
import { describeMove, findRespellings, moveSite, schemaOf } from "../pipeline/site-move.mjs";

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

/** The recompute a merge needs: the leaderboards and the tiers, from the moved votes. */
export function recomputeScripts() {
  for (const script of ["scripts/recompute-ratings.mjs", "scripts/refresh-tiers.mjs"]) {
    execFileSync(process.execPath, [path.join(ROOT, script)], { stdio: "inherit", env: process.env });
  }
}

/**
 * Plans every merge and move the feed asks for and, with `write`, applies
 * each in its own transaction, then runs `recompute` when a merge needs it.
 * Returns { merges, moves, failed, skipped, orphanShots, needsRecompute, recomputed }.
 */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log, recompute = null } = {}) {
  if (write) await takeLock(db);
  try {
    const found = await findRespellings(db, feed);
    const schema = await schemaOf(db);
    const pick = (list) => (only ? list.filter((p) => p.from === only) : list);
    const out = { merges: [], moves: [], failed: [], skipped: found.skipped, orphanShots: [], needsRecompute: false, recomputed: false };
    for (const [kind, list] of [["merges", pick(found.merges)], ["moves", pick(found.moves)]]) {
      for (const pair of list) {
        try {
          const plan = await moveSite(db, pair, { schema, dryRun: !write });
          out[kind].push(plan);
          out.orphanShots.push(...plan.orphanShots);
          out.needsRecompute ||= plan.needsRecompute;
          log(`${write ? "" : "would "}${kind === "moves" ? "move" : "merge"} ${describeMove(plan)}`);
        } catch (e) {
          out.failed.push({ ...pair, error: String(e?.message ?? e) });
          log(`FAILED ${pair.from} -> ${pair.to}: ${String(e?.message ?? e).slice(0, 300)} (nothing of it changed)`);
        }
      }
    }
    for (const s of found.skipped) log(`skipped ${s.entry}: more than one row has its key (${s.rows.join(", ")}); a person decides`);
    log(
      `${out.merges.length} merge(s) and ${out.moves.length} move(s) ${write ? "done" : "to do (dry run; --write --then-recompute applies them)"}, ` +
        `${out.failed.length} failed, ${found.skipped.length} skipped.` +
        (out.orphanShots.length ? ` Screenshots no row refers to${write ? "" : " after --write"}: ${out.orphanShots.join(", ")}.` : "")
    );
    if (write && out.needsRecompute) {
      if (recompute) {
        log("Recomputing the leaderboards and tiers the merges changed...");
        await recompute();
        out.recomputed = true;
      } else {
        log("NOT DONE YET: a merge changed ratings. Run now: node scripts/recompute-ratings.mjs && node scripts/refresh-tiers.mjs");
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
  console.log("Run --write only after the data pull request with the new spellings has merged and the app has deployed.");
  const r = await repairRespelled(pipelineDb(ROOT), feed, {
    write,
    only: flag("--only"),
    recompute: args.includes("--then-recompute") ? recomputeScripts : null,
  });
  process.exitCode = r.failed.length ? 1 : write && r.needsRecompute && !r.recomputed ? 2 : 0;
}
