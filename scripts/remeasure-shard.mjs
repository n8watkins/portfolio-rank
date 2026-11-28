#!/usr/bin/env node
// One shard of the "re-capture and re-measure the whole list" run
// (.github/workflows/remeasure-all.yml): writes the addresses shard i of n
// should hand to `node pipeline/capture.mjs --recapture <file>`, one a line.
// Reads data/feed.json and the database; writes nothing to the database.
//
//   node scripts/remeasure-shard.mjs --shard 1 --shards 4 --out shard.txt
//        [--skip-version 2] [--limit 10]
//
// The list: addresses in data/feed.json whose row is live, captured and not
// delisted (a site with no capture yet is the nightly capture's job, a
// delisted one is not on the list). The split is by a hash of the address, so
// the shards never overlap, together they cover the list, and a re-run gives
// the same split. --skip-version V leaves out sites whose stored facts
// already carry version V or newer (the `v` field of portfolios.facts) and,
// when the code being run has pipeline/cookie-check.mjs, a done cookie check
// reading (facts.privacy, hasCookieCheck), and, when that code stores the list
// of project links (its pipeline/facts.mjs declares LINK_ITEMS_MAX), a project
// link check with its list (facts.project_links.items, hasLinkItems), and,
// when that code has pipeline/first-five.mjs declaring FIRST_FIVE_VERSION, a
// done first five seconds reading (facts.first_five, hasFirstFive), so a
// re-run after a failure only does what is left, and the whole-list run fills
// in the cookie check, the list and the reading where they are missing. It imports nothing
// from pipeline/ but roster.mjs, which every
// release has (the workflow runs it from main against the released code). --limit caps the shard (a
// small trial run); it keeps the first addresses in address order.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

/**
 * The cookie check's reading version this script fills in (pipeline/cookie-check.mjs
 * PRIVACY_VERSION; tests/remeasure-shard.test.mjs keeps the two equal). Written
 * out here, not imported: the workflow runs this script from main against the
 * released code tree, which may not have pipeline/cookie-check.mjs yet.
 */
export const PRIVACY_VERSION = 1;
/** A reading that could not tell (`unknown`) younger than this counts as done, so a re-run that day does not redo it. */
export const UNKNOWN_RETRY_MS = 20 * 60 * 60 * 1000;

/**
 * Whether stored facts (an object or its JSON) carry a cookie check reading
 * that is done: at PRIVACY_VERSION, from any region, and not `unknown`, or
 * `unknown` but made within UNKNOWN_RETRY_MS of `now` (a site that can never
 * be read is tried once per run of the whole list, not again on its re-runs).
 */
export function hasCookieCheck(facts, now = Date.now()) {
  try {
    const f = typeof facts === "string" ? JSON.parse(facts) : facts;
    const p = f?.privacy;
    if (!p || Number(p.v) !== PRIVACY_VERSION || !p.readings || typeof p.readings !== "object") return false;
    return Object.values(p.readings).some((r) => r && (r.state !== "unknown" || now - Date.parse(r.at) < UNKNOWN_RETRY_MS));
  } catch {
    return false;
  }
}

/**
 * Whether stored facts (an object or its JSON) have the list of project links
 * (facts.project_links.items, pipeline/facts.mjs checkLinks) wherever they have
 * a project link check: a check stored as counts alone has not, and the facts
 * version does not tell (the list came without a new version). No check
 * (project_links null or missing) has no list to fill in, so it is done.
 */
export function hasLinkItems(facts) {
  try {
    const f = typeof facts === "string" ? JSON.parse(facts) : facts;
    const l = f?.project_links;
    if (!l || typeof l !== "object") return true;
    return Array.isArray(l.items);
  } catch {
    return false;
  }
}

/**
 * Whether the code tree at `root` stores the list of project links: its
 * pipeline/facts.mjs declares LINK_ITEMS_MAX. Read as text, never imported:
 * the workflow runs this script against a released code tree that may not have it.
 */
