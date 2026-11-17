#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per listed site (pipeline/list-key.mjs, rules 1
// and 2 over the whole list, before exclusions), the first one wins, and an
// excluded site stays out under every spelling of it. An entry whose key the
// whole list holds more than once is marked `"siblings": true` (rule 2 for
// every later job).
//
// A site the list now spells another way keeps its stored address: when the
// database is configured (TURSO_DATABASE_URL or LOCAL_DB_FILE; the nightly
// sync has it) the build reads every stored address and gives each such entry
// the address its row has (pinWaiting), so the app, every job and the
// database keep agreeing and nothing is lost until the row is moved after the
// new spelling is deployed (AUTOMATION.md, "Address moves"). The database is
// the only source of stored addresses, never the previous feed; a database
// that is configured but cannot be read fails the build. Waiting sites are
// listed in the job summary.
//
//   node pipeline/build-feed.mjs ENTRIES.json OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]
//
// ENTRIES.json is "-" for stdin: [{ name, url, tagline? }] in README order.
// --max-shrink refuses to write (exit 2) when the new feed has more than that
// share fewer entries than OUTPUT.json already has; LIST_CLEANUP_SHARE raises
// it for one run (pipeline/list-util.mjs allowedShare).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SIBLINGS, keysForList, listKey, pinWaiting, waitingSummary } from "./list-key.mjs";
import { allowedShare, excludedUrl, jobSummary, readList } from "./list-util.mjs";

/**
 * Pure: { feed, keyOf, dupes, excludedHits, added }. `entries` from the
 * README, `excluded` and `additions` as in data/.
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
  // Rule 2 looks at the whole list, before exclusions: what upstream and our additions hold together.
  const all = [...upstream, ...ours].map((e) => e.url);
  const keyOf = keysForList(all);
  const count = new Map();
  for (const u of all) count.set(listKey(u), (count.get(listKey(u)) ?? 0) + 1);
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
    const siblings = (count.get(listKey(e.url)) ?? 0) >= 2;
    feed.push({ name: e.name, url: e.url, ...(e.tagline ? { tagline: e.tagline } : {}), ...(siblings ? { [SIBLINGS]: true } : {}) });
    if (fromAdditions) added++;
  };
  for (const e of upstream) take(e, false);
  for (const e of ours) take(e, true);
  return { feed, keyOf, dupes, excludedHits, added };
}

/**
 * Every stored site address, or null when no database is configured. The
 * client is loaded only then. A configured database that cannot be read throws.
 */
export async function storedAddresses(env = process.env) {
  if (!env.TURSO_DATABASE_URL && !env.LOCAL_DB_FILE) return null;
  const { createClient } = await import("@libsql/client");
  const db = env.TURSO_DATABASE_URL
    ? createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN })
    : createClient({ url: `file:${path.resolve(env.LOCAL_DB_FILE)}` });
  try {
    return (await db.execute("SELECT url FROM portfolios")).rows.map((r) => String(r.url));
  } finally {
    db.close();
  }
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
  const stored = await storedAddresses();
  const pins = stored ? pinWaiting(r.feed, stored, r.keyOf) : { waiting: [], unclear: [] };

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
  const extras = [
    r.dupes && `${r.dupes} dup(s)`,
    r.excludedHits && `${r.excludedHits} excluded`,
    r.added && `${r.added} added`,
    pins.waiting.length && `${pins.waiting.length} waiting for an address move`,
  ].filter(Boolean);
  console.log(`✓ Wrote ${output} with ${r.feed.length} entries.${extras.length ? `  (${extras.join(", ")})` : ""}`);
  if (!stored) console.log("(no database configured: sites the list respelled are not kept at their stored address)");
  const section = waitingSummary(pins);
  if (section) {
    console.log(section);
    jobSummary(section);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
