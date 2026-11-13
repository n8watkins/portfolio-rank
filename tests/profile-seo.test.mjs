// lib/profile-seo.ts: a profile's search description from its grade and
// rank, and its ProfilePage structured data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESCRIPTION_MAX, profileDescription, profilePageLd } from "../lib/profile-seo.ts";

const base = {
  name: "Jane Doe",
  url: "https://janedoe.dev/",
  domain: "janedoe.dev",
  tagline: null,
  tier: "A",
  standing: { tier: "A", elo: 1650, faceoffs: 40, votes: 12, top: 8, of: 2106, provisional: false, seeded: false, check: null },
  report: {
    roles: ["frontend developer", "designer"],
    isPortfolio: true,
    axes: [
      { key: "design", label: "Design", score: 5 },
      { key: "writing", label: "Writing", score: 3 },
      { key: "projects", label: "Projects", score: 4 },
    ],
  },
  socials: { github: null, linkedin: null, x: null },
};
const opts = { canonical: "https://portfoliorank.dev/p/janedoe.dev", title: "Jane Doe, Frontend Developer Portfolio | PortfolioRank", siteUrl: "https://portfoliorank.dev", siteName: "PortfolioRank" };

test("a graded, ranked profile's description says who, the rank and the strongest criteria", () => {
  const d = profileDescription(base);
  assert.equal(
    d,
    "Jane Doe's frontend developer and designer portfolio at janedoe.dev. Tier A, top 8% of 2,106 ranked portfolios on PortfolioRank."
  );
  assert.ok(d.length <= DESCRIPTION_MAX);
});

test("a shorter rank line leaves room for the review's strengths and then the tagline", () => {
  const p = { ...base, report: { ...base.report, roles: [] }, standing: { ...base.standing, top: null, of: null }, tagline: "I build fast sites." };
  assert.equal(
    profileDescription(p),
    "Jane Doe's developer portfolio at janedoe.dev. Tier A on PortfolioRank. Strongest in the AI review: design (5/5) and projects (4/5). “I build fast sites.”"
  );
  // A tagline that doesn't fit is left out whole; the grade's parts come first.
  const long = profileDescription({ ...p, tagline: "I build fast, accessible sites for startups and small teams." });
  assert.equal(long, "Jane Doe's developer portfolio at janedoe.dev. Tier A on PortfolioRank. Strongest in the AI review: design (5/5) and projects (4/5).");
  assert.equal(profileDescription({ ...p, report: { ...p.report, axes: [] } }), "Jane Doe's developer portfolio at janedoe.dev. Tier A on PortfolioRank. “I build fast sites.”");
});

test("no letter while face-offs are under way, and no strengths without a 4 or 5", () => {
  const d = profileDescription({ ...base, standing: { ...base.standing, provisional: true }, report: { ...base.report, axes: [{ key: "w", label: "Writing", score: 3 }] } });
  assert.equal(d, "Jane Doe's frontend developer and designer portfolio at janedoe.dev.");
  assert.ok(!profileDescription({ ...base, tier: null }).includes("Tier"));
});

test("a long name is cut at a word with an ellipsis, never past the limit", () => {
  const d = profileDescription({ ...base, name: "Jane ".repeat(60).trim() });
  assert.ok(d.length <= DESCRIPTION_MAX, String(d.length));
  assert.ok(d.endsWith("…"));
});

test("the ProfilePage is about the person: their site, GitHub, LinkedIn and X as sameAs, the grade's role as job title", () => {
  const ld = profilePageLd(
    { ...base, tagline: "I build fast sites.", socials: { github: "https://github.com/jane", linkedin: "https://www.linkedin.com/in/jane", x: null } },
    opts
  );
  assert.equal(ld["@type"], "ProfilePage");
  assert.equal(ld.url, opts.canonical);
  assert.equal(ld.name, opts.title);
  assert.deepEqual(ld.isPartOf, { "@type": "WebSite", name: "PortfolioRank", url: "https://portfoliorank.dev" });
  assert.equal(ld.mainEntity["@type"], "Person");
  assert.equal(ld.mainEntity.name, "Jane Doe");
  assert.equal(ld.mainEntity.url, "https://janedoe.dev/");
  assert.deepEqual(ld.mainEntity.sameAs, ["https://janedoe.dev/", "https://github.com/jane", "https://www.linkedin.com/in/jane"]);
  assert.equal(ld.mainEntity.jobTitle, "Frontend Developer");
  assert.equal(ld.mainEntity.description, "I build fast sites.");
  assert.equal(ld.description, profileDescription({ ...base, tagline: "I build fast sites." }));
});

test("without roles or socials the Person has just its name and site", () => {
  const ld = profilePageLd({ ...base, report: { ...base.report, roles: [] } }, opts);
  assert.deepEqual(ld.mainEntity.sameAs, ["https://janedoe.dev/"]);
  assert.equal("jobTitle" in ld.mainEntity, false);
  assert.equal("description" in ld.mainEntity, false);
});
