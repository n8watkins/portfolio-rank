// Sticky spelling (pipeline/build-feed.mjs stickySpelling): when the community
// list respells a site already on the feed in a way that cannot name another
// site, the feed keeps its current spelling, so the roster sync delists and
// lists nothing and the site is never graded twice. Anything that could be
// another site behaves exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { buildFeed, refuseFeed, stickySpelling } from "../pipeline/build-feed.mjs";
import { listKey, spellingKey } from "../pipeline/list-key.mjs";
import { dueForCapture, ensureRosterSchema, syncRoster } from "../pipeline/roster.mjs";
import { CLEANUP_SHARE_ENV } from "../pipeline/list-util.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const NOW = new Date("2026-11-21T04:30:00Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sticky-"));
const fillers = Array.from({ length: 520 }, (_, i) => ({ name: `Filler ${i}`, url: `https://filler-${i}.dev` }));

// Each kind of respelling: [current spelling, the list's new spelling].
const RESPELLINGS = [
  ["https://gnavarro.dev/", "https://gnavarro.dev"], // slash removed
  ["https://ann.dev", "https://ann.dev/"], // slash added
  ["https://bob.dev/work", "https://bob.dev/work//"], // slashes on a path
  ["https://www.stimmie.dev", "https://stimmie.dev"], // www dropped
  ["https://cat.dev", "https://www.cat.dev/"], // www added
  ["https://Dan.Dev/Me", "https://dan.dev/Me"], // host case
  ["http://eve.dev", "https://eve.dev"], // scheme
  ["https://hellohaylee.com", "https://hellohaylee.com/?utm_source=github&utm_medium=list"], // tracking added
  ["https://fay.dev/?ref=x&utm_campaign=y", "https://fay.dev?ref=x"], // tracking removed, other query kept
  ["https://gus.dev/?fbclid=abc", "https://gus.dev/#"], // a click id removed, an empty fragment
];

test("spellingKey: only differences that cannot name another site", () => {
  for (const [a, b] of RESPELLINGS) assert.equal(spellingKey(a), spellingKey(b), `${a} = ${b}`);
  // Each of these pairs has one list key but may be two portfolios.
  for (const [a, b] of [
    ["https://host.dev/?user=a", "https://host.dev/?user=b"],
    ["https://host.dev/#/alice", "https://host.dev/#/bob"],
    ["https://host.dev/", "https://host.dev/#/bob"],
    ["https://host.dev/", "https://host.dev/?user=a"],
    ["https://host.dev/?a=1&b=2", "https://host.dev/?b=2&a=1"],
    ["https://bob.github.io/portfolio", "https://bob.github.io/Portfolio"],
    ["https://host.dev:8080/", "https://host.dev/"],
  ]) {
    assert.equal(listKey(a), listKey(b), `${a} and ${b} share a list key`);
    assert.notEqual(spellingKey(a), spellingKey(b), `${a} != ${b}`);
  }
  assert.equal(spellingKey("https://x.dev:443/"), spellingKey("https://x.dev"));
  for (const odd of ["abass.wanecrea.com", "mailto:a@b.c", "", "not a url"]) assert.equal(spellingKey(odd), null, odd);
});

test("every kind of respelling keeps the current spelling and the list's other fields; the roster sync delists and lists nothing", async () => {
  const current = [...fillers, ...RESPELLINGS.map(([was], i) => ({ name: `Old ${i}`, url: was }))];
  const entries = [...fillers, ...RESPELLINGS.map(([, now], i) => ({ name: `New ${i}`, url: now, tagline: `Tagline ${i}` }))];
  const r = buildFeed({ entries, current });
  assert.deepEqual(
    r.feed.slice(fillers.length),
    RESPELLINGS.map(([was], i) => ({ name: `New ${i}`, url: was, tagline: `Tagline ${i}` }))
  );
  assert.deepEqual(r.kept, RESPELLINGS.map(([was, now]) => ({ from: now, to: was })));
  assert.deepEqual(r.unclear, []);
  assert.equal(refuseFeed(current, r.feed, { env: {} }), null);

  const db = createClient({ url: `file:${path.join(tmp(), "db.sqlite")}` });
  await ensureRosterSchema(db);
  await db.batch(current.map((p) => ({ sql: "INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, 'live', '{\"tier\":\"A\"}')", args: [p.url] })), "write");
  assert.deepEqual(await syncRoster(db, r.feed, { now: NOW, owner: true }), { delisted: 0, relisted: 0, listed: current.length, split: 0, skipped: false });
  assert.deepEqual(await dueForCapture(db, r.feed, NOW), []);
});

