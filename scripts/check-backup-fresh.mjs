#!/usr/bin/env node
// Fails when the newest backup in the private backup bucket is too old.
// The backup workflow cannot report its own absence: a run that never starts
// or is cancelled files nothing, and the staging refresh would take an old
// snapshot without a word. The daily limits workflow (.github/workflows/
// limits.yml) runs this, so a missing night shows up the same day.
//
//   R2_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY
//   BACKUP_MAX_AGE_HOURS   default 30: the backup runs at 05:00 UTC and this
//                          check at 13:30 UTC, so a normal newest backup is
//                          8.5 hours old and a missed night is 32.5
//   node scripts/check-backup-fresh.mjs
const BUCKET = process.env.R2_BACKUP_BUCKET || "portfolio-rank-backups";
export const DEFAULT_MAX_AGE_HOURS = 30;
const KEY = /^backups\/portfoliorank-\d{4}-\d{2}-\d{2}\.json\.gz$/;

/**
 * The newest backup object in a listing ({ Key, LastModified }) and its age.
 * `ok` is false when there is none or it is older than `maxHours`.
 */
export function backupFreshness(objects, now = new Date(), maxHours = DEFAULT_MAX_AGE_HOURS) {
  const backups = objects.filter((o) => KEY.test(String(o.Key))).sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));
  const newest = backups.at(-1);
  if (!newest) return { ok: false, key: null, ageHours: null, reason: "there is no backup in the bucket" };
  const ageHours = (now.getTime() - new Date(newest.LastModified).getTime()) / 3600000;
  if (!Number.isFinite(ageHours)) return { ok: false, key: newest.Key, ageHours: null, reason: `${newest.Key} has no usable date` };
  if (ageHours > maxHours) return { ok: false, key: newest.Key, ageHours, reason: `the newest backup, ${newest.Key}, is ${ageHours.toFixed(1)} hours old (limit ${maxHours})` };
  return { ok: true, key: newest.Key, ageHours, reason: null };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const accessKeyId = process.env.R2_BACKUP_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_BACKUP_SECRET_ACCESS_KEY;
  if (!process.env.R2_ACCOUNT_ID || !accessKeyId || !secretAccessKey) {
    console.error("::error title=Backup freshness::R2_ACCOUNT_ID and R2_BACKUP_* are required to check the backups");
    process.exit(1);
  }
  const maxHours = Number(process.env.BACKUP_MAX_AGE_HOURS) || DEFAULT_MAX_AGE_HOURS;
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: "auto", endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey } });
  const objects = [];
  let token;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "backups/", ContinuationToken: token }));
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const r = backupFreshness(objects, new Date(), maxHours);
  if (!r.ok) {
    console.error(`::error title=Backups have stopped::${r.reason}`);
    process.exit(1);
  }
  console.log(`newest backup ${r.key} is ${r.ageHours.toFixed(1)} hours old (limit ${maxHours})`);
}
