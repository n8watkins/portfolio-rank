// The blog's reads and the owner's review (lib/content/blog.mjs) on a
// throwaway database: the public reads see only published posts whose time
// has come, tags and reading time, and Publish, Reject and Unpublish with
// the weekly cap counted in the same write. No server needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { PUBLISH_CAP, storePost } from "../lib/content/store.mjs";
import { portfolioHref, portfolioIndex } from "../lib/content/portfolio-links.mjs";
import { getPost, getPublished, hasPublished, listPublished, morePosts, publishTime, readingMinutes, review, reviewQueue, tagSlug, tagsOf } from "../lib/content/blog.mjs";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blog-"));
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  return db;
}

const NOW = Date.parse("2026-11-12T00:00:00Z");
let n = 0;
function post(over = {}) {
  n++;
  const id = (over.id ?? `b10600000000${String(n).padStart(4, "0")}`).slice(0, 16);
  return {
    id,
    slug: `post-${id}`,
    kind: "top-grades",
    title: `Post ${n}`,
    subtitle: "A dek",
    tags: ["Portfolios", "Developer Careers"],
    aiLine: "Written with AI from PortfolioRank data.",
    aiNote: "note",
    body: "> **TL;DR**\n> - one\n\n[[image:hero]]\n\n" + "word ".repeat(440),
    facts: { facts: [], names: [] },
    checks: { passed: true, rounds: 1, history: [], failures: [] },
    images: [{ slot: "hero", kind: "chart", key: `content/test/${id}/hero.svg` }],
    claims: [],
    dataAsOf: new Date(NOW - 86400000).toISOString(),
    ...over,
  };
}
const put = (db, p, { status = "draft", publishAt = null, mode = "dry-run" } = {}) => storePost(db, { ...p, status }, { mode, publishAt, now: NOW - 3600000 });

test("tags and reading time", () => {
  assert.equal(tagSlug("Developer Careers"), "developer-careers");
  assert.equal(tagSlug("  AI / Hiring! "), "ai-hiring");
  assert.equal(readingMinutes("word ".repeat(440)), 2);
  assert.equal(readingMinutes(""), 1);
  // Image markers, link addresses and Markdown marks are not words.
  assert.equal(readingMinutes("[[image:hero]] **[a](https://example.com/x/y/z)** https://example.com"), 1);
  const tags = tagsOf([{ tags: ["Portfolios", "Design"] }, { tags: ["portfolios"] }]);
  assert.deepEqual(tags.map((t) => [t.slug, t.count]), [["portfolios", 2], ["design", 1]]);
});

test("the public reads see only published posts whose publish_at has passed, newest first", async () => {
  const db = await freshDb();
  const live = post({ title: "Live" });
  const older = post({ title: "Older", tags: ["Design"] });
  const later = post({ title: "Scheduled" });
  const draft = post({ title: "Draft" });
  await put(db, live, { status: "published" });
  await db.execute({ sql: "UPDATE posts SET publish_at = ? WHERE id = ?", args: [new Date(NOW - 3600000).toISOString(), live.id] });
  await put(db, older, { status: "published" });
  await db.execute({ sql: "UPDATE posts SET publish_at = ? WHERE id = ?", args: [new Date(NOW - 3 * 86400000).toISOString(), older.id] });
  await put(db, later, { status: "published" });
  await db.execute({ sql: "UPDATE posts SET publish_at = ? WHERE id = ?", args: [new Date(NOW + 3600000).toISOString(), later.id] });
  await put(db, draft, { publishAt: NOW - 3600000 });

  const list = await listPublished(db, { now: NOW });
  assert.deepEqual(list.map((p) => p.title), ["Live", "Older"]);
  assert.equal(list[0].minutes, 2);
  assert.deepEqual((await listPublished(db, { now: NOW, tag: "design" })).map((p) => p.title), ["Older"]);
  assert.ok(await getPublished(db, live.slug, { now: NOW }));
  assert.equal(await getPublished(db, later.slug, { now: NOW }), null, "not before its time");
  assert.equal(await getPublished(db, draft.slug, { now: NOW }), null, "never a draft");
  assert.deepEqual((await listPublished(db, { now: NOW + 7200000 })).map((p) => p.title), ["Scheduled", "Live", "Older"]);
});

