// Owner removals: portfolios their verified owners removed (app/api/owner,
// lib/games/claims.mjs) go into data/excluded.json with kind
// "owner_request" and reason "owner request", and out of data/feed.json,
// so generate_feed.py keeps them out even while the community list still
// has them. /removed counts these, never names them. The site hides them
// as soon as the owner asks; this makes it permanent.
//
// Run by the weekly health workflow before it opens its exclusions pull
// request (.github/workflows/health.yml), so they land through the same bot
// pull request flow.
//   node pipeline/owner-removals.mjs [--dry-run]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normKey } from "./health.mjs";
import { excludedUrl, readJson } from "./exclusions.mjs";
import { pipelineDb } from "./roster.mjs";
import { logRemovalRestored, ownerRemovals, undoneRemovals } from "../lib/games/claims.mjs";

export const OWNER_REASON = "owner request";

/**
 * Adds every owner removal not yet excluded, and takes out the owner_request
 * entries of removals the admin undid (`undone`: urls listed again). Pure:
 * returns { added, restored, excluded, feed } without writing. A restored
 * site comes back to the feed with the next daily upstream sync
 * (generate_feed.py), which no longer excludes it.
 */
export function planOwnerRemovals({ removals, undone = [], excluded, feed }) {
  const have = new Set(excluded.map((e) => normKey(excludedUrl(e))));
  const onFeed = new Map(feed.map((p) => [normKey(p.url), p]));
  const added = [];
  for (const r of removals) {
    const key = normKey(r.url);
    if (have.has(key)) continue;
    have.add(key);
    // No name: the entry only has to keep the address off the list.
    added.push({
      url: onFeed.get(key)?.url ?? r.url,
      reason: OWNER_REASON,
      kind: "owner_request",
      removed: String(r.removedAt).slice(0, 10),
    });
  }
  // Only owner requests: a site excluded as down stays out even if its removal was undone.
  const back = new Set(undone.map((u) => normKey(u.url ?? u)));
  const current = new Set(removals.map((r) => normKey(r.url)));
  const restored = [];
  const kept = excluded.filter((e) => {
    const key = normKey(excludedUrl(e));
    if (typeof e === "string" || e?.kind !== "owner_request" || !back.has(key) || current.has(key)) return true;
    restored.push(excludedUrl(e));
    return false;
  });
  const drop = new Set(added.map((a) => normKey(a.url)));
  return { added, restored, excluded: [...kept, ...added], feed: feed.filter((p) => !drop.has(normKey(p.url))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.join(import.meta.dirname, "..");
  const excludedPath = path.join(ROOT, "data", "excluded.json");
  const feedPath = path.join(ROOT, "data", "feed.json");
  const db = pipelineDb(ROOT);
  const plan = planOwnerRemovals({
    removals: await ownerRemovals(db),
    undone: await undoneRemovals(db),
    excluded: readJson(excludedPath, []),
    feed: readJson(feedPath, []),
  });
  const dry = process.argv.includes("--dry-run");
  if ((plan.added.length || plan.restored.length) && !dry) {
    fs.writeFileSync(excludedPath, `${JSON.stringify(plan.excluded, null, 2)}\n`);
    fs.writeFileSync(feedPath, `${JSON.stringify(plan.feed, null, 2)}\n`);
  }
  if (plan.restored.length && !dry) await logRemovalRestored(db, plan.restored);
  // Counted, never named: the job summary is public on a public repository.
  const line = `Owner removals: ${plan.added.length} new, ${plan.restored.length} restored`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Owner removals\n\n${plan.added.length} new, ${plan.restored.length} restored (undone by the admin).\n`);
}
