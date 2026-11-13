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
import { profilePath } from "../lib/profile-url.mjs";

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
const pathOf = profilePath;
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

// Readable addresses (lib/profile-url.mjs). The old and untidy forms are 301s from the
// Worker before Next.js runs (worker/profile-redirect.ts, tests/profile-url.test.mjs);
// nothing is in front here, so they aren't checked end to end.
const canonicalOf = (html) => html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
const deeps = feed.filter((p) => !new URL(p.url).search && /[A-Z]/.test(new URL(p.url).pathname));
const deep = tools ? deeps[0] : deeps[1];
const get = (path) => fetch(BASE + path, { redirect: "manual" });

test("a profile answers at its readable address, which is also its canonical", async () => {
  for (const p of [ungraded, deep]) {
    const path = profilePath(p.url);
    assert.ok(!path.includes("%3A"), path);
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok(canonicalOf(await res.text())?.endsWith(path), path);
  }
});

test("another case or www finds the same profile, and its canonical names the one address; no page answers with a redirect", async () => {
  const u = new URL(deep.url);
  const target = profilePath(deep.url);
  for (const from of [`/p/${u.host.toUpperCase()}${u.pathname}`, `/p/www.${u.host.replace(/^www\./, "")}${u.pathname}`, `/p/${u.host}${u.pathname.toLowerCase()}`]) {
    const res = await get(from);
    assert.equal(res.status, 200, from);
    assert.equal(res.headers.get("location"), null, from);
    assert.ok(canonicalOf(await res.text())?.endsWith(target), from);
  }
});

test("an unknown site is a 404, and so is the old encoded address without the Worker in front", async () => {
  assert.equal((await get("/p/no-such-portfolio.example")).status, 404);
  assert.equal((await get("/p/no-such-portfolio.example/deep/path")).status, 404);
  assert.equal((await get(`/p/${encodeURIComponent(ungraded.url)}`)).status, 404);
});
