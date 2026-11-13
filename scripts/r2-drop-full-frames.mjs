#!/usr/bin/env node
// Lists, and with --apply deletes, the full-page screenshots (<shot_key>/full.jpg)
// left in the screenshots bucket. Captures stopped storing them
// (pipeline/capture.mjs SERVE_FILES): nothing ever showed one, and they were
// about 70% of the bucket (docs/audits/free-tier-limits.md).
//
//   node scripts/r2-drop-full-frames.mjs            dry run: count and size only
//   node scripts/r2-drop-full-frames.mjs --apply    delete them (owner's OK first)
//
// Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET
// (the capture's credentials). Deletes are free R2 operations; listing is
// one Class A operation per 1,000 objects. Only keys that end in /full.jpg
// are ever deleted.
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const apply = process.argv.includes("--apply");
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
  if (!process.env[name]) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
}
const bucket = process.env.R2_BUCKET;
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

/**
 * Only a capture's old full-page frame: 16 hex characters, then /full.jpg.
 * The current full-page frames (full-desktop.webp, full-phone.webp,
 * pipeline/shot-files.mjs) never match.
 */
const isFullFrame = (key) => /^[0-9a-f]{16}\/full\.jpg$/.test(key);

const found = [];
let bytes = 0;
let token;
do {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token, MaxKeys: 1000 }));
  for (const o of page.Contents ?? []) {
    if (!o.Key || !isFullFrame(o.Key)) continue;
    found.push(o.Key);
    bytes += o.Size ?? 0;
  }
  token = page.IsTruncated ? page.NextContinuationToken : undefined;
} while (token);

const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`${found.length} full-page frame(s), ${mb(bytes)} in ${bucket}`);
if (!apply) {
  console.log("dry run: nothing deleted (add --apply to delete them)");
  process.exit(0);
}
let deleted = 0;
for (let i = 0; i < found.length; i += 1000) {
  const part = found.slice(i, i + 1000);
  const out = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: part.map((Key) => ({ Key })), Quiet: true } }));
  if (out.Errors?.length) throw new Error(`delete failed for ${out.Errors.length} key(s), first ${out.Errors[0].Key}: ${out.Errors[0].Message}`);
  deleted += part.length;
  console.log(`deleted ${deleted} of ${found.length}`);
}
console.log(`done: ${deleted} full-page frame(s) deleted, ${mb(bytes)} freed`);