export function storesLinkItems(root) {
  try {
    return /^export const LINK_ITEMS_MAX\b/m.test(fs.readFileSync(path.join(root, "pipeline", "facts.mjs"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * The first five seconds' reading version this script fills in (pipeline/first-five.mjs
 * FIRST_FIVE_VERSION; tests/remeasure-shard.test.mjs keeps the two equal). Written out
 * here, not imported, for the same reason as PRIVACY_VERSION.
 */
export const FIRST_FIVE_VERSION = 1;

/**
 * Whether stored facts (an object or its JSON) carry a done first five seconds
 * reading (facts.first_five): at FIRST_FIVE_VERSION, and each view (mobile,
 * desktop) measured, or not measured but tried within UNKNOWN_RETRY_MS of
 * `now` (a site whose phone visit always meets a bot check is tried once per
 * run of the whole list, not again on its re-runs).
 */
export function hasFirstFive(facts, now = Date.now()) {
  try {
    const f = typeof facts === "string" ? JSON.parse(facts) : facts;
    const ff = f?.first_five;
    if (!ff || Number(ff.v) !== FIRST_FIVE_VERSION) return false;
    const done = (view) => view && (view.state === "measured" || now - Date.parse(view.at) < UNKNOWN_RETRY_MS);
    return Boolean(done(ff.mobile) && done(ff.desktop));
  } catch {
    return false;
  }
}

/**
 * Whether the code tree at `root` measures the first five seconds: it has
 * pipeline/first-five.mjs declaring FIRST_FIVE_VERSION. Read as text, never imported.
 */
export function measuresFirstFive(root) {
  try {
    return /^export const FIRST_FIVE_VERSION\b/m.test(fs.readFileSync(path.join(root, "pipeline", "first-five.mjs"), "utf8"));
  } catch {
    return false;
  }
}

/** The shard (0-based) an address belongs to, out of `shards`. Stable: a hash of the address alone. */
export function shardOf(url, shards) {
  return createHash("sha1").update(String(url)).digest().readUInt32BE(0) % shards;
}

/** The facts version stored in a row's `facts` JSON, or 0 when there is none or it cannot be read. */
export function factsVersion(facts) {
  try {
    const v = Number(JSON.parse(String(facts ?? "null"))?.v);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

/**
 * The addresses of shard `shard` (1-based) of `shards`.
 * `feed`: data/feed.json entries; `rows`: { url, facts } of the live, captured,
 * listed rows. Returns { urls, listed, skipped }: `listed` the sites of the
 * whole list that qualify, `skipped` those left out of them for already
 * carrying `skipVersion`, in this shard only. `cookieCheck`: whether the code
 * being run measures the cookie check (it has pipeline/cookie-check.mjs); only
 * then is a row without a done reading (hasCookieCheck) still to do, or every
 * row would stay to do on a release without it. `linkItems`: likewise,
 * whether the code being run stores the list of project links
 * (storesLinkItems); only then is a row whose link check has no list
 * (hasLinkItems) still to do. `firstFive`: likewise, whether the code being
 * run measures the first five seconds (measuresFirstFive); only then is a row
 * without a done reading (hasFirstFive) still to do.
 */
export function pickShard({ feed, rows, shard, shards, skipVersion = 0, limit = 0, cookieCheck = false, linkItems = false, firstFive = false, now = Date.now() }) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a whole number of 1 or more, got ${shards}`);
  if (!Number.isInteger(shard) || shard < 1 || shard > shards) throw new Error(`shard must be a whole number from 1 to ${shards}, got ${shard}`);
  const facts = new Map(rows.map((r) => [String(r.url), r.facts]));
  const urls = [...new Set(feed.map((p) => String(p.url)))].filter((u) => facts.has(u)).sort();
  const mine = urls.filter((u) => shardOf(u, shards) === shard - 1);
  // Still to do: facts older than skipVersion, or, when the code measures it, facts with no done cookie
  // check reading (hasCookieCheck), or, when the code stores it, a link check without its list (hasLinkItems),
  // or, when the code measures it, no done first five seconds reading (hasFirstFive), so the whole-list run fills them in.
  const done = (u) =>
    factsVersion(facts.get(u)) >= skipVersion &&
    (!cookieCheck || hasCookieCheck(facts.get(u), now)) &&
    (!linkItems || hasLinkItems(facts.get(u))) &&
    (!firstFive || hasFirstFive(facts.get(u), now));
  const wanted = skipVersion > 0 ? mine.filter((u) => !done(u)) : mine;
  const capped = limit > 0 ? wanted.slice(0, limit) : wanted;
  return { urls: capped, listed: urls.length, inShard: mine.length, skipped: mine.length - wanted.length };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback = "") => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const whole = (name, fallback) => {
    const text = String(flag(name, fallback)).trim();
    if (!/^\d+$/.test(text)) throw new Error(`--${name} must be a whole number, got "${text}"`);
    return Number(text);
  };
  const shard = whole("shard", "1");
  const shards = whole("shards", "1");
  const skipVersion = whole("skip-version", "0");
  const limit = whole("limit", "0");
  const out = flag("out");
  if (!out) throw new Error("--out <file> is required");

  const root = path.join(import.meta.dirname, "..");
  const { pipelineDb } = await import("../pipeline/roster.mjs");
  const db = pipelineDb(root);
  const feed = JSON.parse(fs.readFileSync(path.join(root, "data", "feed.json"), "utf8"));
  const rows = (
    await db.execute("SELECT url, facts FROM portfolios WHERE status = 'live' AND shot_key IS NOT NULL AND delisted_at IS NULL")
  ).rows.map((r) => ({ url: String(r.url), facts: r.facts }));

  // The code tree being run (the release's, or this branch's): whether it measures the cookie check.
  const cookieCheck = fs.existsSync(path.join(root, "pipeline", "cookie-check.mjs"));
  // And whether it stores the list of project links.
  const linkItems = storesLinkItems(root);
  // And whether it measures the first five seconds.
  const firstFive = measuresFirstFive(root);
  const { urls, listed, inShard, skipped } = pickShard({ feed, rows, shard, shards, skipVersion, limit, cookieCheck, linkItems, firstFive });
  fs.writeFileSync(out, urls.map((u) => `${u}\n`).join(""));
  console.log(
    `shard ${shard} of ${shards}: ${urls.length} site(s) to re-capture ` +
      `(${inShard} of the ${listed} listed, live and captured sites belong to it; ` +
      `${skipped} skipped for facts already at version ${skipVersion} or newer${cookieCheck ? ", with a cookie check" : ""}` +
      `${linkItems ? ", with a list of project links" : ""}${firstFive ? ", with a first five seconds reading" : ""}; limit ${limit || "none"})`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    }
  );
}
