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
// already carry version V or newer (the `v` field of portfolios.facts), so a
// re-run after a failure only does what is left. --limit caps the shard (a
// small trial run); it keeps the first addresses in address order.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

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
 * carrying `skipVersion`, in this shard only.
 */
export function pickShard({ feed, rows, shard, shards, skipVersion = 0, limit = 0 }) {
  if (!Number.isInteger(shards) || shards < 1) throw new Error(`shards must be a whole number of 1 or more, got ${shards}`);
  if (!Number.isInteger(shard) || shard < 1 || shard > shards) throw new Error(`shard must be a whole number from 1 to ${shards}, got ${shard}`);
  const facts = new Map(rows.map((r) => [String(r.url), r.facts]));
  const urls = [...new Set(feed.map((p) => String(p.url)))].filter((u) => facts.has(u)).sort();
  const mine = urls.filter((u) => shardOf(u, shards) === shard - 1);
  const wanted = skipVersion > 0 ? mine.filter((u) => factsVersion(facts.get(u)) < skipVersion) : mine;
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

  const { urls, listed, inShard, skipped } = pickShard({ feed, rows, shard, shards, skipVersion, limit });
  fs.writeFileSync(out, urls.map((u) => `${u}\n`).join(""));
  console.log(
    `shard ${shard} of ${shards}: ${urls.length} site(s) to re-capture ` +
      `(${inShard} of the ${listed} listed, live and captured sites belong to it; ` +
      `${skipped} skipped for facts already at version ${skipVersion} or newer; limit ${limit || "none"})`
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
