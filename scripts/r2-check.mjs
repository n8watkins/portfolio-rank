// Quick R2 credential/connectivity check: lists up to 3 objects in the bucket.
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { readFileSync } from "fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

try {
  const out = await s3.send(
    new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, MaxKeys: 3 })
  );
  console.log(`OK — connected to bucket "${process.env.R2_BUCKET}".`);
  console.log(`Objects currently in bucket: ${out.KeyCount ?? 0}`);
} catch (e) {
  console.log(`FAILED: ${e.name} — ${e.message}`);
  process.exit(1);
}
process.exit(0);
