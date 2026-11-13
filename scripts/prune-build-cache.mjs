// Removes the ISR cache of old builds from the Worker's R2 cache bucket, after
// a deploy (.github/workflows/deploy.yml, staging.yml):
//   node scripts/prune-build-cache.mjs [--env staging] [--dry-run]
//
// Why: OpenNext keys every incremental-cache entry by the build that wrote it,
// `incremental-cache/<build id>/<sha256 of the key>.cache|.fetch`
// (@opennextjs/cloudflare computeCacheKey, with process.env.OPEN_NEXT_BUILD_ID,
// which is the Next build id, as next.config.ts sets no deploymentId). A Worker
// only ever reads its own build's folder, so every deploy leaves the previous
// folder behind for good: 88 builds and 383 MB in production, 113 builds and
// 970 MB in staging on 2026-11-12 (docs/COSTS.md "Staging").
//
// Why not an R2 lifecycle rule: the deploy uploads the live build's
// prerendered entries once, and only pages that revalidate write theirs again,
// so after N days without a deploy an age rule would expire the live build's
// own entries too.
//
// It keeps the build this deploy uploaded (the one folder under
// .open-next/cache, besides __fetch) and the newest other build, which the
// previous Worker version may still be serving while the new one rolls out,
// and deletes the rest. It deletes nothing when the uploaded build is not in
// the bucket, or when a key is not in OpenNext's layout.
import { readdirSync, readFileSync } from "node:fs";
import { parseJsonc } from "./check-worker-exports.mjs";

/** OpenNext's default prefix; wrangler.jsonc sets no NEXT_INC_CACHE_R2_PREFIX. */
export const PREFIX = "incremental-cache/";
const BINDING = "NEXT_INC_CACHE_R2_BUCKET";
const KEY = /^incremental-cache\/([A-Za-z0-9_-]+)\/[0-9a-f]{64}\.(cache|fetch|composable)$/;

/** The cache bucket and account of the production config or of one environment. */
export function cacheBucket(config, env) {
  const scope = env ? config.env?.[env] : config;
  if (!scope) throw new Error(`wrangler.jsonc has no environment "${env}"`);
  if (scope.vars?.NEXT_INC_CACHE_R2_PREFIX) throw new Error("NEXT_INC_CACHE_R2_PREFIX is set; this script only knows the default prefix");
  const bucket = (scope.r2_buckets ?? []).find((b) => b.binding === BINDING)?.bucket_name;
  if (!bucket) throw new Error(`no ${BINDING} bucket in ${env ? `env.${env}` : "the production config"}`);
  if (!config.account_id) throw new Error("wrangler.jsonc has no account_id");
  return { accountId: config.account_id, bucket };
}

/** The build id the deploy uploaded: the one folder under .open-next/cache besides __fetch. */
export function uploadedBuild(cacheDir = ".open-next/cache") {
  const ids = readdirSync(cacheDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "__fetch")
    .map((d) => d.name);
  if (ids.length !== 1) throw new Error(`expected one build folder in ${cacheDir}, found ${ids.length}`);
  return ids[0];
}

/**
 * Which builds stay and which keys go. `objects` are R2 listings
 * ({ key, size, last_modified }); the current build and the newest other
 * builds (by their newest object) stay, `keep` builds in all.
 */
export function planPrune(objects, current, keep = 2) {
  const builds = new Map();
  for (const o of objects) {
    const m = KEY.exec(o.key);
    if (!m) throw new Error(`unexpected key in the cache bucket: ${o.key}`);
    const b = builds.get(m[1]) ?? { id: m[1], keys: [], bytes: 0, newest: "" };
    b.keys.push(o.key);
    b.bytes += Number(o.size) || 0;
    if (o.last_modified > b.newest) b.newest = o.last_modified;
    builds.set(m[1], b);
  }
  if (!builds.has(current)) throw new Error(`the uploaded build ${current} is not in the bucket; deleting nothing`);
  const others = [...builds.values()].filter((b) => b.id !== current).sort((a, b) => (a.newest < b.newest ? 1 : -1));
  const kept = [builds.get(current), ...others.slice(0, Math.max(0, keep - 1))];
  const removed = others.slice(Math.max(0, keep - 1));
  return {
    kept: kept.map((b) => b.id),
    removed: removed.map((b) => b.id),
    keys: removed.flatMap((b) => b.keys),
    bytes: removed.reduce((s, b) => s + b.bytes, 0),
  };
}

async function api(token, method, path, { query, body } = {}) {
  const url = new URL(`https://api.cloudflare.com/client/v4${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) {
    const errors = (json?.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ");
    throw new Error(`${method} ${url.pathname}: HTTP ${res.status} ${errors}`);
  }
  return json;
}

async function listObjects(token, accountId, bucket) {
  const objects = [];
  let cursor;
  do {
    const page = await api(token, "GET", `/accounts/${accountId}/r2/buckets/${bucket}/objects`, {
      query: { prefix: PREFIX, per_page: 1000, cursor },
    });
    objects.push(...page.result);
    cursor = page.result_info?.is_truncated ? page.result_info.cursor : undefined;
  } while (cursor);
  return objects;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const env = args.includes("--env") ? args[args.indexOf("--env") + 1] : undefined;
  const dryRun = args.includes("--dry-run");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    console.error("CLOUDFLARE_API_TOKEN is not set");
    process.exit(1);
  }
  const { accountId, bucket } = cacheBucket(parseJsonc(readFileSync("wrangler.jsonc", "utf8")), env);
  const current = uploadedBuild();
  const plan = planPrune(await listObjects(token, accountId, bucket), current);
  const mb = (plan.bytes / 1e6).toFixed(1);
  console.log(`${bucket}: keeping ${plan.kept.join(", ")} (uploaded: ${current}); ${plan.removed.length} old builds, ${plan.keys.length} objects, ${mb} MB to remove`);
  if (!dryRun) {
    for (let i = 0; i < plan.keys.length; i += 1000) {
      await api(token, "DELETE", `/accounts/${accountId}/r2/buckets/${bucket}/objects`, { body: plan.keys.slice(i, i + 1000) });
    }
    if (plan.keys.length) console.log(`removed ${plan.keys.length} objects`);
  }
}
