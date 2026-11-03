// Back up the irreplaceable Turso data (human votes, ELO ratings, and the
// expensive Gemini ai_rubric grades) to R2 as a gzipped JSON snapshot.
// shot_key is included so a restore re-links to existing R2 screenshots.
// meta (capture diagnostics) is intentionally omitted — it's regenerable and bulky.
import { createClient } from "@libsql/client";
import { gzipSync } from "zlib";
import { existsSync, readFileSync, writeFileSync } from "fs";

// Optional in CI (GitHub Actions): no .env.local — vars come from runner secrets.
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const rows = async (sql) => (await db.execute(sql)).rows;

const now = new Date();
const data = {
  exported_at: now.toISOString(),
  votes: await rows("SELECT * FROM votes"),
  ratings: await rows("SELECT * FROM ratings"),
  portfolios: await rows(
    "SELECT url, name, status, reason, shot_key, ai_rubric, checked_at, captured_at FROM portfolios"
  ),
};

const json = JSON.stringify(data);
const gz = gzipSync(json, { level: 9 });
console.log(
  `votes:${data.votes.length}  ratings:${data.ratings.length}  portfolios:${data.portfolios.length}`
);
console.log(
  `raw JSON: ${(json.length / 1024 / 1024).toFixed(2)} MB  |  gzipped: ${(gz.length / 1024 / 1024).toFixed(2)} MB`
);

// Backups go to their own private bucket (no r2.dev access), never to the
// public screenshot bucket at SHOTS_BASE_URL: a snapshot holds every vote with
// its rater id. The R2 token in R2_BACKUP_* should be scoped to that bucket only.
const BACKUP_BUCKET = process.env.R2_BACKUP_BUCKET || "portfolio-rank-backups";
const PUBLIC_BUCKET = "portfolio-rank";

if (process.env.R2_ACCOUNT_ID && !process.argv.includes("--measure-only")) {
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
  await s3.send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: gz,
      ContentType: "application/gzip",
    })
  );
  console.log(`uploaded to R2: ${BACKUP_BUCKET}/${key}`);
} else {
  writeFileSync("/tmp/backup-sample.json.gz", gz);
  console.log("measure-only: wrote /tmp/backup-sample.json.gz");
}
process.exit(0);
