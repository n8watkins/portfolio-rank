// The post-deploy cleanup of old builds' ISR cache (scripts/prune-build-cache.mjs).
// No network: the plan is computed from stand-in R2 listings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { cacheBucket, planPrune, uploadedBuild } from "../scripts/prune-build-cache.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
const obj = (build, n, day, ext = "cache", size = 100) => ({
  key: `incremental-cache/${build}/${hash(n)}.${ext}`,
  size: String(size),
  last_modified: `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`,
});

test("keeps the uploaded build and the newest other one, removes the rest", () => {
  const objects = [
    obj("old-A", 1, 3),
    obj("old-A", 2, 3, "fetch"),
    obj("prev-B", 3, 10),
    obj("live-C", 4, 11),
    obj("older-D", 5, 5, "cache", 250),
  ];
  const plan = planPrune(objects, "live-C");
  assert.deepEqual(plan.kept, ["live-C", "prev-B"]);
  assert.deepEqual(plan.removed.sort(), ["old-A", "older-D"]);
  assert.equal(plan.keys.length, 3);
  assert.equal(plan.bytes, 450);
  assert.ok(plan.keys.every((k) => !k.includes("live-C") && !k.includes("prev-B")));
});

test("ranks the other builds by their newest object, so an old build an ISR page still rewrites stays", () => {
  const objects = [obj("live", 1, 12), obj("first", 2, 1), obj("first", 3, 11), obj("second", 4, 6)];
  assert.deepEqual(planPrune(objects, "live").kept, ["live", "first"]);
});

test("keeps the uploaded build even when an older build has newer writes", () => {
  const objects = [obj("uploaded", 1, 4), obj("busy", 2, 12), obj("other", 3, 8)];
  const plan = planPrune(objects, "uploaded");
  assert.deepEqual(plan.kept, ["uploaded", "busy"]);
  assert.deepEqual(plan.removed, ["other"]);
});

test("deletes nothing when the uploaded build is not in the bucket", () => {
  assert.throws(() => planPrune([obj("a", 1, 1), obj("b", 2, 2)], "missing"), /not in the bucket/);
});

test("deletes nothing when a key is not in OpenNext's layout", () => {
  const stray = { key: "incremental-cache/notes.txt", size: "1", last_modified: "2026-11-01T00:00:00.000Z" };
  assert.throws(() => planPrune([obj("live", 1, 1), stray], "live"), /unexpected key/);
});

test("with one or two builds there is nothing to remove", () => {
  assert.deepEqual(planPrune([obj("live", 1, 1)], "live").keys, []);
  assert.deepEqual(planPrune([obj("live", 1, 2), obj("prev", 2, 1)], "live").keys, []);
});

test("finds each environment's cache bucket in wrangler.jsonc", () => {
  const config = parseJsonc(fs.readFileSync("wrangler.jsonc", "utf8"));
  assert.equal(cacheBucket(config).bucket, "portfolio-rank-opennext-cache");
  assert.equal(cacheBucket(config, "staging").bucket, "portfolio-rank-staging-opennext-cache");
  assert.match(cacheBucket(config).accountId, /^[0-9a-f]{32}$/);
  assert.throws(() => cacheBucket(config, "nope"), /no environment/);
});

test("reads the uploaded build id from the OpenNext cache folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-cache-"));
  fs.mkdirSync(path.join(dir, "__fetch", "abc"), { recursive: true });
  fs.mkdirSync(path.join(dir, "abc"));
  assert.equal(uploadedBuild(dir), "abc");
  fs.mkdirSync(path.join(dir, "def"));
  assert.throws(() => uploadedBuild(dir), /expected one build folder/);
  fs.rmSync(dir, { recursive: true });
});
