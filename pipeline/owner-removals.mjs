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
import { ownerRemovals } from "../lib/games/claims.mjs";

export const OWNER_REASON = "owner request";

/**
 * Adds every owner removal not yet excluded. Pure: returns { added,
 * excluded, feed } without writing.
 */
export function planOwnerRemovals({ removals, excluded, feed }) {
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
  const drop = new Set(added.map((a) => normKey(a.url)));
  return { added, excluded: [...excluded, ...added], feed: feed.filter((p) => !drop.has(normKey(p.url))) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.join(import.meta.dirname, "..");
  const excludedPath = path.join(ROOT, "data", "excluded.json");
  const feedPath = path.join(ROOT, "data", "feed.json");
  const db = pipelineDb(ROOT);
  const plan = planOwnerRemovals({
    removals: await ownerRemovals(db),
    excluded: readJson(excludedPath, []),
    feed: readJson(feedPath, []),
  });
  if (plan.added.length && !process.argv.includes("--dry-run")) {
    fs.writeFileSync(excludedPath, `${JSON.stringify(plan.excluded, null, 2)}\n`);
    fs.writeFileSync(feedPath, `${JSON.stringify(plan.feed, null, 2)}\n`);
  }
  // Counted, never named: the job summary is public on a public repository.
  const line = `Owner removals: ${plan.added.length} new`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Owner removals\n\n${plan.added.length} new.\n`);
}
