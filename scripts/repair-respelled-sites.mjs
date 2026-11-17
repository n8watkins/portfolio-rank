#!/usr/bin/env node
// The address moves (pipeline/site-move.mjs) for the whole database, by hand:
//
//   - the moves the nightly roster sync would make now (a feed entry with no
//     row whose key exactly one stored row has: the row moves to the feed's
//     spelling), so the owner can see them before the first nightly run;
//   - the merges of sites split before moves existed (the feed's spelling has
//     a row, and an older spelling of the same site has another one, most of
//     them delisted with the grade and votes): the old row and everything
//     keyed by it merge into the listed one.
//
// Each site is its own transaction; a site that fails is reported, changes
// nothing, and the run goes on with the next one (exit code 1 at the end).
// Dry run by default: prints every move and merge and changes nothing.
//
//   node scripts/repair-respelled-sites.mjs                   dry run, local database (data/portfoliorank.db or LOCAL_DB_FILE)
//   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/repair-respelled-sites.mjs
//                                                             dry run against that database (production)
//   ... --write                                               apply them
//   ... --feed FILE                                           another feed.json (default data/feed.json)
//   ... --only URL                                            one old address only
//
// After --write: node scripts/recompute-ratings.mjs and node scripts/refresh-tiers.mjs
// rebuild the leaderboards and the tiers from the moved votes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_MOVES, cleanupShare, pipelineDb } from "../pipeline/roster.mjs";
import { applyMove, describeMove, findRespellings, planMove, schemaOf } from "../pipeline/site-move.mjs";

const ROOT = path.join(import.meta.dirname, "..");

/**
 * Plans every move and merge the feed asks for and, with `write`, applies
 * each in its own transaction. Returns { moves, merges, failed, skipped, orphanShots }.
 */
export async function repairRespelled(db, feed, { write = false, only = null, log = console.log } = {}) {
  const found = await findRespellings(db, feed);
  const schema = await schemaOf(db);
  const pick = (list) => (only ? list.filter((p) => p.from === only) : list);
  const out = { moves: [], merges: [], failed: [], skipped: found.skipped, orphanShots: [] };
  for (const [kind, list] of [["merges", pick(found.merges)], ["moves", pick(found.moves)]]) {
    for (const pair of list) {
      try {
        const plan = await planMove(db, pair, schema);
        if (write) await applyMove(db, plan);
        out[kind].push(plan);
        out.orphanShots.push(...plan.orphanShots);
        log(`${write ? "" : "would "}${kind === "moves" ? "move" : "merge"} ${describeMove(plan)}`);
      } catch (e) {
        out.failed.push({ ...pair, error: String(e?.message ?? e) });
        log(`FAILED ${pair.from} -> ${pair.to}: ${String(e?.message ?? e).slice(0, 300)} (nothing of it changed)`);
      }
    }
  }
  for (const s of found.skipped) log(`skipped ${s.key}: more than one row or entry has it (rows ${s.rows.join(", ")}; entries ${s.entries.join(", ")})`);
  const share = cleanupShare();
  const limit = Math.max(MAX_MOVES, share == null ? 0 : Math.floor(share * feed.length));
  log(
    `${out.merges.length} merge(s) and ${out.moves.length} move(s) ${write ? "done" : "to do (dry run; --write applies them)"}, ` +
      `${out.failed.length} failed, ${found.skipped.length} skipped.` +
      (out.orphanShots.length ? ` Screenshots no row refers to${write ? "" : " after --write"}: ${out.orphanShots.join(", ")}.` : "")
  );
  if (!write && found.moves.length > limit) {
    log(`The nightly sync would refuse ${found.moves.length} moves (more than ${limit}) until they are applied here or LIST_CLEANUP_SHARE allows them.`);
  }
  if (write && (out.merges.length || out.moves.length)) log("Next: node scripts/recompute-ratings.mjs and node scripts/refresh-tiers.mjs");
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const feedPath = flag("--feed") ?? path.join(ROOT, "data", "feed.json");
  const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
  const db = pipelineDb(ROOT);
  console.log(`database: ${process.env.TURSO_DATABASE_URL ? "TURSO_DATABASE_URL" : "local file"}; feed: ${feedPath} (${feed.length} entries)`);
  const r = await repairRespelled(db, feed, { write: args.includes("--write"), only: flag("--only") });
  process.exitCode = r.failed.length ? 1 : 0;
}
