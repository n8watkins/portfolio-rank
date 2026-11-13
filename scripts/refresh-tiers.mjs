#!/usr/bin/env node
// Tiers by ELO (lib/tiers.mjs), by hand and at deploy. No AI request.
//
//   node scripts/refresh-tiers.mjs              the full rebuild (lib/tiers-store.mjs refreshTiers): points from
//                                               automated checks, starting ranks, every face-off replayed, the cutoffs,
//                                               every grade's rank where it changed. The deploy workflow runs it for staging.
//   node scripts/refresh-tiers.mjs --daily      the daily run (lib/tiers-db.mjs dailyTiers): the cutoffs, and only
//                                               the letters that changed. The Worker does this once a day.
//   node scripts/refresh-tiers.mjs --read-only  the library size and tier counts from the last run, nothing written
//
// Database: Turso when TURSO_DATABASE_URL is set, else the local file.
import path from "node:path";
import { createClient } from "@libsql/client";
import { TIERS, tierCounts } from "../lib/tiers.mjs";
import { dailyTiers, readTierMeta } from "../lib/tiers-db.mjs";
import { refreshTiers } from "../lib/tiers-store.mjs";

const url = process.env.TURSO_DATABASE_URL;
const db = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });

const share = (counts, n) => TIERS.map((t) => `${t} ${counts[t]} (${n ? ((100 * counts[t]) / n).toFixed(1) : 0}%)`).join(", ");

if (process.argv.includes("--read-only")) {
  const meta = await readTierMeta(db);
  const n = meta?.n ?? 0;
  console.log(`tiers (read-only): ${n} ranked as of ${meta?.at ?? "never"}; ${share(tierCounts(n), n)}`);
} else if (process.argv.includes("--daily")) {
  const r = await dailyTiers(db);
  console.log(`tiers daily: ${r.n} ranked, ${r.candidates} looked at, ${r.changed} letter(s) changed, ${r.voted} with new votes, ${r.written} row(s) written`);
} else {
  const r = await refreshTiers(db);
  console.log(`tiers: library ${r.library}, ${r.ranked} ranked, ${r.rows} rating row(s) written, ${r.updated} rank(s) written, ${r.cleared} cleared, ${r.jobs} report(s) placed; ${share(r.distribution, r.library)}`);
}
