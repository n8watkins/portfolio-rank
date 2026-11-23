#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per site key (pipeline/list-key.mjs), the first one
// wins, an excluded site stays out under every spelling of it, and every
// address is written as the list spells it, except a site already on the feed
// that the list respelled: it keeps the feed's spelling (stickySpelling), so
// its database row, grade, votes and screenshots are never split.
//
// A site on the feed that the community list drops stays on it (owner,
// 2026-11-22: "a community list remove shouldnt change anything on our
// side"): the build carries it forward and records it in the additions file
// (LEFT_LIST, with the day it left), so from then on only our own checks,
// our exclusions and an owner's removal take it off (buildFeed).
//
//   node pipeline/build-feed.mjs ENTRIES.json OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]
//
// ENTRIES.json is "-" for stdin: [{ name, url, tagline? }] in README order.
// The additions file (--add) is rewritten when the record changes.
// Three guards refuse to write (exit 2), so a broken or rewritten upstream
// list fails here, before the data pull request is opened:
//   --max-shrink   the new feed has more than that share fewer entries (our
//                  own removals; the community list no longer shrinks it);
//   list drop      the community list dropped more than that share of the
//                  current feed at once (DELIST_MAX_SHARE without
//                  --max-shrink): a README cut short or rewritten to new
//                  addresses, which would otherwise fill the record;
//   drop guard     more than DELIST_MAX_SHARE of the current entries' addresses
//                  are gone from the new feed (what the roster sync would
//                  delist: a list that respelled its addresses).
// LIST_CLEANUP_SHARE raises all three for one run (pipeline/list-util.mjs allowedShare).
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { byListKey, isWebAddress, listKey, spellingKey } from "./list-key.mjs";
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
 * The `source` of a data/additions.json entry that records a site the
 * community list dropped while it was on our feed: { name, url, tagline?,
 * source: LEFT_LIST, left_on: "YYYY-MM-DD" (the day the build first saw it
 * gone) }. Owner, 2026-11-22: "a community list remove shouldnt change
 * anything on our side", so such a site stays listed until our own checks
 * or an owner's removal take it off.
 */
export const LEFT_LIST = "left_community_list";

/**
 * Pure: { feed, dupes, excludedHits, added, kept, unclear, stayed, returned,
 * notAddresses, additions }. `entries` from the README, `excluded` and
 * `additions` as in data/, `current` the feed as it is now (data/feed.json),
 * `today` the day to stamp (YYYY-MM-DD). `kept` lists the respellings written
 * with the current spelling ({ from: upstream's, to: kept }); `unclear` the
 * spelling keys left alone (stickySpelling).
 *
 * A site on the current feed that the README no longer has stays (owner,
 * 2026-11-22), unless one of these is true:
 *   - our exclusions have it (data/excluded.json: dead, down, duplicate, not a
 *     portfolio, an owner's removal), by either key;
 *   - the new feed has it under another spelling (the same listKey, or the
 *     same spellingKey): a respelling, whose old row the roster sync retires
 *     as before;
 *   - its address is not a web address (isWebAddress: a README line an older
 *     parser misread), so a fixed line upstream replaces it.
 * Each one that stays is `stayed`, a new LEFT_LIST record. A recorded site
 * the README lists again (by either key) leaves the record (`returned`) and
 * is listed once, from the README. `additions` is data/additions.json as it
 * must be written: our own entries untouched, the record updated. A recorded
 * site that our exclusions keep out stays recorded, so lifting the exclusion
 * (an undone owner removal, a dead site that answers again) lists it again.
 */
