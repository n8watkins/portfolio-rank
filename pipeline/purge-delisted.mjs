#!/usr/bin/env node
// Delete the screenshots (R2) and the row of every portfolio delisted for 30+
// days (pipeline/roster.mjs purgeDelisted). Votes and ratings are kept, so
// the vote log stays complete and rankings stay recomputable. Run by the
// weekly health workflow after the health check.
//
// Usage: node pipeline/purge-delisted.mjs [--dry-run]
import fs from "fs";
import path from "path";
import { S3Client, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { pipelineDb, purgeDelisted } from "./roster.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const DRY = process.argv.includes("--dry-run");

if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
  console.error("::error::R2_* credentials are needed to delete screenshots");
  process.exit(1);
}
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
// The frames capture.mjs uploads (pipeline/capture.mjs SERVE_FILES).
const deleteShots = async (key) => {
  const out = await s3.send(
    new DeleteObjectsCommand({
      Bucket: process.env.R2_BUCKET ?? "portfolio-rank",
      Delete: { Objects: ["hero.jpg", "mobile.jpg", "full.jpg"].map((f) => ({ Key: `${key}/${f}` })) },
    })
  );
  if (out.Errors?.length) throw new Error(`R2: ${out.Errors[0].Code} ${out.Errors[0].Message}`);
};

const result = await purgeDelisted(pipelineDb(ROOT), { deleteShots, dryRun: DRY });
const md = `### Purge\n\n${result.due} row(s) delisted for 30+ days: ${result.purged} purged, ${result.failed} failed${DRY ? " (dry run)" : ""}.\n`;
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
process.exit(result.failed ? 1 : 0);
