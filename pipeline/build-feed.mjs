#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per site key (pipeline/list-key.mjs), the first one
// wins, an excluded site stays out under every spelling of it, and every
// address is written exactly as the list spells it.
//
//   node pipeline/build-feed.mjs ENTRIES.json OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]
//
// ENTRIES.json is "-" for stdin: [{ name, url, tagline? }] in README order.
// Two guards refuse to write (exit 2), so a broken or rewritten upstream list
// fails here, before the data pull request is opened:
//   --max-shrink   the new feed has more than that share fewer entries;
//   drop guard     more than DELIST_MAX_SHARE of the current entries' addresses
//                  are gone from the new feed (what the roster sync would
//                  delist; a list that rewrote its addresses keeps its length).
// LIST_CLEANUP_SHARE raises both for one run (pipeline/list-util.mjs allowedShare).
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { byListKey, listKey } from "./list-key.mjs";
import { CLEANUP_SHARE_ENV, DELIST_MAX_SHARE, allowedShare, excludedUrl, readList } from "./list-util.mjs";

/** Pure: { feed, dupes, excludedHits, added }. `entries` from the README, `excluded` and `additions` as in data/. */
export function buildFeed({ entries, excluded = [], additions = [] }) {
  const out = byListKey(excluded, (e) => excludedUrl(e) ?? "");
  const seen = new Set();
  const feed = [];
  let dupes = 0;
  let excludedHits = 0;
  let added = 0;
  const take = (e, fromAdditions) => {
    const url = String(e?.url ?? "").trim();
    if (!url) return;
    const key = listKey(url);
    if (out.has(key)) {
      if (!fromAdditions) excludedHits++;
      return;
    }
    if (seen.has(key)) {
      if (!fromAdditions) dupes++;
      return;
    }
    seen.add(key);
    // Name always present for additions: the Portfolio type needs it and the page's <h1> shows it.
    const name = String(e.name ?? "").trim() || (fromAdditions ? url : "");
    const tagline = String(e.tagline ?? "").trim();
    feed.push({ name, url, ...(tagline ? { tagline } : {}) });
    if (fromAdditions) added++;
  };
  for (const e of entries) take(e, false);
  for (const a of additions) take(a, true);
  return { feed, dupes, excludedHits, added };
}

/** Why the new feed must not be written, or null. */
export function refuseFeed(previous, feed, { maxShrink = null, env = process.env } = {}) {
  if (!previous.length) return null;
  const shrink = allowedShare(maxShrink, env);
  if (shrink != null && feed.length < previous.length * (1 - shrink)) {
    return `the new feed has ${feed.length} entries, ${previous.length - feed.length} fewer than the current ${previous.length} (more than ${Math.round(shrink * 100)}%)`;
  }
  const now = new Set(feed.map((p) => p.url));
  const gone = previous.filter((p) => !now.has(p.url)).length;
  const drop = allowedShare(DELIST_MAX_SHARE, env);
  if (gone > previous.length * drop) {
    return `${gone} of the current ${previous.length} addresses are gone from the new feed (more than ${Math.round(drop * 100)}%): did upstream rewrite its addresses?`;
  }
  return null;
}

async function main(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  const [entriesFile, output] = positional;
  if (!entriesFile || !output) {
    console.error("usage: node pipeline/build-feed.mjs ENTRIES.json|- OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]");
    return 1;
  }
  const entries = JSON.parse(entriesFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(entriesFile, "utf8"));
  if (!Array.isArray(entries)) throw new Error("the README's entries are not a list");
  const previous = readList(output);
  const r = buildFeed({ entries, excluded: readList(opts.exclude), additions: readList(opts.add) });
  const refusal = refuseFeed(previous, r.feed, { maxShrink: opts["max-shrink"] == null ? null : Number(opts["max-shrink"]) });
  if (refusal) {
    console.log(`Error: ${refusal}; refusing to write ${output}. For a real upstream cleanup, run once with ${CLEANUP_SHARE_ENV} set to the share to allow.`);
    return 2;
  }
  fs.writeFileSync(output, `${JSON.stringify(r.feed, null, 2)}\n`);
  const extras = [r.dupes && `${r.dupes} dup(s)`, r.excludedHits && `${r.excludedHits} excluded`, r.added && `${r.added} added`].filter(Boolean);
  console.log(`✓ Wrote ${output} with ${r.feed.length} entries.${extras.length ? `  (${extras.join(", ")})` : ""}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