export function buildFeed({ entries, excluded = [], additions: givenAdditions = [], current = [], today = new Date().toISOString().slice(0, 10) }) {
  const out = byListKey(excluded, (e) => excludedUrl(e) ?? "");
  const listUrls = entries.map(urlOf).filter(Boolean);
  const listKeys = new Set(listUrls.map(listKey));
  const listSpellings = new Set(listUrls.map(spellingKey).filter(Boolean));
  const onList = (url) => listKeys.has(listKey(url)) || listSpellings.has(spellingKey(url));
  const isRecord = (a) => a?.source === LEFT_LIST;
  const returned = givenAdditions.filter((a) => isRecord(a) && onList(urlOf(a))).map(urlOf);
  const additions = givenAdditions.filter((a) => !(isRecord(a) && onList(urlOf(a))));
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
  // Sites the community list dropped: they stay, recorded (see above).
  const spellings = new Set(feed.map((p) => spellingKey(p.url)).filter(Boolean));
  const excludedSpellings = new Set(excluded.map((e) => spellingKey(excludedUrl(e) ?? "")).filter(Boolean));
  const stayed = [];
  const notAddresses = [];
  for (const p of current) {
    const url = urlOf(p);
    if (!url) continue;
    const key = listKey(url);
    const spelling = spellingKey(url);
    if (seen.has(key) || spellings.has(spelling) || out.has(key) || excludedSpellings.has(spelling)) continue;
    if (!isWebAddress(url)) {
      notAddresses.push(url);
      continue;
    }
    seen.add(key);
    const name = String(p.name ?? "").trim() || url;
    const tagline = String(p.tagline ?? "").trim();
    const entry = { name, url, ...(tagline ? { tagline } : {}) };
    feed.push(entry);
    stayed.push({ ...entry, source: LEFT_LIST, left_on: today });
  }
  return { feed, dupes, excludedHits, added, kept, unclear, stayed, returned, notAddresses, additions: [...additions, ...stayed] };
}

/**
 * Why the new feed must not be written, or null. `stayed`: how many current
 * sites the community list dropped in this build (buildFeed `stayed`). They
 * stay on the feed, so the feed no longer shrinks when the README is cut
 * short; instead more than `maxShrink` of the current feed dropped at once
 * (DELIST_MAX_SHARE without it) is a broken README, refused before it fills
 * the record.
 */
export function refuseFeed(previous, feed, { maxShrink = null, stayed = 0, env = process.env } = {}) {
  if (!previous.length) return null;
  const shrink = allowedShare(maxShrink, env);
  if (shrink != null && feed.length < previous.length * (1 - shrink)) {
    return `the new feed has ${feed.length} entries, ${previous.length - feed.length} fewer than the current ${previous.length} (more than ${Math.round(shrink * 100)}%)`;
  }
  const dropShare = allowedShare(maxShrink ?? DELIST_MAX_SHARE, env);
  if (stayed > previous.length * dropShare) {
    return `the community list dropped ${stayed} of the current ${previous.length} sites at once (more than ${Math.round(dropShare * 100)}%): is its README broken, cut short or rewritten?`;
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
  const refusal = refuseFeed(previous, r.feed, { maxShrink: opts["max-shrink"] == null ? null : Number(opts["max-shrink"]), stayed: r.stayed.length });
  if (refusal) {
    console.log(`Error: ${refusal}; refusing to write ${output}. For a real upstream cleanup, run once with ${CLEANUP_SHARE_ENV} set to the share to allow.`);
    return 2;
  }
  fs.writeFileSync(output, `${JSON.stringify(r.feed, null, 2)}\n`);
  if (r.stayed.length || r.returned.length) {
    if (opts.add) fs.writeFileSync(opts.add, `${JSON.stringify(r.additions, null, 2)}\n`);
    else console.log(`::warning::no --add file, so the ${r.stayed.length} site(s) that left the community list are on the feed but not recorded`);
  }
  const extras = [
    r.dupes && `${r.dupes} dup(s)`,
    r.excludedHits && `${r.excludedHits} excluded`,
    r.added && `${r.added} added`,
    r.kept.length && `${r.kept.length} respelling(s) kept as the feed spells them`,
    r.unclear.length && `${r.unclear.length} unclear respelling(s)`,
    r.stayed.length && `${r.stayed.length} left the community list and stay`,
    r.returned.length && `${r.returned.length} back on the community list`,
    r.notAddresses.length && `${r.notAddresses.length} not an address, not kept`,
  ].filter(Boolean);
  console.log(`✓ Wrote ${output} with ${r.feed.length} entries.${extras.length ? `  (${extras.join(", ")})` : ""}`);
  if (r.stayed.length || r.returned.length || r.notAddresses.length) {
    jobSummary(
      [
        `### Left the community list: ${r.stayed.length} stay listed, ${r.returned.length} back on it`,
        "",
        "A site the community list drops stays on our list, recorded in data/additions.json with the day it left; only our own checks, our exclusions and an owner's removal take it off (AUTOMATION.md, \"Community list removals\").",
        "",
        ...r.stayed.map((s) => `- stays: ${s.url}`),
        ...r.returned.map((u) => `- back on the community list: ${u}`),
        ...r.notAddresses.map((u) => `- not an address, not kept: ${u}`),
        "",
      ].join("\n")
    );
  }
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
