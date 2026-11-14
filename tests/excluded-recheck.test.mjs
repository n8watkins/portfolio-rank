// The recheck-543 verdicts on file in data/excluded.json (owner, 2026-11-13):
// the entries are well formed, every reader still matches them on the URL
// alone (generate_feed.py, discovery), none is left on data/feed.json, the
// feed sync's shrink guard isn't tripped, /removed has a label for every
// kind, and "dead" entries are checked again every few months
// (pipeline/exclusions.mjs planDeadRecheck).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listedKeys } from "../pipeline/discovery/run.mjs";
import { normalizeCandidate } from "../pipeline/discovery/normalize.mjs";
import { DEAD_RECHECK_DAYS, planDeadRecheck } from "../pipeline/exclusions.mjs";
import { normKey } from "../pipeline/health.mjs";
import { EXCLUSION_KINDS, REMOVED_KINDS } from "../lib/removed-kinds.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const excluded = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "excluded.json"), "utf8"));
const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
const objects = excluded.filter((e) => typeof e === "object" && e);

test("every entry is well formed; one entry per site", () => {
  for (const e of objects) {
    assert.ok(typeof e.url === "string" && /^https?:\/\//.test(e.url), e.url);
    assert.ok(EXCLUSION_KINDS.includes(e.kind), `${e.url}: kind ${e.kind}`);
    assert.ok(e.reason, `${e.url}: reason`);
    assert.match(String(e.removed), /^\d{4}-\d{2}-\d{2}$/, `${e.url}: removed`);
    if (e.kind === "duplicate") assert.ok(/^https?:\/\//.test(String(e.duplicate_of)), `${e.url}: duplicate_of`);
    if (e.kind === "dead") assert.match(String(e.recheck_after), /^\d{4}-\d{2}-\d{2}$/, `${e.url}: recheck_after`);
  }
  const keys = objects.map((e) => normKey(e.url));
  assert.equal(new Set(keys).size, keys.length, "no site twice");
  // A duplicate never points at an excluded address: the kept site stays.
  const set = new Set(keys);
  for (const e of objects.filter((x) => x.kind === "duplicate")) assert.ok(!set.has(normKey(e.duplicate_of)), `${e.url}: its kept address is excluded`);
});

test("nothing excluded is left on the feed, so the next sync doesn't shrink it", () => {
  const set = new Set(objects.map((e) => normKey(e.url)));
  assert.deepEqual(feed.filter((p) => set.has(normKey(p.url))).map((p) => p.url), []);
});

test("/removed has a label for every kind it lists (owner requests are counted, never named)", () => {
  for (const k of new Set(objects.map((e) => e.kind))) if (k !== "owner_request") assert.ok(REMOVED_KINDS[k], `no label for ${k}`);
});

test("generate_feed.py drops an excluded site whatever the spelling, with the new fields present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-"));
  const dup = objects.find((e) => e.kind === "duplicate");
  const dead = objects.find((e) => e.kind === "dead");
  const np = objects.find((e) => e.kind === "not_portfolio");
  const variant = (u) => {
    const x = new URL(u);
    return `${x.protocol}//www.${x.hostname.replace(/^www\./, "")}${x.pathname}/`;
  };
  const readme = [
    `- [Kept](https://example-kept.dev) [Developer]`,
    `- [Dup](${variant(dup.url)}) [Developer]`,
    `- [Dead](${variant(dead.url)}) [Developer]`,
    `- [Np](${np.url}) [Developer]`,
  ].join("\n");
  fs.writeFileSync(path.join(dir, "README.md"), `${readme}\n`);
  execFileSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), path.join(dir, "README.md"), path.join(dir, "feed.json"), "--exclude", path.join(ROOT, "data", "excluded.json")], { stdio: "pipe" });
  const out = JSON.parse(fs.readFileSync(path.join(dir, "feed.json"), "utf8"));
  assert.deepEqual(out.map((p) => p.url), ["https://example-kept.dev"]);
});

test("discovery treats every excluded site as already known, so it never comes back as new", () => {
  const keys = listedKeys(path.join(ROOT, "data"));
  for (const e of objects) {
    const n = normalizeCandidate(e.url);
    if (n.ok) assert.ok(keys.has(n.key), e.url);
  }
});

test("dead entries: due ones are checked; one that answers leaves, the others wait three months", async () => {
  const now = new Date("2027-02-20T00:00:00Z");
  const list = [
    { url: "https://back.dev", kind: "dead", recheck_after: "2027-02-13" },
    { url: "https://still.dev", kind: "dead", recheck_after: "2027-02-13" },
    { url: "https://later.dev", kind: "dead", recheck_after: "2027-05-01" },
    { url: "https://np.dev", kind: "not_portfolio" },
  ];
  const r = await planDeadRecheck({ excluded: list, now, answers: async (u) => u === "https://back.dev" });
  assert.deepEqual(r.back, ["https://back.dev"]);
  assert.deepEqual(r.still, ["https://still.dev"]);
  assert.deepEqual(r.excluded.map((e) => e.url), ["https://still.dev", "https://later.dev", "https://np.dev"]);
  const still = r.excluded.find((e) => e.url === "https://still.dev");
  assert.equal(still.recheck_after, new Date(now.getTime() + DEAD_RECHECK_DAYS * 86400000).toISOString().slice(0, 10));
  assert.equal(still.last_checked, "2027-02-20");
  // Not due: untouched; at most `limit` a run.
  const one = await planDeadRecheck({ excluded: list, now, answers: async () => false, limit: 1 });
  assert.equal(one.still.length, 1);
});
