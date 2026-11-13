// Seeds a LOCAL database with the blog's fixture posts, for previewing the
// blog and the review flow (never production: it refuses TURSO_DATABASE_URL
// and any database address that isn't a local file).
//
// The fixtures (tests/fixtures/blog/posts.json) are two real drafts the
// content engine wrote in a dry run on 2026-11-10, from a read-only copy of
// production data (the staged writer, 14 Gemini requests and 2 Tavily
// searches for both): their text, fact sheets and checks as the engine
// stored them, and their images (code-drawn charts, Workers AI
// illustrations cropped to 16:9, our screenshots) under
// tests/fixtures/blog/media, which the app reads through
// BLOG_TEST_MEDIA_DIR. Every fixture row is marked: night "fixture", run id
// "fixture-2026-11-10".
//
//   node scripts/seed-blog-fixtures.mjs <db file> [--published]
//
// Without --published both posts go in as drafts waiting for review (what a
// dry-run night leaves); with it, as published posts.
// Then run the app (next dev, or next start with SITE_ENV=test: the media
// stand-in is honoured only there, lib/test-mode.mjs) with LOCAL_DB_FILE=<db file> and
// BLOG_TEST_MEDIA_DIR=$PWD/tests/fixtures/blog/media.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { AI_LINE, aiNote, slugify, storePost } from "../lib/content/store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [file, ...flags] = process.argv.slice(2);
if (!file || process.env.TURSO_DATABASE_URL || /^[a-z]+:/i.test(file)) {
  console.error("usage: node scripts/seed-blog-fixtures.mjs <local db file> [--published] (local files only; unset TURSO_DATABASE_URL)");
  process.exit(1);
}
const published = flags.includes("--published");
const db = createClient({ url: `file:${path.resolve(file)}` });
await migrate(db);

const posts = JSON.parse(fs.readFileSync(path.join(here, "../tests/fixtures/blog/posts.json"), "utf8"));
const written = Date.parse("2026-11-11T05:30:00Z"); // the night of 2026-11-10, Pacific
for (const [i, p] of posts.entries()) {
  await db.execute({ sql: "DELETE FROM posts WHERE id = ?", args: [p.id] });
  const publishAt = new Date(Date.parse("2026-11-11T16:00:00Z") + i * 2 * 86400000); // Wednesday and Friday 08:00 Pacific
  await storePost(
    db,
    {
      ...p,
      slug: slugify(p.title, p.id),
      status: published ? "published" : "draft",
      aiLine: AI_LINE,
      aiNote: aiNote({ dataAsOf: p.dataAsOf, dataLink: p.facts.dataLink }),
      night: "fixture",
      runId: "fixture-2026-11-10",
    },
    { mode: "dry-run", publishAt, now: written + i * 60000 }
  );
  if (published) await db.execute({ sql: "UPDATE posts SET published_at = publish_at, publish_at = ? WHERE id = ?", args: [new Date(written + 10.5 * 3600000 - i * 3600000).toISOString(), p.id] });
  console.log(`${published ? "published" : "draft"}: ${p.title}`);
}
