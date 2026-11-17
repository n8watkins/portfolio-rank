#!/usr/bin/env node
// Builds data/feed.json from the community list's entries (parsed from its
// README by pipeline/generate_feed.py, which calls this), our exclusions and
// our additions: one entry per listed site (pipeline/list-key.mjs listKey),
// the first one wins, an excluded site stays out under every spelling.
//
// Every entry is then given the address its site is stored under in the
// database (pinToStored): the durable record of a site's key is its
// portfolios row, which outlives the site leaving the list (excluded, removed
// upstream, relisted) for 30 days and any number of respellings. The list's
// current spelling goes to `href`, the address people are sent to. The
// feed.json being replaced counts as a record too, for a site with no row.
// The database is read when TURSO_DATABASE_URL or LOCAL_DB_FILE is set (the
// nightly sync has it); a database that is set but cannot be read fails the
// build rather than write a feed that respells stored sites.
//
//   node pipeline/build-feed.mjs ENTRIES.json OUTPUT.json [--exclude f] [--add f] [--max-shrink 0.05]
//
// ENTRIES.json is "-" for stdin: [{ name, url, tagline? }] in README order.
// --max-shrink refuses to write (exit 2) when the new feed has more than that
// share fewer entries than OUTPUT.json already has; LIST_CLEANUP_SHARE raises
// it for one run (a real upstream cleanup; pipeline/roster.mjs syncRoster
// reads it too).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listKey, pinToStored } from "./list-key.mjs";
import { cleanupShare, pipelineDb } from "./roster.mjs";

const ROOT = path.join(import.meta.dirname, "..");

const readArray = (file) => {
  if (!file) return [];
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
};

/** Every stored site address: [{ url, listed, graded }], or null when no database is set. */
export async function storedSites(env = process.env) {
  if (!env.TURSO_DATABASE_URL && !env.LOCAL_DB_FILE) return null;
  const db = pipelineDb(ROOT);
  try {
    const have = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portfolios'");
    if (!have.rows.length) return [];
    const cols = new Set((await db.execute("PRAGMA table_info(portfolios)")).rows.map((r) => String(r.name)));
    const listed = cols.has("delisted_at") ? "delisted_at IS NULL" : "1";
    const graded = cols.has("ai_rubric") ? "ai_rubric IS NOT NULL" : "0";
    const res = await db.execute(`SELECT url, ${listed} AS listed, ${graded} AS graded FROM portfolios`);
    return res.rows.map((r) => ({ url: String(r.url), listed: Number(r.listed) === 1, graded: Number(r.graded) === 1 }));
  } finally {
    db.close();
  }
}

/**
 * Pure: { feed, dupes, excludedHits, added, pinned }. `entries` from the
 * README, `excluded` and `additions` as in data/, `previous` the feed.json
 * being replaced, `stored` the database's addresses (storedSites) or null.
 */
export function buildFeed({ entries, excluded = [], additions = [], previous = [], stored = null }) {
  const out = new Set(excluded.map((e) => listKey(typeof e === "string" ? e : e?.url ?? "")));
  const seen = new Set();
  const feed = [];
  let dupes = 0;
  let excludedHits = 0;
  let added = 0;
  const take = (name, url, tagline, fromAdditions) => {
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
    const entry = { name, url };
    if (tagline) entry.tagline = tagline;
    feed.push(entry);
    if (fromAdditions) added++;
  };
  for (const e of entries) {
    const url = String(e?.url ?? "").trim();
    if (url) take(String(e.name ?? "").trim(), url, String(e.tagline ?? "").trim(), false);
  }
  for (const a of additions) {
    const url = String(a?.url ?? "").trim();
    // Name always present: the Portfolio type needs it and the page's <h1> shows it.
    if (url) take(String(a.name ?? "").trim() || url, url, String(a.tagline ?? "").trim(), true);
  }
  // The database's rows first; the old feed covers a site with no row (no database, or not captured yet).
  const records = [...(stored ?? [])];
  const known = new Set(records.map((r) => r.url));
  for (const p of previous) {
    const url = String(p?.url ?? "");
    if (url && !known.has(url)) {
      known.add(url);
      records.push({ url, listed: true, graded: false });
    }
  }
  const pinned = pinToStored(feed, records);
  // Field order as before, href after url.
  const ordered = feed.map(({ name, url, href, tagline }) => ({ name, url, ...(href ? { href } : {}), ...(tagline ? { tagline } : {}) }));
  return { feed: ordered, dupes, excludedHits, added, pinned };
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
  const previous = readArray(output);
  const stored = await storedSites();
  const r = buildFeed({ entries, excluded: readArray(opts.exclude), additions: readArray(opts.add), previous, stored });

  let maxShrink = opts["max-shrink"] == null ? null : Number(opts["max-shrink"]);
  const allowed = cleanupShare();
  if (allowed != null) maxShrink = maxShrink == null ? allowed : Math.max(maxShrink, allowed);
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
    r.pinned.length && `${r.pinned.length} kept their stored address`,
  ].filter(Boolean);
  console.log(`✓ Wrote ${output} with ${r.feed.length} entries.${extras.length ? `  (${extras.join(", ")})` : ""}`);
  if (stored == null) console.log("(no database set: stored addresses come from the feed being replaced only)");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
