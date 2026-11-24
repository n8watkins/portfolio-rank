// The recheck-543 verdicts on file in data/excluded.json (owner, 2026-11-13):
// the entries are well formed, every reader still matches them on the URL
// alone (generate_feed.py, discovery), none is left on data/feed.json, the
// feed sync's shrink guard isn't tripped, /removed has a label for every
// kind, and "dead" entries, part of the archive, are checked again monthly
// (pipeline/exclusions.mjs planDeadRecheck, pipeline/not-working.mjs archiveCheckDue).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listedKeys } from "../pipeline/discovery/run.mjs";
import { Known, PATH_SIGNIFICANT, PROJECT_PAGE_HOST } from "../pipeline/discovery/known.mjs";
import { normalizeCandidate } from "../pipeline/discovery/normalize.mjs";
import { ARCHIVE_EVERY_DAYS, planDeadRecheck, recheckDue } from "../pipeline/exclusions.mjs";
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

test("discovery treats every excluded site as already known, also found at its root or with a path added", () => {
  // The old version looked each entry up by its own key and could never fail. Here each real entry is
  // found under another spelling of the same site: its root when it has a path, a path when it is a root.
  const known = new Known(listedKeys(path.join(ROOT, "data")));
  const apart = (host) => PROJECT_PAGE_HOST.test(host) || PATH_SIGNIFICANT.some((h) => host === h || host.endsWith(`.${h}`));
  let checked = 0;
  for (const e of objects) {
    const n = normalizeCandidate(e.url);
    if (!n.ok) continue;
    assert.ok(known.has(n.key), e.url);
    if (apart(n.host)) continue;
    const variant = new URL(n.url).pathname === "/" ? `${n.host}/en` : n.host;
    assert.ok(known.has(variant), `${e.url} found as ${variant}`);
    checked++;
  }
  assert.ok(checked > 100, `${checked} entries probed`);
});

test("dead entries: due ones are checked; one that answers leaves, the others wait a month (the archive)", async () => {
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
  assert.equal(still.recheck_after, new Date(now.getTime() + ARCHIVE_EVERY_DAYS * 86400000).toISOString().slice(0, 10));
  assert.equal(still.last_checked, "2027-02-20");
  // Not due: untouched; at most `limit` a run.
  const one = await planDeadRecheck({ excluded: list, now, answers: async () => false, limit: 1 });
  assert.equal(one.still.length, 1);
});

test("the archive on file: every dead entry is checked within a month of its archiving, whatever its older recheck_after says", () => {
  for (const e of objects.filter((x) => x.kind === "dead")) {
    const due = recheckDue(e);
    assert.ok(due, `${e.url}: in the archive`);
    const base = String(e.last_checked ?? e.removed).slice(0, 10);
    const month = new Date(Date.parse(`${base}T00:00:00Z`) + 30 * 86400000).toISOString().slice(0, 10);
    assert.ok(due <= month, `${e.url}: due ${due}, within a month of ${base}`);
  }
  // Never brought back by a health check: not a portfolio, an owner's request, a duplicate.
  for (const e of objects.filter((x) => ["not_portfolio", "owner_request", "duplicate"].includes(x.kind))) assert.equal(recheckDue(e), null, e.url);
});
