// Relists the owner confirmed (/admin/review, lib/reviews/store.mjs) of sites
// that are no longer on data/feed.json, most of them dropped from the
// community list: each goes into data/additions.json ({ name, url }, our own
// entries, kept by generate_feed.py whatever the community list does) and
// into data/feed.json, and out of data/excluded.json when a "down" or
// "not_portfolio" entry keeps it out (the owner saw it working and judged it
// a portfolio). Owner requests and duplicates always stay excluded: a site its
// owner removed is never relisted here, and neither is a copy.
//
// Run by the weekly health workflow before it opens its data pull request
// (.github/workflows/health.yml), so these land through the same bot pull
// request flow as exclusions and owner removals. The daily roster sync then
// lists them again (pipeline/roster.mjs syncRoster).
//   node pipeline/review-additions.mjs [--dry-run]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normKey } from "./health.mjs";
import { excludedUrl, readJson } from "./exclusions.mjs";
import { pipelineDb } from "./roster.mjs";
import { confirmedRelists } from "../lib/reviews/store.mjs";

/** Exclusion kinds a confirmed relist overrides. */
export const OVERRIDABLE = new Set(["down", "not_portfolio"]);

/**
 * Pure: { added, unexcluded, blocked, additions, excluded, feed } without
 * writing. `relists`: [{ url, name }]; a site already on the feed or in
 * additions is left alone; one kept out by an owner request or as a
 * duplicate is `blocked`.
 */
export function planReviewAdditions({ relists, additions, excluded, feed }) {
  const onFeed = new Set(feed.map((p) => normKey(p.url)));
  const inAdditions = new Set(additions.map((a) => normKey(a.url)));
  const exclusionOf = new Map(excluded.map((e) => [normKey(excludedUrl(e)), e]));
  const added = [];
  const blocked = [];
  const lift = new Set();
  for (const r of relists) {
    const key = normKey(r.url);
    const ex = exclusionOf.get(key);
    if (ex !== undefined) {
      const kind = typeof ex === "string" ? "down" : ex.kind ?? "down";
      if (!OVERRIDABLE.has(kind)) {
        blocked.push({ url: r.url, kind });
        continue;
      }
      lift.add(key);
    }
    if (onFeed.has(key) || inAdditions.has(key)) continue;
    inAdditions.add(key);
    onFeed.add(key);
    added.push({ name: String(r.name ?? "").trim() || r.url, url: r.url });
  }
  const unexcluded = excluded.filter((e) => lift.has(normKey(excludedUrl(e)))).map(excludedUrl);
  return {
    added,
    unexcluded,
    blocked,
    additions: [...additions, ...added],
    excluded: excluded.filter((e) => !lift.has(normKey(excludedUrl(e)))),
    feed: [...feed, ...added],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = path.join(import.meta.dirname, "..");
  const file = (f) => path.join(ROOT, "data", f);
  const plan = planReviewAdditions({
    relists: await confirmedRelists(pipelineDb(ROOT)),
    additions: readJson(file("additions.json"), []),
    excluded: readJson(file("excluded.json"), []),
    feed: readJson(file("feed.json"), []),
  });
  const dry = process.argv.includes("--dry-run");
  if ((plan.added.length || plan.unexcluded.length) && !dry) {
    fs.writeFileSync(file("additions.json"), `${JSON.stringify(plan.additions, null, 2)}\n`);
    fs.writeFileSync(file("excluded.json"), `${JSON.stringify(plan.excluded, null, 2)}\n`);
    fs.writeFileSync(file("feed.json"), `${JSON.stringify(plan.feed, null, 2)}\n`);
  }
  const line = `Owner-confirmed relists: ${plan.added.length} added, ${plan.unexcluded.length} no longer excluded, ${plan.blocked.length} blocked (owner request or duplicate)`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Owner-confirmed relists\n\n${line}.\n`);
}
