#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per listed site (pipeline/list-key.mjs, rules 1
// and 2 over the whole list), the first one wins, and an excluded site stays
// out under every spelling of it. Every address is written exactly as the
// list spells it; when that spelling changes, the roster sync moves the
// site's row to it (pipeline/site-move.mjs).
//
//   node pipeline/build-feed.mjs ENTRIES.json OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]
//
// ENTRIES.json is "-" for stdin: [{ name, url, tagline? }] in README order.
// --max-shrink refuses to write (exit 2) when the new feed has more than that
// share fewer entries than OUTPUT.json already has; LIST_CLEANUP_SHARE raises
// it for one run (pipeline/roster.mjs allowedShare, which the roster sync's
// guards use too).
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { keysForList } from "./list-key.mjs";
import { excludedUrl, readJson } from "./exclusions.mjs";
import { allowedShare } from "./roster.mjs";

/** A JSON list file: [] when it does not exist, an error when it is anything but a list. */
export function readList(file) {
  if (!file) return [];
  const v = readJson(file, []);
  if (!Array.isArray(v)) throw new Error(`${file} is not a JSON list; refusing to build the feed from it`);
  return v;
}

/**
 * Pure: { feed, dupes, excludedHits, added }. `entries` from the README,
 * `excluded` and `additions` as in data/.
 */
export function buildFeed({ entries, excluded = [], additions = [] }) {
  const clean = (list, fallbackName) =>
    list
      .map((e) => ({ name: String(e?.name ?? "").trim(), url: String(e?.url ?? "").trim(), tagline: String(e?.tagline ?? "").trim() }))
      .filter((e) => e.url)
      .map((e) => (fallbackName && !e.name ? { ...e, name: e.url } : e));
  const upstream = clean(entries, false);
  // Name always present for additions: the Portfolio type needs it and the page's <h1> shows it.
  const ours = clean(additions, true);
  // Rule 2 looks at the whole list: what upstream and our additions hold together.
  const keyOf = keysForList([...upstream, ...ours].map((e) => e.url));
  const out = new Set(excluded.map((e) => keyOf(excludedUrl(e) ?? "")));
  const seen = new Set();
  const feed = [];
  let dupes = 0;
  let excludedHits = 0;
  let added = 0;
  const take = (e, fromAdditions) => {
    const key = keyOf(e.url);
    if (out.has(key)) {
      if (!fromAdditions) excludedHits++;
      return;
    }
    if (seen.has(key)) {
      if (!fromAdditions) dupes++;
      return;
    }
    seen.add(key);
    feed.push({ name: e.name, url: e.url, ...(e.tagline ? { tagline: e.tagline } : {}) });
    if (fromAdditions) added++;
  };
  for (const e of upstream) take(e, false);
  for (const e of ours) take(e, true);
  return { feed, dupes, excludedHits, added };
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

  const maxShrink = allowedShare(opts["max-shrink"] == null ? null : Number(opts["max-shrink"]));
  if (maxShrink != null && previous.length && r.feed.length < previous.length * (1 - maxShrink)) {
    console.log(
      `Error: the new feed has ${r.feed.length} entries, ${previous.length - r.feed.length} fewer than the current ${previous.length} ` +
        `(more than ${Math.round(maxShrink * 100)}%); refusing to write ${output}. ` +
        `For a real upstream cleanup, run once with LIST_CLEANUP_SHARE set to the share to allow.`
    );
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
