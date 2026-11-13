// lib/sitemap-profiles.mjs (app/sitemap.ts): the sitemap lists a profile
// only for a site on the list that is shown and graded as a portfolio.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { gradedUrls, sitemapProfiles } from "../lib/sitemap-profiles.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "pr-sitemap-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("only graded real portfolios that are listed and shown", async () => {
  const db = createClient({ url: `file:${path.join(dir, "db.sqlite")}` });
  await migrate(db);
  const rows = [
    ["https://graded.dev", JSON.stringify({ tier: "A", is_portfolio: true })],
    ["https://legacy-grade.dev", JSON.stringify({ tier: "B" })],
    ["https://ungraded.dev", null],
    ["https://not-a-portfolio.dev", JSON.stringify({ tier: "C", is_portfolio: false })],
    ["https://failed.dev", JSON.stringify({ error: "timeout" })],
    ["https://broken-json.dev", "{not json"],
    ["https://hidden.dev", JSON.stringify({ tier: "A", is_portfolio: true })],
    ["https://unlisted.dev", JSON.stringify({ tier: "A", is_portfolio: true })],
  ];
  for (const [url, rubric] of rows) await db.execute({ sql: "INSERT INTO portfolios (url, ai_rubric) VALUES (?, ?)", args: [url, rubric] });
  const graded = await gradedUrls(db);
  assert.deepEqual([...graded].sort(), ["https://graded.dev", "https://hidden.dev", "https://legacy-grade.dev", "https://unlisted.dev"]);
  const feed = rows.filter(([url]) => url !== "https://unlisted.dev").map(([url]) => ({ url }));
  assert.deepEqual(sitemapProfiles(feed, new Set(["https://hidden.dev"]), graded), ["https://graded.dev", "https://legacy-grade.dev"]);
});

test("app/sitemap.ts filters profiles always, not behind a launch switch", () => {
  const src = readFileSync("app/sitemap.ts", "utf8");
  assert.match(src, /sitemapProfiles\(feed as Portfolio\[\], hidden, graded\)/);
  assert.doesNotMatch(src, /Enabled\(\) \? await gradedUrls/);
});
