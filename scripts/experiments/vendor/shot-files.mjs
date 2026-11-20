// Vendored for the mini tests from feat/fullpage-shots at e36fce7 (pipeline/shot-files.mjs), unchanged.
// The files a roster capture stores in R2 under <shot_key>/, in one place:
// pipeline/capture.mjs uploads them, pipeline/fullpage-backfill.mjs uploads
// the full-page pair, pipeline/purge-delisted.mjs deletes them all, and the
// Worker serves them (worker/shots.ts SHOT_FILES lists the same names).
//
//   hero.jpg           1440 x 900, JPEG 75: the top of the page (the AI grade's image)
//   mobile.jpg          390 x 844, JPEG 75
//   full-desktop.webp  the whole page at 1440 wide, WebP 75, at most 6,000 px tall
//   full-phone.webp    the whole page at 390 wide, WebP 75, at most 8,000 px tall
//
// The old full.jpg is not stored any more; the purge still deletes it for
// rows captured before it stopped.

export const FULL_DESKTOP = "full-desktop.webp";
export const FULL_PHONE = "full-phone.webp";

/** What the capture uploads. */
export const SERVE_FILES = new Set(["hero.jpg", "mobile.jpg", FULL_DESKTOP, FULL_PHONE]);

/** What the purge of a delisted site deletes. */
export const PURGE_FILES = [...SERVE_FILES, "full.jpg"];

/** The Content-Type a stored file is uploaded with. */
export function contentTypeOf(file) {
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".jpg")) return "image/jpeg";
  return "image/png";
}
