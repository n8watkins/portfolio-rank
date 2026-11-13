// The blog pages and the owner's review, end to end against the running
// production build (scripts/test-e2e.sh: ADMIN_GITHUB_ID,
// BLOG_TEST_MEDIA_DIR=tests/fixtures/blog/media). A published post renders
// with its JSON-LD, images and AI note; a draft is a 404 for the public and
// a preview for the admin, who can publish it; its images follow the same
// rule; the review API is admin-only and CSRF-checked.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createClient } from "@libsql/client";
import { ADMIN_ID, sessionCookie } from "./helpers/session.mjs";
import { migrate } from "../lib/schema.mjs";
import { AI_LINE, storePost } from "../lib/content/store.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });
const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/blog/posts.json", import.meta.url), "utf8"))[0];

const cookieFor = (login, id) => sessionCookie({ id, login });

before(async () => {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + "/");
      await migrate(db);
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no server at ${BASE}`);
});

/** A copy of the fixture post under a new id and slug, stored with `status`. */
async function seed(status, { publishAt = Date.now() - 60000 } = {}) {
  const id = crypto.randomBytes(8).toString("hex");
  const p = { ...fixture, id, slug: `e2e-${status}-${id}`, status, aiLine: AI_LINE, aiNote: "note" };
  await storePost(db, p, { mode: "dry-run", publishAt, now: Date.now() - 120000 });
  if (status === "published") await db.execute({ sql: "UPDATE posts SET publish_at = ? WHERE id = ?", args: [new Date(publishAt).toISOString(), id] });
  return p;
}

test("a published post: the article, its AI note, sources, JSON-LD and images; the shell's Blog links turn on", async () => {
  const p = await seed("published");
  const live = await fetch(`${BASE}/api/blog/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { live: true });
  const res = await fetch(`${BASE}/blog/${p.slug}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(p.title.replace(/&/g, "&amp;")));
  assert.ok(html.includes("Written with AI from PortfolioRank data."));
  assert.ok(html.includes('href="/about-posts"'));
  assert.ok(html.includes("Portfolios in this post"));
  assert.ok(html.includes('"@type":"BlogPosting"'));
  assert.ok(html.includes(`/blog/media/${p.id}/hero`));
  assert.ok(!html.includes("[[image:"), "image markers are replaced");
  assert.ok(!/<script>alert/.test(html));
  const img = await fetch(`${BASE}/blog/media/${p.id}/inline-1`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/svg+xml");
  assert.match(img.headers.get("cache-control"), /^public/);
  assert.equal((await fetch(`${BASE}/blog/media/${p.id}/nope`)).status, 404);
});

/** The page's JSON-LD document. */
function jsonLdOf(html) {
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  assert.ok(m, "the page has JSON-LD");
  return JSON.parse(m[1]);
}

test("a post's structured data: the owner as author, its real edit time and a breadcrumb trail", async () => {
  // Published a month ago, outside the weekly publish cap the next test publishes under.
  const p = await seed("published", { publishAt: Date.now() - 30 * 86400000 });
  // Edited after it went live: dateModified and og:article:modified_time follow the edit.
  const edited = new Date(Date.now() - 1000).toISOString();
  await db.execute({ sql: "UPDATE posts SET updated_at = ? WHERE id = ?", args: [edited, p.id] });
  const html = await (await fetch(`${BASE}/blog/${p.slug}`)).text();
  const ld = jsonLdOf(html);
  assert.equal(ld["@context"], "https://schema.org");
  const post = ld["@graph"].find((n) => n["@type"] === "BlogPosting");
  const crumbs = ld["@graph"].find((n) => n["@type"] === "BreadcrumbList");
  assert.equal(post.author["@type"], "Person");
  assert.equal(post.author.name, "Nathan Watkins");
  assert.equal(post.publisher["@type"], "Organization");
  assert.equal(post.dateModified, edited);
  assert.ok(Date.parse(post.datePublished) < Date.parse(post.dateModified));
  assert.match(post.url, new RegExp(`/blog/${p.slug}$`));
  assert.deepEqual(
    crumbs.itemListElement.map((c) => [c.position, c.name]),
    [[1, "PortfolioRank"], [2, "Blog"], [3, p.title]]
  );
  assert.equal(crumbs.itemListElement[2].item, post.url);
  assert.ok(html.includes(`<meta property="article:modified_time" content="${edited}"`));
});

test("a draft is a 404 for the public, a preview for the admin, who publishes it", async () => {
  const p = await seed("draft");
  assert.equal((await fetch(`${BASE}/blog/${p.slug}`)).status, 404);
  assert.equal((await fetch(`${BASE}/blog/media/${p.id}/hero`)).status, 404, "a draft's images are private");
  assert.equal((await fetch(`${BASE}/admin/blog/${p.id}`)).status, 404, "the admin pages are a 404 for anyone else");

  const admin = await cookieFor("e2e-admin", ADMIN_ID);
  const preview = await fetch(`${BASE}/admin/blog/${p.id}`, { headers: { cookie: admin } });
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.ok(html.includes("Publish now"));
  assert.ok(html.includes("For your review"));
  const img = await fetch(`${BASE}/blog/media/${p.id}/hero`, { headers: { cookie: admin } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("cache-control"), "private, no-store");

  const post = (cookie, body, origin = BASE) =>
    fetch(`${BASE}/api/admin/content/${p.id}`, { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("", { action: "publish" })).status, 401);
  assert.equal((await post(await cookieFor("someone-else", 990000102), { action: "publish" })).status, 403);
  assert.equal((await post(admin, { action: "publish" }, "https://evil.example")).status, 403);
  assert.equal((await post(admin, { action: "explode" })).status, 400);
  const ok = await post(admin, { action: "publish" });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).status, "published");
  assert.equal((await post(admin, { action: "publish" })).status, 409, "only once");
  const row = (await db.execute({ sql: "SELECT status, newsletter_pending, checks FROM posts WHERE id = ?", args: [p.id] })).rows[0];
  assert.equal(row.status, "published");
  assert.equal(Number(row.newsletter_pending), 1);
  assert.equal(JSON.parse(row.checks).owner.by, "e2e-admin");
  // The page itself was asked for as a draft above, and ISR may keep that 404 for up to 5 minutes;
  // the media route is never cached as a 404, so it shows the post is live at once.
  assert.equal((await fetch(`${BASE}/blog/media/${p.id}/hero`)).status, 200);
});

test("the list, the feed and the review queue answer", async () => {
  assert.equal((await fetch(`${BASE}/blog`)).status, 200);
  const rss = await fetch(`${BASE}/blog/rss.xml`);
  assert.equal(rss.status, 200);
  assert.match(rss.headers.get("content-type"), /application\/rss\+xml/);
  assert.match(await rss.text(), /<channel>/);
  assert.equal((await fetch(`${BASE}/about-posts`)).status, 200);
  assert.equal((await fetch(`${BASE}/admin/blog`)).status, 404);
  const q = await fetch(`${BASE}/admin/blog`, { headers: { cookie: await cookieFor("e2e-admin", ADMIN_ID) } });
  assert.equal(q.status, 200);
  assert.ok((await q.text()).includes("Blog drafts"));
});
