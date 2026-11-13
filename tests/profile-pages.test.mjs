// Profile pages at their readable address, end to end against the running
// production build (scripts/test-e2e.sh): /p/<host><path> renders with that
// one canonical and its share image at /og/p/<same>; every other form of the
// address (the old encoded one, its decoded and Next.js-collapsed forms,
// www, another case) is a permanent redirect there; an unknown site is a 404.
// The Worker answers the old forms itself with a 301 before Next.js runs
// (worker/profile-redirect.ts, tests/profile-url.test.mjs); here nothing is
// in front, so the page's own redirect (308) is what's checked.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import feed from "../data/feed.json" with { type: "json" };
import { profilePath } from "../lib/profile-url.mjs";
import { createClient } from "@libsql/client";
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

const hasPath = (url) => new URL(url).pathname.replace(/\/+$/, "") !== "";
const plain = feed.find((p) => !hasPath(p.url) && !new URL(p.url).search);
const deep = feed.find((p) => hasPath(p.url) && /[A-Z]/.test(new URL(p.url).pathname) && !new URL(p.url).search);
const get = (path) => fetch(BASE + path, { redirect: "manual" });

test("a profile renders at its readable address, with that one canonical and its share image", async () => {
  for (const p of [plain, deep]) {
    const path = profilePath(p.url);
    assert.ok(!path.includes("%3A"), path);
    const res = await get(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    assert.ok(canonical?.endsWith(path), `${path}: canonical ${canonical}`);
    const image = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
    assert.ok(image?.endsWith(path.replace(/^\/p\//, "/og/p/")), `${path}: og:image ${image}`);
  }
});

test("every other form of a profile's address redirects to the readable one for good", async () => {
  const u = new URL(deep.url);
  const target = profilePath(deep.url);
  const forms = [
    `/p/${encodeURIComponent(deep.url)}`,
    `/p/${u.protocol}/${u.host}${u.pathname}`,
    `/p/${u.host.toUpperCase()}${u.pathname}`,
    `/p/www.${u.host.replace(/^www\./, "")}${u.pathname}`,
    `/p/${u.host}${u.pathname.toLowerCase()}`,
  ];
  for (const from of forms) {
    const res = await get(from);
    assert.ok([301, 308].includes(res.status), `${from}: ${res.status}`);
    assert.equal(new URL(res.headers.get("location"), BASE).pathname, target, from);
  }
});

test("an unknown site is a 404, page and share image alike", async () => {
  assert.equal((await get("/p/no-such-portfolio.example")).status, 404);
  assert.equal((await get("/p/no-such-portfolio.example/deep/path")).status, 404);
  assert.equal((await get("/og/p/no-such-portfolio.example")).status, 404);
  assert.equal((await get("/p/%E0%A4%A")).status, 404);
});

test("the share image answers at /og/p/<address>", async () => {
  const res = await get(profilePath(plain.url).replace(/^\/p\//, "/og/p/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

// Sites from the end of the list, which no other test renders first (pages are kept 5 minutes).
const [graded, hidden, ungraded] = feed.filter((p) => !hasPath(p.url) && !new URL(p.url).search).slice(-3);
const rubric = () =>
  JSON.stringify({
    tier: "A",
    is_portfolio: true,
    roles: ["frontend developer"],
    visual_design: { score: 5, note: "Clean." },
    writing: { score: 3, note: "Fine." },
    rank: { tier: "A", elo: 1650, faceoffs: 40, votes: 12, top: 8, of: 2106, provisional: false },
  });
async function seedGrade(url, { status = "live", health = null } = {}) {
  await db.execute({
    sql: `INSERT INTO portfolios (url, status, health, ai_rubric) VALUES (?, ?, ?, ?)
          ON CONFLICT(url) DO UPDATE SET status = excluded.status, health = excluded.health, ai_rubric = excluded.ai_rubric`,
    args: [url, status, health, rubric()],
  });
}
const jsonLdOf = (html) => {
  const m = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
};
const robotsOf = (html) => html.match(/<meta name="robots" content="([^"]+)"/)?.[1] ?? null;
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

test("a graded profile: a ProfilePage about the person with their socials, a breadcrumb trail and a description from the grade", async () => {
  await seedGrade(graded.url);
  await db.execute({
    sql: "INSERT OR REPLACE INTO cache (k, v, at) VALUES (?, ?, ?)",
    args: [`inspect:${graded.url}`, JSON.stringify({ githubUrl: "https://github.com/someone", linkedinUrl: "https://www.linkedin.com/in/someone", xUrl: "javascript:alert(1)" }), Date.now()],
  });
  const path = profilePath(graded.url);
  const html = await (await get(path)).text();
  assert.equal(robotsOf(html), null, "indexable");
  const ld = jsonLdOf(html);
  const page = ld["@graph"].find((n) => n["@type"] === "ProfilePage");
  const crumbs = ld["@graph"].find((n) => n["@type"] === "BreadcrumbList");
  assert.ok(page.url.endsWith(path));
  assert.equal(page.mainEntity["@type"], "Person");
  assert.equal(page.mainEntity.name, graded.name);
  assert.equal(page.mainEntity.jobTitle, "Frontend Developer");
  // The site, then GitHub and LinkedIn; a scraped link that isn't an https profile is dropped.
  assert.deepEqual(page.mainEntity.sameAs, [graded.url, "https://github.com/someone", "https://www.linkedin.com/in/someone"]);
  assert.deepEqual(crumbs.itemListElement.map((c) => c.name), ["PortfolioRank", "Browse", graded.name]);
  assert.equal(crumbs.itemListElement[2].item, page.url);
  const description = unescape(html.match(/<meta name="description" content="([^"]+)"/)?.[1] ?? "");
  assert.ok(description.includes("Tier A, top 8% of 2,106 ranked portfolios"), description);
  assert.equal(page.description, description);
});

test("a profile the health check hides, or one not graded yet, says noindex and has no structured data", async () => {
  await seedGrade(hidden.url, { status: "dead" });
  for (const p of [hidden, ungraded]) {
    const html = await (await get(profilePath(p.url))).text();
    assert.equal(robotsOf(html), "noindex, follow", p.url);
    assert.equal(jsonLdOf(html), null, p.url);
  }
});
