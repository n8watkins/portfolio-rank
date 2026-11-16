// scripts/check-data.mjs: the gate before production is rebuilt with new data
// under released code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_FEED, checkData, checkDataDir } from "../scripts/check-data.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const feedOf = (n) =>
  Array.from({ length: n }, (_, i) => ({ name: `Person ${i}`, url: `https://site-${i}.example` }));
const good = () => ({
  feed: feedOf(MIN_FEED),
  additions: [{ name: "A", url: "http://a.example", source: "review" }],
  excluded: [{ url: "https://gone.example", name: "Gone", kind: "dead", reason: "No answer", removed: "2026-11-13" }],
});

test("the repository's own data passes", () => {
  assert.deepEqual(checkDataDir(path.join(ROOT, "data")), []);
});

test("good data passes, and fields this code does not know are fine", () => {
  const d = good();
  d.feed[0].future_field = { anything: true };
  d.excluded[0].recheck_after = "2027-02-13";
  assert.deepEqual(checkData(d), []);
});

test("a feed entry without a name or a web address is a problem", () => {
  const d = good();
  d.feed[3] = { name: "", url: "https://x.example" };
  d.feed[4] = { name: "Y", url: "javascript:alert(1)" };
  d.feed[5] = { name: "Z" };
  d.feed[6] = "https://just-a-string.example";
  const problems = checkData(d);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /feed\.json\[3\] has no name/);
  assert.match(problems[1], /feed\.json\[4\] has no web address/);
  assert.match(problems[3], /feed\.json\[6\] is not an object/);
});

test("a list cut short, or a file that is not a list, is a problem", () => {
  assert.match(checkData({ ...good(), feed: feedOf(MIN_FEED - 1) })[0], /cut short/);
  assert.match(checkData({ ...good(), excluded: { url: "https://x.example" } })[0], /excluded\.json is not a list/);
});

test("excluded.json is checked no more strictly than the page and the generator read it", () => {
  const d = good();
  // What the readers already skip or accept is fine: an old bare address, an entry with no url.
  d.excluded.push("https://old-style.example", { name: "No address" });
  d.additions.push({ url: "" }, { source: "review" });
  assert.deepEqual(checkData(d), []);

  // What would break a reader is not: a field the page prints that is not text, an entry that is neither.
  d.excluded.push({ url: "https://k.example", kind: 3 }, 42, null);
  const problems = checkData(d);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /has a kind that is not text/);
  assert.match(problems[1], /neither an address nor an object/);
});

test("the command fails on a broken file and names it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-data-"));
  fs.writeFileSync(path.join(dir, "feed.json"), JSON.stringify(feedOf(MIN_FEED)));
  fs.writeFileSync(path.join(dir, "additions.json"), "[]");
  fs.writeFileSync(path.join(dir, "excluded.json"), "[{ half a file");
  const bad = spawnSync("node", [path.join(ROOT, "scripts/check-data.mjs"), dir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /excluded\.json cannot be read/);

  fs.writeFileSync(path.join(dir, "excluded.json"), "[]");
  const ok = spawnSync("node", [path.join(ROOT, "scripts/check-data.mjs"), dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
