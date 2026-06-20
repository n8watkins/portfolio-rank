// Upload the serve-frames (hero/mobile/full) for ONE capture key to R2.
// Used to verify the R2 pipeline end-to-end before the full backfill.
//   node scripts/r2-upload-one.mjs <shot_key>
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, existsSync } from "fs";
import path from "path";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const key = process.argv[2];
if (!key) {
  console.error("usage: node scripts/r2-upload-one.mjs <shot_key>");
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

const dir = path.join("captures", key);
for (const f of ["hero.jpg", "mobile.jpg", "full.jpg"]) {
  const fp = path.join(dir, f);
  if (!existsSync(fp)) {
    console.log(`skip ${f} (not found)`);
    continue;
  }
  const body = readFileSync(fp);
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `${key}/${f}`,
      Body: body,
      ContentType: "image/jpeg",
    })
  );
  console.log(`uploaded ${key}/${f} (${body.length} bytes)`);
}
process.exit(0);