test("an address that could be another site, or a match that is not one to one, is built exactly as before", () => {
  const cases = [
    // A different query or fragment: the list's spelling, as today.
    { current: ["https://host.dev/?user=a"], entries: ["https://host.dev/?user=b"] },
    { current: ["https://host.dev/#/alice"], entries: ["https://host.dev/#/bob"] },
    { current: ["https://host.dev/"], entries: ["https://host.dev/?lang=en"] },
    { current: ["https://bob.github.io/portfolio"], entries: ["https://bob.github.io/Portfolio"] },
    // An address with no scheme fixed upstream (feed history: abass.wanecrea.com).
    { current: ["abass.wanecrea.com"], entries: ["https://abass.wanecrea.com"] },
    // Two incoming spellings for one current address.
    { current: ["https://two.dev/"], entries: ["https://two.dev", "https://www.two.dev"], unclear: 1 },
    { current: ["https://two.dev/"], entries: ["https://two.dev", "https://two.dev/"], unclear: 1 },
    // One incoming address for two current spellings (a feed written by hand).
    { current: ["https://one.dev", "https://www.one.dev/"], entries: ["http://one.dev"], unclear: 1 },
  ];
  for (const c of cases) {
    const current = c.current.map((url) => ({ name: url, url }));
    const entries = c.entries.map((url) => ({ name: url, url }));
    const before = buildFeed({ entries });
    const r = buildFeed({ entries, current });
    assert.deepEqual(r.feed, before.feed, JSON.stringify(c));
    assert.deepEqual(r.kept, [], JSON.stringify(c));
    assert.equal(r.unclear.length, c.unclear ?? 0, JSON.stringify(c));
  }
  // The same spelling twice on the list is one spelling, so the current one is kept.
  assert.deepEqual(stickySpelling([{ url: "https://x.dev/" }], ["https://x.dev", "https://x.dev"]).spell("https://x.dev"), "https://x.dev/");
});

test("exclusions, duplicates and the guards see the kept spelling exactly as the list's", () => {
  const current = [{ name: "A", url: "https://www.a.dev/" }, { name: "B", url: "https://b.dev/" }];
  const r = buildFeed({
    entries: [
      { name: "A", url: "https://a.dev" },
      { name: "A again", url: "http://A.dev/?lang=en" },
      { name: "B", url: "https://b.dev?utm_source=list" },
    ],
    excluded: [{ url: "https://b.dev", kind: "owner_request" }],
    additions: [{ name: "A added", url: "https://a.dev/#about" }, { name: "C", url: "https://c.dev" }],
    current,
  });
  assert.deepEqual(r.feed, [{ name: "A", url: "https://www.a.dev/" }, { name: "C", url: "https://c.dev" }]);
  assert.deepEqual([r.dupes, r.excludedHits, r.added, r.kept.length], [1, 1, 1, 1]);
  // A respelling of every address is no longer a rewrite the drop guard has to catch; a real rewrite still is.
  const previous = Array.from({ length: 100 }, (_, i) => ({ name: `P${i}`, url: `https://p${i}.dev/` }));
  const respelled = buildFeed({ entries: previous.map((p) => ({ ...p, url: p.url.replace(/\/$/, "") })), current: previous });
  assert.equal(refuseFeed(previous, respelled.feed, { env: {} }), null);
  const moved = buildFeed({ entries: previous.map((p, i) => ({ ...p, url: `https://q${i}.dev/` })), current: previous });
  assert.match(refuseFeed(previous, moved.feed, { env: {} }), /100 of the current 100 addresses are gone/);
});

test("the real data/feed.json as both the current feed and the list changes nothing", () => {
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
  const r = buildFeed({ entries: feed, current: feed });
  assert.deepEqual(r.feed, feed);
  assert.deepEqual([r.kept, r.unclear, r.dupes], [[], [], 0]);
});

test("generate_feed.py, as the nightly sync runs it, keeps the feed's spelling of a respelled site", () => {
  const dir = tmp();
  const file = (f) => path.join(dir, f);
  const current = [...fillers, { name: "Stimmie", url: "https://www.stimmie.dev" }, { name: "Haylee", url: "https://hellohaylee.com" }];
  fs.writeFileSync(file("feed.json"), JSON.stringify(current));
  fs.writeFileSync(file("excluded.json"), "[]");
  fs.writeFileSync(
    file("README.md"),
    [
      ...fillers.map((p) => `- [${p.name}](${p.url})`),
      "- [Stimmie](https://stimmie.dev) [Designer]",
      "- [Haylee](https://hellohaylee.com/?utm_source=github)",
      "- [New](https://new.dev/)",
      "",
    ].join("\n")
  );
  const summary = file("summary.md");
  const out = execFileSync("python3", [path.join(ROOT, "pipeline", "generate_feed.py"), file("README.md"), file("feed.json"), "--exclude", file("excluded.json"), "--max-shrink", "0.05"], {
    encoding: "utf8",
    env: { ...process.env, [CLEANUP_SHARE_ENV]: "", GITHUB_STEP_SUMMARY: summary },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(file("feed.json"), "utf8")).slice(fillers.length), [
    { name: "Stimmie", url: "https://www.stimmie.dev", tagline: "Designer" },
    { name: "Haylee", url: "https://hellohaylee.com" },
    { name: "New", url: "https://new.dev/" },
  ]);
  assert.match(out, /2 respelling\(s\) kept as listed/);
  assert.match(out, /kept https:\/\/www\.stimmie\.dev \(the list now spells it https:\/\/stimmie\.dev\)/);
  assert.match(fs.readFileSync(summary, "utf8"), /### Respellings on the community list: 2 kept, 0 unclear/);
});
