// Where a capture's images go in R2, and the writes that keep it lean
// (docs/audits/fullpage-images.md):
//
//   images bucket (R2_IMAGES_BUCKET, "portfolio-rank-images"), public on
//   its own domain (IMAGES_BASE_URL, images.portfoliorank.dev):
//     <shot_key>/<v>/desktop.avif ... (pipeline/fullpage.mjs IMAGE_FILES)
//       versioned and immutable: uploaded with a year-long Cache-Control,
//       served straight from R2 with no Worker in between. A new version
//       is uploaded first, then the old one is deleted. Nothing else lives
//       in this bucket, so making it public exposes nothing private (the
//       SHOTS bucket also holds private grade reports and draft media).
//       Until the bucket exists (R2_IMAGES_BUCKET unset) nothing is stored
//       and no version is recorded; the backfill fills in afterwards.
//   SHOTS bucket (R2_BUCKET, "portfolio-rank"):
//     <shot_key>/hero.jpg, <shot_key>/mobile.jpg
//       the old frames, now cut from the tall images (one visit, no extra
//       screenshot). Still uploaded while LEGACY_FRAMES is on, because the
//       end-of-day grade on Cloudflare (worker/night.ts), the ranking
//       comparisons and the site's cards, games, polls and blog read them,
//       and Gemini reads no AVIF. Turning it off is the step after those
//       move to the new images (docs/audits/fullpage-images.md).
//
// A capture that looks like the stored one (fullPage.mjs unchanged) uploads
// nothing at all.
import { ALL_IMAGE_FILES } from "./fullpage.mjs";

export const IMMUTABLE = "public, max-age=31536000, immutable";

/** Whether the capture still uploads hero.jpg and mobile.jpg (CAPTURE_LEGACY_FRAMES, on unless "false"). */
export const legacyFramesOn = (env = process.env) => !/^false$/i.test(String(env.CAPTURE_LEGACY_FRAMES ?? "true"));

/** The public images bucket, or null until it exists (R2_IMAGES_BUCKET). */
export const imagesBucket = (env = process.env) => (String(env.R2_IMAGES_BUCKET ?? "").trim() || null);

/**
 * A new version that could not be stored (no images bucket): the sizes and
 * signatures are kept, the version is not, so the row stays due for the
 * backfill and is never served.
 */
export function notStored(fullPage) {
  const rest = { ...fullPage };
  delete rest.v;
  return { ...rest, notStored: true };
}

/** The R2 key of one image of a version. */
export const imageKey = (shotKey, v, file) => `${shotKey}/${v}/${file}`;

const SHOT_KEY = /^[0-9a-f]{16}$/;

/**
 * Uploads one version's four AVIF files, then deletes the previous
 * version's (when there was one and it differs). `send` is an S3 client's
 * send; `commands` holds PutObjectCommand and DeleteObjectsCommand (passed
 * in, so tests need no SDK). Returns the number of writes.
 */
export async function storeVersion({ send, commands, bucket, shotKey, v, files, prevV }) {
  if (!SHOT_KEY.test(shotKey)) throw new Error(`not a shot key: ${shotKey}`);
  let writes = 0;
  for (const [file, body] of Object.entries(files)) {
    await send(new commands.PutObjectCommand({ Bucket: bucket, Key: imageKey(shotKey, v, file), Body: body, ContentType: "image/avif", CacheControl: IMMUTABLE }));
    writes++;
  }
  if (prevV && prevV !== v) {
    const out = await send(
      new commands.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: ALL_IMAGE_FILES.map((f) => ({ Key: imageKey(shotKey, prevV, f) })), Quiet: true } })
    );
    if (out?.Errors?.length) throw new Error(`R2 delete: ${out.Errors[0].Code} ${out.Errors[0].Message}`);
  }
  return writes;
}

/**
 * Deletes everything stored under a capture's shot key in one bucket (every
 * version, the old frames, the old full.jpg): one listing, then batched
 * deletes. Used by the purge of delisted sites, once per bucket. Never
 * touches another prefix.
 */
export async function deleteAllShots({ send, commands, bucket, shotKey }) {
  if (!SHOT_KEY.test(shotKey)) throw new Error(`not a shot key: ${shotKey}`);
  const keys = [];
  let token;
  do {
    const page = await send(new commands.ListObjectsV2Command({ Bucket: bucket, Prefix: `${shotKey}/`, ContinuationToken: token }));
    for (const o of page.Contents ?? []) if (o.Key?.startsWith(`${shotKey}/`)) keys.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  for (let i = 0; i < keys.length; i += 1000) {
    const out = await send(new commands.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
    if (out?.Errors?.length) throw new Error(`R2: ${out.Errors[0].Code} ${out.Errors[0].Message}`);
  }
  return keys.length;
}