test("publish: at once when the draft's time has passed, at its scheduled time when it is ahead; recorded on the post", async () => {
  const db = await freshDb();
  const past = post();
  const ahead = post();
  await put(db, past, { publishAt: NOW - 3600000 });
  await put(db, ahead, { publishAt: NOW + 86400000 });
  assert.equal(publishTime({ publishAt: new Date(NOW + 86400000).toISOString() }, NOW).getTime(), NOW + 86400000);
  assert.equal(publishTime({ publishAt: null }, NOW).getTime(), NOW);

  const a = await review(db, past.id, { action: "publish", by: "owner", now: NOW });
  assert.deepEqual(a, { ok: true, status: "published", publishAt: new Date(NOW).toISOString() });
  const row = await getPost(db, past.id);
  assert.equal(row.status, "published");
  assert.equal(row.newsletterPending, true);
  assert.equal(row.checks.owner.by, "owner");
  assert.equal(row.checks.owner.action, "publish");
  assert.equal(row.checks.passed, true, "the engine's checks stay");

  const b = await review(db, ahead.id, { action: "publish", by: "owner", now: NOW });
  assert.equal(b.publishAt, new Date(NOW + 86400000).toISOString());
  assert.equal(await getPublished(db, ahead.slug, { now: NOW }), null);

  // A second click on a published post changes nothing.
  assert.deepEqual(await review(db, past.id, { action: "publish", by: "owner", now: NOW }), { ok: false, error: "wrong_status", status: "published" });
});

test("publish keeps the weekly cap", async () => {
  const db = await freshDb();
  const drafts = Array.from({ length: PUBLISH_CAP + 1 }, () => post());
  for (const d of drafts) await put(db, d, { publishAt: NOW - 60000 });
  for (const d of drafts.slice(0, PUBLISH_CAP)) assert.equal((await review(db, d.id, { action: "publish", by: "owner", now: NOW })).ok, true);
  assert.deepEqual(await review(db, drafts.at(-1).id, { action: "publish", by: "owner", now: NOW }), { ok: false, error: "weekly_cap" });
  assert.equal((await getPost(db, drafts.at(-1).id)).status, "draft");
  // Unpublishing one makes room again.
  assert.equal((await review(db, drafts[0].id, { action: "unpublish", by: "owner", note: "a typo", now: NOW })).status, "unpublished");
  assert.equal((await review(db, drafts.at(-1).id, { action: "publish", by: "owner", now: NOW })).ok, true);
  const gone = await getPost(db, drafts[0].id);
  assert.equal(gone.checks.owner.note, "a typo");
  assert.equal(gone.newsletterPending, false);
  assert.equal(await getPublished(db, gone.slug, { now: NOW }), null);
});

test("reject a draft; only the right status moves; unknown posts and actions", async () => {
  const db = await freshDb();
  const d = post();
  await put(db, d, { publishAt: NOW });
  const dropped = post();
  await put(db, dropped, { status: "dropped" });
  assert.deepEqual(await review(db, d.id, { action: "reject", by: "owner", note: "off topic", now: NOW }), { ok: true, status: "rejected" });
  assert.equal((await getPost(db, d.id)).checks.owner.note, "off topic");
  assert.equal((await review(db, d.id, { action: "publish", by: "owner", now: NOW })).error, "wrong_status");
  assert.equal((await review(db, dropped.id, { action: "publish", by: "owner", now: NOW })).error, "wrong_status");
  assert.equal((await review(db, "ffffffffffffffff", { action: "publish", by: "owner", now: NOW })).error, "not_found");
  assert.equal((await review(db, d.id, { action: "delete", by: "owner", now: NOW })).error, "bad_action");
  const q = await reviewQueue(db);
  assert.deepEqual([q.drafts.length, q.published.length, q.closed.length], [0, 0, 2]);
});

test("hasPublished: only a live post counts", async () => {
  const db = await freshDb();
  assert.equal(await hasPublished(db, { now: NOW }), false);
  const d = post();
  await put(db, d, { publishAt: NOW + 3600000 });
  assert.equal(await hasPublished(db, { now: NOW }), false, "a draft doesn't count");
  await review(db, d.id, { action: "publish", by: "owner", now: NOW });
  assert.equal(await hasPublished(db, { now: NOW }), false, "scheduled, not yet live");
  assert.equal(await hasPublished(db, { now: NOW + 7200000 }), true);
});

