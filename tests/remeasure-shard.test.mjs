// The split behind .github/workflows/remeasure-all.yml (scripts/remeasure-shard.mjs):
// the shards never overlap, together cover every qualifying site, give the
// same split on a re-run, and honour the limit and the facts-version skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { factsVersion, pickShard, shardOf } from "../scripts/remeasure-shard.mjs";
import { PRIVACY_VERSION } from "../pipeline/cookie-check.mjs";

const urls = Array.from({ length: 500 }, (_, i) => `https://site-${i}.example/`);
const feed = urls.map((url) => ({ url, name: url }));
// Every row has a cookie check reading, so the facts version alone decides (the cookie check's own test is below).
const CHECKED = { v: PRIVACY_VERSION, readings: { US: { state: "none" } } };
const rows = urls.map((url, i) => ({ url, facts: JSON.stringify({ v: i % 2 === 0 ? 1 : 2, privacy: CHECKED }) }));
const all = (shards, extra = {}) =>
  Array.from({ length: shards }, (_, i) => pickShard({ feed, rows, shard: i + 1, shards, ...extra }));

for (const shards of [1, 4, 7]) {
  test(`${shards} shard(s): no overlap, complete cover`, () => {
    const parts = all(shards).map((p) => p.urls);
    const joined = parts.flat();
    assert.equal(new Set(joined).size, joined.length, "an address is in two shards");
    assert.deepEqual([...joined].sort(), [...urls].sort());
    if (shards > 1) for (const p of parts) assert.ok(p.length > 0 && p.length < urls.length);
  });
}

test("the split is stable: the same input gives the same shards, whatever the feed order", () => {
  const a = pickShard({ feed, rows, shard: 2, shards: 4 });
  const b = pickShard({ feed: [...feed].reverse(), rows: [...rows].reverse(), shard: 2, shards: 4 });
  assert.deepEqual(a.urls, b.urls);
  assert.equal(shardOf("https://a.example/", 4), shardOf("https://a.example/", 4));
});

test("an address moves with the hash alone: a new site does not move the others", () => {
  const before = pickShard({ feed, rows, shard: 3, shards: 4 }).urls;
  const extra = { url: "https://brand-new.example/", facts: null };
  const after = pickShard({ feed: [...feed, extra], rows: [...rows, extra], shard: 3, shards: 4 }).urls.filter((u) => u !== extra.url);
  assert.deepEqual(after, before);
});

test("only listed sites with a live, captured row are included", () => {
  const some = rows.slice(0, 100);
  const got = pickShard({ feed, rows: some, shard: 1, shards: 1 });
  assert.equal(got.urls.length, 100);
  const unlisted = [...some, { url: "https://not-on-the-list.example/", facts: null }];
  assert.ok(!pickShard({ feed, rows: unlisted, shard: 1, shards: 1 }).urls.includes("https://not-on-the-list.example/"));
});

test("a repeated address in the feed is one site", () => {
  const got = pickShard({ feed: [...feed, ...feed], rows, shard: 1, shards: 1 });
  assert.equal(got.urls.length, urls.length);
});

test("skip-version leaves out sites whose facts are at that version or newer", () => {
  const got = pickShard({ feed, rows, shard: 1, shards: 1, skipVersion: 2 });
  assert.equal(got.urls.length, 250);
  assert.equal(got.skipped, 250);
  for (const u of got.urls) assert.equal(factsVersion(rows.find((r) => r.url === u).facts), 1);
  assert.equal(pickShard({ feed, rows, shard: 1, shards: 1, skipVersion: 3 }).urls.length, 500);
  assert.equal(pickShard({ feed, rows, shard: 1, shards: 1, skipVersion: 0 }).urls.length, 500);
});

test("facts that are missing or unreadable count as version 0 and are always re-captured", () => {
  assert.equal(factsVersion(null), 0);
  assert.equal(factsVersion("not json"), 0);
  assert.equal(factsVersion('{"words":3}'), 0);
  assert.equal(factsVersion('{"v":2}'), 2);
  const odd = [{ url: "https://x.example/", facts: "{oops" }, { url: "https://y.example/", facts: null }];
  const got = pickShard({ feed: odd, rows: odd, shard: 1, shards: 1, skipVersion: 2 });
  assert.equal(got.urls.length, 2);
});

test("limit caps each shard to its first addresses, and is the same on a re-run", () => {
  const a = pickShard({ feed, rows, shard: 1, shards: 4, limit: 10 });
  assert.equal(a.urls.length, 10);
  assert.deepEqual(a.urls, pickShard({ feed, rows, shard: 1, shards: 4, limit: 10 }).urls);
  const full = pickShard({ feed, rows, shard: 1, shards: 4 }).urls;
  assert.deepEqual(a.urls, full.slice(0, 10));
  assert.equal(pickShard({ feed, rows, shard: 1, shards: 4, limit: 100000 }).urls.length, full.length);
});

test("skip is applied before the limit, so a trial run still has sites to do", () => {
  const got = pickShard({ feed, rows, shard: 1, shards: 1, skipVersion: 2, limit: 10 });
  assert.equal(got.urls.length, 10);
  for (const u of got.urls) assert.equal(factsVersion(rows.find((r) => r.url === u).facts), 1);
});

test("a row without a cookie check reading at its current version is still to do; a re-run skips the rows done", () => {
  const some = [
    { url: "https://done.example/", facts: JSON.stringify({ v: 4, privacy: CHECKED }) },
    { url: "https://no-check.example/", facts: JSON.stringify({ v: 4 }) },
    { url: "https://old-check.example/", facts: JSON.stringify({ v: 4, privacy: { v: PRIVACY_VERSION + 1, readings: { US: { state: "none" } } } }) },
    { url: "https://empty-check.example/", facts: JSON.stringify({ v: 4, privacy: { v: PRIVACY_VERSION, readings: {} } }) },
  ];
  const got = pickShard({ feed: some, rows: some, shard: 1, shards: 1, skipVersion: 4 });
  assert.deepEqual(got.urls, ["https://empty-check.example/", "https://no-check.example/", "https://old-check.example/"]);
  assert.equal(got.skipped, 1);
  // The run filled them in: a re-run after a failure has nothing left.
  const after = some.map((r) => ({ ...r, facts: JSON.stringify({ v: 4, privacy: CHECKED }) }));
  assert.deepEqual(pickShard({ feed: after, rows: after, shard: 1, shards: 1, skipVersion: 4 }).urls, []);
  // skip-version 0 still takes everything.
  assert.equal(pickShard({ feed: after, rows: after, shard: 1, shards: 1, skipVersion: 0 }).urls.length, 4);
});

test("a bad shard number or count is refused", () => {
  for (const [shard, shards] of [[0, 4], [5, 4], [1, 0], [1.5, 4], [1, -1]]) {
    assert.throws(() => pickShard({ feed, rows, shard, shards }), /shard/);
  }
});
