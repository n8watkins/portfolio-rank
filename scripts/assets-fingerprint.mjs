// Writes .open-next/assets-fingerprint.json after `opennextjs-cloudflare build`: a hash
// of the names of the build's static files (/_next/static, which Next.js names by
// content), leaving out the build id's own folder. worker/edge-cache.ts puts it in every
// edge cache key, so a deploy that changes no CSS or JavaScript keeps the cached pages
// (wrangler.jsonc cache.cross_version_cache) and one that does starts fresh.
//
//   node scripts/assets-fingerprint.mjs   (run by the build:worker, preview and deploy scripts)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const STATIC = join(ROOT, ".open-next", "assets", "_next", "static");
const OUT = join(ROOT, ".open-next", "assets-fingerprint.json");

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

if (!existsSync(STATIC)) {
  console.error(`assets-fingerprint: ${relative(ROOT, STATIC)} is missing; run the OpenNext build first.`);
  process.exit(1);
}
const buildIdFile = join(ROOT, ".next", "BUILD_ID");
const buildId = existsSync(buildIdFile) ? readFileSync(buildIdFile, "utf8").trim() : "";
const names = files(STATIC)
  .map((p) => relative(STATIC, p).split("\\").join("/"))
  // The build id's folder (its manifests) changes on every build; the app router's pages don't load it.
  .filter((n) => !buildId || !n.startsWith(`${buildId}/`))
  .sort();
const fingerprint = createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 12);
writeFileSync(OUT, JSON.stringify({ fingerprint, files: names.length }) + "\n");
console.log(`assets-fingerprint: ${fingerprint} (${names.length} files)`);
