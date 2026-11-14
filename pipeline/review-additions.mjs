// Relists the owner confirmed, or the review rule applied (/admin/review,
// lib/reviews/store.mjs), of sites that are no longer on data/feed.json, most
// of them dropped from the community list: each goes into
// data/additions.json ({ name, url, source: "review" }, our own entries, kept
// by generate_feed.py whatever the community list does) and into
// data/feed.json, and out of data/excluded.json when a "down" or
// "not_portfolio" entry keeps it out (the owner saw it working and judged it
// a portfolio). Owner requests and duplicates always stay excluded: a site its
// owner removed is never relisted here, and neither is a copy. An entry this
// script added whose relist was undone comes back out.
//
// Run by the daily upstream sync before it rebuilds the feed
// (.github/workflows/sync-upstream.yml), so a relist is listed within a day,
// and by the weekly health workflow before its data pull request
// (.github/workflows/health.yml). The roster sync then lists them again
// (pipeline/roster.mjs syncRoster).
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
export function planReviewAdditions({ relists, additions: allAdditions, excluded, feed: allFeed }) {
  // A relist taken back (an automatic apply undone): its entry, marked source "review", leaves additions and the feed.
  const wanted = new Set(relists.map((r) => normKey(r.url)));
  const withdrawn = allAdditions.filter((a) => a?.source === "review" && !wanted.has(normKey(a.url))).map((a) => a.url);
  const gone = new Set(withdrawn.map(normKey));
  const additions = allAdditions.filter((a) => !gone.has(normKey(a.url)));
  const feed = allFeed.filter((p) => !gone.has(normKey(p.url)));
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
    // generate_feed.py reads name, url and tagline; source marks the entries this script owns.
    added.push({ name: String(r.name ?? "").trim() || r.url, url: r.url, source: "review" });
  }
  const unexcluded = excluded.filter((e) => lift.has(normKey(excludedUrl(e)))).map(excludedUrl);
  return {
    added,
    unexcluded,
    withdrawn,
    blocked,
    additions: [...additions, ...added],
    excluded: excluded.filter((e) => !lift.has(normKey(excludedUrl(e)))),
    feed: [...feed, ...added.map(({ name, url }) => ({ name, url }))],
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
  if ((plan.added.length || plan.unexcluded.length || plan.withdrawn.length) && !dry) {
    fs.writeFileSync(file("additions.json"), `${JSON.stringify(plan.additions, null, 2)}\n`);
    fs.writeFileSync(file("excluded.json"), `${JSON.stringify(plan.excluded, null, 2)}\n`);
    fs.writeFileSync(file("feed.json"), `${JSON.stringify(plan.feed, null, 2)}\n`);
  }
  const line = `Owner-confirmed relists: ${plan.added.length} added, ${plan.unexcluded.length} no longer excluded, ${plan.withdrawn.length} withdrawn (undone), ${plan.blocked.length} blocked (owner request or duplicate)`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Owner-confirmed relists\n\n${line}.\n`);
}
