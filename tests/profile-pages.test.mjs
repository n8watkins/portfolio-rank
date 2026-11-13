// What search engines read on a profile page, end to end against the
// running production build (scripts/test-e2e.sh): a graded profile has a
// ProfilePage about the person (with the social links its page check found)
// and a breadcrumb trail, and a description from its grade; a site the health
// check hides, or one not graded, says noindex and has no structured data.
// Both profile pages (TOOLS_ENABLED on: ./profile-v2.tsx; off, as in
// production today: the original page) read the same facts
// (lib/profile-seo.ts), so the same checks hold for either; the suite runs
// with it on.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import feed from "../data/feed.json" with { type: "json" };
import { migrate } from "../lib/schema.mjs";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:7691";
const DB_URL = process.env.E2E_DB_URL ?? `file:${process.cwd()}/data/portfoliorank.db`;
const db = createClient({ url: DB_URL, timeout: 10000 });

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

// Sites from the end of the list that no other test renders first (pages are kept 5 minutes);
// another three with TOOLS_ENABLED off, so a run of each against one build never shares a page.
const tools = process.env.TOOLS_ENABLED === "true";
const plain = feed.filter((p) => !new URL(p.url).search && new URL(p.url).pathname.replace(/\/+$/, "") === "");
const [graded, hidden, ungraded] = tools ? plain.slice(-3) : plain.slice(-6, -3);
const pathOf = (url) => `/p/${encodeURIComponent(url)}`;
const rubric = JSON.stringify({
  tier: "A",
  is_portfolio: true,
  roles: ["frontend developer"],
  visual_design: { score: 5, note: "Clean." },
  writing: { score: 3, note: "Fine." },
});
async function seedGrade(url, status = "live") {
  await db.execute({
    sql: `INSERT INTO portfolios (url, status, ai_rubric) VALUES (?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET status = excluded.status, health = NULL, ai_rubric = excluded.ai_rubric`,
    args: [url, status, rubric],
  });
}
const jsonLdOf = (html) => {
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
};
const robotsOf = (html) => html.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? null;
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const page = async (url) => {
  const res = await fetch(BASE + pathOf(url));
  assert.equal(res.status, 200, url);
  return res.text();
};

test("a graded profile: a ProfilePage about the person with their socials, a breadcrumb trail and a description from the grade", async () => {
  await seedGrade(graded.url);
  await db.execute({
    sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
    args: [`inspect:${graded.url}`, JSON.stringify({ githubUrl: "https://github.com/someone", linkedinUrl: "https://www.linkedin.com/in/someone", xUrl: "javascript:alert(1)" }), Date.now()],
  });
  const html = await page(graded.url);
  assert.equal(robotsOf(html), null, "indexable");
  const ld = jsonLdOf(html);
  const profile = ld["@graph"].find((n) => n["@type"] === "ProfilePage");
  const crumbs = ld["@graph"].find((n) => n["@type"] === "BreadcrumbList");
  assert.ok(profile.url.endsWith(pathOf(graded.url)));
  assert.equal(profile.mainEntity["@type"], "Person");
  assert.equal(profile.mainEntity.name, graded.name);
  assert.equal(profile.mainEntity.jobTitle, "Frontend Developer");
  // The site, then GitHub and LinkedIn; a scraped link that isn't an https profile is dropped.
  assert.deepEqual(profile.mainEntity.sameAs, [graded.url, "https://github.com/someone", "https://www.linkedin.com/in/someone"]);
  assert.deepEqual(crumbs.itemListElement.map((c) => c.name), ["PortfolioRank", "Browse", graded.name]);
  assert.equal(crumbs.itemListElement[2].item, profile.url);
  const description = unescape(html.match(/<meta name="description" content="([^"]+)"/)?.[1] ?? "");
  assert.ok(description.startsWith(`${graded.name}'s frontend developer portfolio at `), description);
  assert.ok(description.includes("visual design (5/5)"), description);
  assert.equal(profile.description, description);
});

test("a profile the health check hides, or one not graded, says noindex and has no structured data", async () => {
  await seedGrade(hidden.url, "dead");
  // Other tests seed grades for listed sites; this one has none.
  await db.execute({ sql: "UPDATE portfolios SET ai_rubric = NULL WHERE url = ?", args: [ungraded.url] });
  await db.execute({ sql: "DELETE FROM grade_jobs WHERE url = ?", args: [ungraded.url] });
  for (const p of [hidden, ungraded]) {
    const html = await page(p.url);
    assert.equal(robotsOf(html), "noindex, follow", p.url);
    assert.equal(jsonLdOf(html), null, p.url);
  }
});
