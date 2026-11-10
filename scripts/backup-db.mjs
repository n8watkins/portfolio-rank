// The nightly backup (.github/workflows/backup.yml): a gzipped JSON snapshot
// of the whole database (scripts/lib/snapshot.mjs says what is in it and
// what is left out) to the private R2 bucket. Turso Free keeps only one day
// of point-in-time restore, so this snapshot is the real backup; the restore
// is scripts/restore-db.mjs and docs/ASSUMPTIONS.md section G.
//   node scripts/backup-db.mjs                 upload (R2_* set) to the bucket
//   node scripts/backup-db.mjs --out FILE      write the snapshot to FILE instead
// Credentials come from the environment (Actions secrets, or `pass-env run`
// locally), never from a file.
import { createClient } from "@libsql/client";
import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { countsOf, takeSnapshot } from "./lib/snapshot.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

if (!process.env.TURSO_DATABASE_URL) {
  console.error("TURSO_DATABASE_URL is required");
  process.exit(1);
}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const now = new Date();
const snap = await takeSnapshot(db, { now });
const json = JSON.stringify(snap);
const gz = gzipSync(json, { level: 9 });
console.log(
  Object.entries(countsOf(snap))
    .map(([t, n]) => `${t}:${n}`)
    .join("  ")
);
console.log(`raw JSON: ${(json.length / 1024 / 1024).toFixed(2)} MB  |  gzipped: ${(gz.length / 1024 / 1024).toFixed(2)} MB`);

// Backups go to their own private bucket (no r2.dev access), never to the
// public screenshot bucket at SHOTS_BASE_URL: a snapshot holds every vote with
// its rater id. The R2 token in R2_BACKUP_* should be scoped to that bucket only.
const BACKUP_BUCKET = process.env.R2_BACKUP_BUCKET || "portfolio-rank-backups";
const PUBLIC_BUCKET = "portfolio-rank";
const out = arg("--out") ?? (process.argv.includes("--measure-only") ? "/tmp/backup-sample.json.gz" : null);

if (out) {
  writeFileSync(out, gz);
  console.log(`wrote ${out}`);
} else if (process.env.R2_ACCOUNT_ID) {
  if (BACKUP_BUCKET === PUBLIC_BUCKET) {
    console.error(`refusing to write a backup to the public bucket "${PUBLIC_BUCKET}"`);
    process.exit(1);
  }
  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    console.error("R2_BACKUP_ACCESS_KEY_ID and R2_BACKUP_SECRET_ACCESS_KEY are required");
    process.exit(1);
  }
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  const key = `backups/portfoliorank-${now.toISOString().slice(0, 10)}.json.gz`;
  await s3.send(new PutObjectCommand({ Bucket: BACKUP_BUCKET, Key: key, Body: gz, ContentType: "application/gzip" }));
  console.log(`uploaded to R2: ${BACKUP_BUCKET}/${key}`);
} else {
  console.error("nowhere to write: set R2_ACCOUNT_ID (and R2_BACKUP_*) or pass --out FILE");
  process.exit(1);
}
process.exit(0);
