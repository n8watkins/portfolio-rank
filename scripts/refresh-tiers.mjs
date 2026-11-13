#!/usr/bin/env node
// Places every graded portfolio's tier by ELO again (lib/tiers.mjs) from the
// face-offs, and prints the library's tier distribution. No AI request.
// The Worker does this hourly (worker/tiers.ts); the deploy workflow runs it
// after the migration, so a deploy never shows grades without a tier.
//
//   node scripts/refresh-tiers.mjs              database (Turso when TURSO_DATABASE_URL is set, else the local file)
//   node scripts/refresh-tiers.mjs --read-only  the distribution only, nothing written
import path from "node:path";
import { createClient } from "@libsql/client";
import { TIERS, distribution, rankedCount } from "../lib/tiers.mjs";
import { libraryOrder, loadGrades, refreshTiers } from "../lib/tiers-store.mjs";

const url = process.env.TURSO_DATABASE_URL;
const db = url
  ? createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN })
  : createClient({ url: `file:${process.env.LOCAL_DB_FILE ?? path.join(process.cwd(), "data", "portfoliorank.db")}` });

const share = (dist, n) => TIERS.map((t) => `${t} ${dist[t]} (${n ? ((100 * dist[t]) / n).toFixed(1) : 0}%)`).join(", ");

if (process.argv.includes("--read-only")) {
  const order = libraryOrder(await loadGrades(db));
  console.log(`tiers (read-only): library ${order.length}, ${rankedCount(order)} ranked (a starting rank or 10 face-offs); ${share(distribution(order), order.length)}`);
} else {
  const r = await refreshTiers(db);
  console.log(`tiers: library ${r.library}, ${r.ranked} ranked (a starting rank or 10 face-offs), ${r.updated} rank(s) written, ${r.cleared} cleared, ${r.jobs} report(s) placed; ${share(r.distribution, r.library)}`);
}
