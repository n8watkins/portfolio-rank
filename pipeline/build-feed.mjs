#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per site key (pipeline/list-key.mjs), the first one
// wins, an excluded site stays out under every spelling of it, and every
// address is written as the list spells it, except a site already on the feed
// that the list respelled: it keeps the feed's spelling (stickySpelling), so
// its database row, grade, votes and screenshots are never split.
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
import { byListKey, listKey, spellingKey } from "./list-key.mjs";
import { CLEANUP_SHARE_ENV, DELIST_MAX_SHARE, allowedShare, excludedUrl, jobSummary, readList } from "./list-util.mjs";

/** An entry's address, trimmed ("" when it has none). */
const urlOf = (e) => String(e?.url ?? "").trim();

/**
 * Sticky spelling: the address the feed writes for an entry. When the entry's
 * address has the spelling key (pipeline/list-key.mjs spellingKey) and the
 * list key of exactly one address on the current feed, the current feed's
 * spelling is kept, so a respelling upstream (a slash, `www.`, the host's
 * case, the scheme, tracking parameters) never reaches the database as a new
 * site. Every incoming spelling of that key is that one site, however many
 * the list has. Returns { spell(url), unclear: [{ current: [urls], listed:
 * [urls] }] }, where unclear lists the keys with two or more current
 * addresses, left as the list spells them.
 */
export function stickySpelling(current, incomingUrls) {
  const now = new Map();
  for (const p of current) {
    const url = urlOf(p);
    const key = url && spellingKey(url);
    if (!key) continue;
    if (!now.has(key)) now.set(key, new Set());
    now.get(key).add(url);
  }
  const keep = new Map();
  const unclear = new Map();
  for (const url of incomingUrls) {
    const key = spellingKey(url);
    if (!key || !now.has(key)) continue;
    const was = [...now.get(key)];
    if (was.length === 1) {
      // Same list key too, so exclusions and duplicates see exactly what they would have.
      if (listKey(was[0]) === listKey(url)) keep.set(url, was[0]);
      continue;
    }
    if (!unclear.has(key)) unclear.set(key, { current: was, listed: [] });
    const u = unclear.get(key);
    if (!was.includes(url) && !u.listed.includes(url)) u.listed.push(url);
  }
  return { spell: (url) => keep.get(url) ?? url, unclear: [...unclear.values()] };
}

/**
 * Pure: { feed, dupes, excludedHits, added, kept, unclear }. `entries` from
 * the README, `excluded` and `additions` as in data/, `current` the feed as it
 * is now (data/feed.json). `kept` lists the respellings written with the
 * current spelling ({ from: upstream's, to: kept }); `unclear` the spelling
 * keys left alone (stickySpelling).
 */
export function buildFeed({ entries, excluded = [], additions = [], current = [] }) {
  const out = byListKey(excluded, (e) => excludedUrl(e) ?? "");
  const all = [...entries, ...additions].map(urlOf).filter(Boolean);
  const { spell, unclear } = stickySpelling(current, all);
  const seen = new Set();
  const feed = [];
  const kept = [];
  let dupes = 0;
  let excludedHits = 0;
  let added = 0;
  const take = (e, fromAdditions) => {
    const given = urlOf(e);
    if (!given) return;
    // Same list key as `given` (stickySpelling checks it), so exclusions and duplicates are unchanged.
    const url = spell(given);
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
    if (url !== given) kept.push({ from: given, to: url });
    // Name always present for additions: the Portfolio type needs it and the page's <h1> shows it.
    const name = String(e.name ?? "").trim() || (fromAdditions ? url : "");
    const tagline = String(e.tagline ?? "").trim();
    feed.push({ name, url, ...(tagline ? { tagline } : {}) });
    if (fromAdditions) added++;
  };
  for (const e of entries) take(e, false);
  for (const a of additions) take(a, true);
  return { feed, dupes, excludedHits, added, kept, unclear };
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
  const r = buildFeed({ entries, excluded: readList(opts.exclude), additions: readList(opts.add), current: previous });
  const refusal = refuseFeed(previous, r.feed, { maxShrink: opts["max-shrink"] == null ? null : Number(opts["max-shrink"]) });
  if (refusal) {
    console.log(`Error: ${refusal}; refusing to write ${output}. For a real upstream cleanup, run once with ${CLEANUP_SHARE_ENV} set to the share to allow.`);
    return 2;
  }
  fs.writeFileSync(output, `${JSON.stringify(r.feed, null, 2)}\n`);
  const extras = [
    r.dupes && `${r.dupes} dup(s)`,
    r.excludedHits && `${r.excludedHits} excluded`,
    r.added && `${r.added} added`,
    r.kept.length && `${r.kept.length} respelling(s) kept as the feed spells them`,
    r.unclear.length && `${r.unclear.length} unclear respelling(s)`,
  ].filter(Boolean);
  console.log(`✓ Wrote ${output} with ${r.feed.length} entries.${extras.length ? `  (${extras.join(", ")})` : ""}`);
  if (r.kept.length || r.unclear.length) {
    jobSummary(
      [
        `### Respellings on the community list: ${r.kept.length} kept, ${r.unclear.length} unclear`,
        "",
        "A kept site keeps the feed's address, so its row, grade, votes and screenshots stay as they are (AUTOMATION.md, \"Respelled sites\"). An unclear one has two current addresses on the feed, so the list's spelling is used.",
        "",
        ...r.kept.map((k) => `- ${k.to} (the list spells it ${k.from})`),
        ...r.unclear.map(
          (u) => `- unclear: current ${u.current.join(", ")}; ${u.listed.length ? `the list spells it ${u.listed.join(", ")}` : "the list uses a current spelling"}`
        ),
        "",
      ].join("\n")
    );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
