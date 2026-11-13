// The old, unversioned frames a roster capture stores in R2 under
// <shot_key>/: pipeline/capture.mjs cuts them from the tall images and
// uploads them while LEGACY_FRAMES is on (pipeline/shot-store.mjs), and
// the Worker serves them (worker/shots.ts).
//
//   hero.jpg     1440 x 900, JPEG 75: the top of the page (the AI grade's image)
//   mobile.jpg    390 x 844, JPEG 75
//
// The tall images and thumbnails are versioned, under <shot_key>/<v>/
// (pipeline/fullpage.mjs IMAGE_FILES). The purge of a delisted site deletes
// everything under <shot_key>/ (pipeline/shot-store.mjs deleteAllShots).

export const SERVE_FILES = new Set(["hero.jpg", "mobile.jpg"]);

/** The Content-Type a stored file is uploaded with. */
export function contentTypeOf(file) {
  if (file.endsWith(".avif")) return "image/avif";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".jpg")) return "image/jpeg";
  return "image/png";
}
