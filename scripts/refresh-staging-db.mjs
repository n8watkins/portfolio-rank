// Replaces the staging database with production's newest nightly backup
// (scripts/backup-db.mjs), so staging tests against current data
// (docs/audits/release-and-staging.md, DEPLOY.md "Staging").
// It never connects to production: it reads the backup from the private
// portfolio-rank-backups bucket, empties the staging database and restores the
// backup into it with scripts/lib/snapshot.mjs, then checks every table's row
// count.
//
//   STAGING_TURSO_DATABASE_URL, STAGING_TURSO_AUTH_TOKEN   the database it replaces
//   TURSO_DATABASE_URL     production's address, only to refuse it as the target
//   R2_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY
//   node scripts/refresh-staging-db.mjs [--file SNAPSHOT.json.gz] [--dry-run]
//
// The refusals come first and need no network: the target must be set, must
// not be production's address and must name a staging database.
import { createClient } from "@libsql/client";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { migrate } from "../lib/schema.mjs";
import { countsOf, restoreSnapshot, upgradeSnapshot } from "./lib/snapshot.mjs";

const BUCKET = "portfolio-rank-backups";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const dryRun = args.includes("--dry-run");

/** Why `url` must not be replaced, or null when it may. Exported for the tests. */
export function refusal(url, productionUrl) {
  if (!url) return "STAGING_TURSO_DATABASE_URL is not set";
  if (!productionUrl) return "TURSO_DATABASE_URL (production's address, the guard) is not set";
  const host = (u) => {
    try {
      return (new URL(u).host || String(u)).toLowerCase();
    } catch {
      return String(u).toLowerCase();
    }
  };
  if (host(url) === host(productionUrl)) return "the target is the production database";
  if (!/staging/.test(host(url))) return `the target ${host(url)} does not name a staging database`;
  return null;
}

/** The newest backups/portfoliorank-YYYY-MM-DD.json.gz key in a listing. */
export function newestBackup(keys) {
  return keys.filter((k) => /^backups\/portfoliorank-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(k)).sort().at(-1) ?? null;
}

async function downloadNewest() {
  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY;
  if (!process.env.R2_ACCOUNT_ID || !accessKeyId || !secretAccessKey) throw new Error("R2_ACCOUNT_ID and R2_BACKUP_* are required (or pass --file)");
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
  const keys = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "backups/", ContinuationToken: token }));
    for (const o of page.Contents ?? []) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const key = newestBackup(keys);
  if (!key) throw new Error(`no backup in ${BUCKET}/backups/`);
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { key, bytes: Buffer.from(await obj.Body.transformToByteArray()) };
}

const internal = (name) => name.startsWith("sqlite_") || name.startsWith("libsql_") || name.startsWith("_litestream");

/** Drops every table, view and trigger, leaving an empty database. */
async function empty(db) {
  const rows = (await db.execute("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')")).rows;
  const drops = [];
  for (const r of rows) if (r.type === "trigger" && !internal(String(r.name))) drops.push(`DROP TRIGGER IF EXISTS "${r.name}"`);
  for (const r of rows) if (r.type === "view" && !internal(String(r.name))) drops.push(`DROP VIEW IF EXISTS "${r.name}"`);
  for (const r of rows) if (r.type === "table" && !internal(String(r.name))) drops.push(`DROP TABLE IF EXISTS "${r.name}"`);
  // Outside the batch: SQLite ignores this pragma inside a transaction.
  await db.execute("PRAGMA foreign_keys = OFF");
  if (drops.length) await db.batch(drops, "write");
  return drops.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.STAGING_TURSO_DATABASE_URL;
  const why = refusal(url, process.env.TURSO_DATABASE_URL);
  if (why) {
    console.error(`refusing to refresh: ${why}`);
    process.exit(1);
  }
  const file = flag("file");
  const { key, bytes } = file ? { key: file, bytes: readFileSync(file) } : await downloadNewest();
  const snap = upgradeSnapshot(JSON.parse((key.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8")));
  console.log(`backup ${key}: the snapshot of ${snap.exported_at}`);
  if (dryRun) {
    for (const [table, n] of Object.entries(countsOf(snap))) console.log(`${table}: ${n}`);
    console.log("dry run: staging not changed");
    process.exit(0);
  }
  const db = createClient({ url, authToken: process.env.STAGING_TURSO_AUTH_TOKEN });
  console.log(`emptied staging: ${await empty(db)} objects dropped`);
  const written = await restoreSnapshot(db, snap, { migrate });
  let ok = true;
  for (const [table, expected] of Object.entries(countsOf(snap))) {
    const n = Number((await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
    if (n !== expected || written[table] !== expected) {
      ok = false;
      console.error(`MISMATCH ${table}: ${n} of ${expected}`);
    } else console.log(`${table}: ${n} of ${expected}`);
  }
  console.log(ok ? `staging now holds the snapshot of ${snap.exported_at}` : "the restore does not match the snapshot");
  process.exit(ok ? 0 : 1);
}