test("publish now: a draft whose slot is ahead goes live at once; so does a post scheduled for later; a live post stays as it is", async () => {
  const db = await freshDb();
  const ahead = post();
  await put(db, ahead, { publishAt: NOW + 86400000 });
  const a = await review(db, ahead.id, { action: "publish_now", by: "owner", now: NOW });
  assert.deepEqual(a, { ok: true, status: "published", publishAt: new Date(NOW).toISOString() });
  assert.equal((await getPublished(db, ahead.slug, { now: NOW })).id, ahead.id);
  assert.equal((await getPost(db, ahead.id)).checks.owner.action, "publish_now");

  // Scheduled with Publish (its 08:00 slot), then Publish now before the slot.
  const scheduled = post();
  await put(db, scheduled, { publishAt: NOW + 86400000 });
  assert.equal((await review(db, scheduled.id, { action: "publish", by: "owner", now: NOW })).publishAt, new Date(NOW + 86400000).toISOString());
  assert.equal(await getPublished(db, scheduled.slug, { now: NOW }), null);
  const later = NOW + 60000;
  assert.deepEqual(await review(db, scheduled.id, { action: "publish_now", by: "owner", now: later }), { ok: true, status: "published", publishAt: new Date(later).toISOString() });
  assert.equal((await getPublished(db, scheduled.slug, { now: later })).id, scheduled.id);
  // Already live: nothing to do.
  assert.deepEqual(await review(db, scheduled.id, { action: "publish_now", by: "owner", now: later + 1 }), { ok: false, error: "wrong_status", status: "published" });
  // The weekly cap still holds.
  const third = post();
  await put(db, third, { publishAt: NOW + 86400000 });
  assert.deepEqual(await review(db, third.id, { action: "publish_now", by: "owner", now: later }), { ok: false, error: "weekly_cap" });
});

test("more articles: posts sharing the most tags first, then the newest; never the post itself", () => {
  const p = (id, tags, publishAt) => ({ id, tags, publishAt });
  const posts = [p("a", ["Design"], "2026-11-10"), p("b", ["Portfolios", "Hiring"], "2026-11-09"), p("c", ["Portfolios"], "2026-11-08"), p("self", ["Portfolios", "Hiring"], "2026-11-07"), p("d", [], "2026-11-06")];
  assert.deepEqual(morePosts({ id: "self", tags: ["Portfolios", "Hiring"] }, posts).map((x) => x.id), ["b", "c", "a"]);
  assert.deepEqual(morePosts({ id: "self", tags: [] }, posts, { limit: 2 }).map((x) => x.id), ["a", "b"]);
  assert.deepEqual(morePosts({ id: "a", tags: ["design"] }, [posts[0]]), []);
});

test("post links: a listed portfolio's site opens its PortfolioRank page; a /p/ link to one no longer listed opens the site", () => {
  const index = portfolioIndex(["https://top-1.dev", "https://jane.github.io/folio/"]);
  assert.equal(portfolioHref("https://top-1.dev", index), "/p/top-1.dev");
  assert.equal(portfolioHref("http://www.TOP-1.dev/", index), "/p/top-1.dev");
  assert.equal(portfolioHref("https://jane.github.io/folio", index), "/p/jane.github.io/folio");
  // Our own links, in the old encoded form or the readable one.
  assert.equal(portfolioHref("https://portfoliorank.dev/p/https%3A%2F%2Ftop-1.dev", index), "/p/top-1.dev");
  assert.equal(portfolioHref("/p/TOP-1.dev", index), "/p/top-1.dev");
  assert.equal(portfolioHref("https://portfoliorank.dev/p/jane.github.io/folio?x=1", index), "/p/jane.github.io/folio");
  assert.equal(portfolioHref("https://portfoliorank.dev/p/https%3A%2F%2Fgone.dev", index), "https://gone.dev/");
  assert.equal(portfolioHref("/p/gone.dev/work", index), "https://gone.dev/work");
  assert.equal(portfolioHref("/p/%E0%A4%A", index), "/p/%E0%A4%A");
  assert.equal(portfolioHref("https://example.com/article", index), "https://example.com/article");
  assert.equal(portfolioHref("https://jane.github.io/other", index), "https://jane.github.io/other");
});
