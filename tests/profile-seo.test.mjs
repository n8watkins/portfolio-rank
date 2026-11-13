// lib/profile-seo.ts: whether a profile is indexed, its search description
// from the AI grade, its ProfilePage structured data, and the social links
// taken from a page check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DESCRIPTION_MAX, indexable, profileDescription, profilePageLd, socialsFrom } from "../lib/profile-seo.ts";

const base = {
  name: "Jane Doe",
  url: "https://janedoe.dev/",
  domain: "janedoe.dev",
  tagline: null,
  report: {
    roles: ["frontend developer", "designer"],
    isPortfolio: true,
    axes: [
      { key: "visual_design", label: "Visual design", score: 5 },
      { key: "writing", label: "Writing", score: 3 },
      { key: "storytelling", label: "Project presentation", score: 4 },
    ],
  },
  hidden: false,
  socials: { github: null, linkedin: null, x: null },
};
const opts = { canonical: "https://portfoliorank.dev/p/x", title: "Jane Doe - PortfolioRank", siteUrl: "https://portfoliorank.dev", siteName: "PortfolioRank" };

test("only a graded real portfolio the health check shows is indexed", () => {
  assert.equal(indexable(base), true);
  assert.equal(indexable({ ...base, report: null }), false, "ungraded, or the owner hid the grade");
  assert.equal(indexable({ ...base, report: { ...base.report, isPortfolio: false } }), false, "not a portfolio");
  assert.equal(indexable({ ...base, hidden: true }), false, "hidden by the health check");
});

test("the description says who and what, then the review's strongest criteria, then the tagline while it fits", () => {
  assert.equal(
    profileDescription({ ...base, tagline: "I build fast sites." }),
    "Jane Doe's frontend developer and designer portfolio at janedoe.dev. Strongest in the AI review: visual design (5/5) and project presentation (4/5)."
  );
  const short = { ...base, report: { ...base.report, axes: [{ key: "w", label: "Writing", score: 4 }] }, tagline: "I build fast sites." };
  assert.equal(profileDescription(short), "Jane Doe's frontend developer and designer portfolio at janedoe.dev. Strongest in the AI review: writing (4/5). “I build fast sites.”");
  assert.equal(profileDescription({ ...base, report: { ...base.report, roles: [], axes: [] } }), "Jane Doe's developer portfolio at janedoe.dev.");
});

test("a long name is cut at a word with an ellipsis, never past the limit", () => {
  const d = profileDescription({ ...base, name: "Jane ".repeat(60).trim() });
  assert.ok(d.length <= DESCRIPTION_MAX, String(d.length));
  assert.ok(d.endsWith("…"));
});

test("the ProfilePage is about the person: their site, GitHub and LinkedIn as sameAs, the grade's role as job title", () => {
  const ld = profilePageLd({ ...base, tagline: "I build fast sites.", socials: { github: "https://github.com/jane", linkedin: "https://www.linkedin.com/in/jane", x: null } }, opts);
  assert.equal(ld["@type"], "ProfilePage");
  assert.equal(ld.url, opts.canonical);
  assert.equal(ld.name, opts.title);
  assert.deepEqual(ld.isPartOf, { "@type": "WebSite", name: "PortfolioRank", url: "https://portfoliorank.dev" });
  assert.equal(ld.mainEntity["@type"], "Person");
  assert.equal(ld.mainEntity.url, "https://janedoe.dev/");
  assert.deepEqual(ld.mainEntity.sameAs, ["https://janedoe.dev/", "https://github.com/jane", "https://www.linkedin.com/in/jane"]);
  assert.equal(ld.mainEntity.jobTitle, "Frontend Developer");
  assert.equal(ld.mainEntity.description, "I build fast sites.");
  const bare = profilePageLd({ ...base, report: { ...base.report, roles: [] } }, opts);
  assert.deepEqual(bare.mainEntity.sameAs, ["https://janedoe.dev/"]);
  assert.equal("jobTitle" in bare.mainEntity, false);
});

test("social links are kept only as https links on that network's own host", () => {
  assert.deepEqual(socialsFrom({ githubUrl: "https://github.com/jane", linkedinUrl: "https://uk.linkedin.com/in/jane", xUrl: "https://twitter.com/jane" }), {
    github: "https://github.com/jane",
    linkedin: "https://uk.linkedin.com/in/jane",
    x: "https://twitter.com/jane",
  });
  assert.deepEqual(socialsFrom({ githubUrl: "http://github.com/jane", linkedinUrl: "https://evil.example/linkedin.com", xUrl: "javascript:alert(1)" }), { github: null, linkedin: null, x: null });
  assert.deepEqual(socialsFrom({ githubUrl: "https://github.com/" }), { github: null, linkedin: null, x: null });
  assert.deepEqual(socialsFrom(null), { github: null, linkedin: null, x: null });
});
