// The redesigned profile (app/p/[slug]/next): its report and prompt
// (lib/profile-next/report.mjs), what its claim card says
// (lib/profile-next/claim-copy.mjs), the hourly check of its answer
// (lib/profile-next/origin.mjs) and its launch switch.
//
// Only measured facts become cards, each fact reads yes or no or its number,
// nothing unmeasured shows as a placeholder, the product's own rules and words
// are used (project links, the footer year), dates are when the results were
// saved, and "What we recommend changing" and "Copy as a prompt" are made
// from exactly the findings the cards show, the same way every time (no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dayOf, fixPrompt, pageSpeedUrl, profileReport, scoreState } from "../lib/profile-next/report.mjs";
import { claimCopy } from "../lib/profile-next/claim-copy.mjs";
import { profileOrigin } from "../lib/profile-next/origin.mjs";
import { profileNextEnabled } from "../lib/profile-next/flag.ts";
import { projectLinksText } from "../pipeline/facts.mjs";
import { STALE_FOOTER_YEARS } from "../pipeline/rubric.mjs";

const NOW = new Date("2026-11-25T12:00:00Z");
const URL_ = "https://jane.dev/";
// When the rows were saved (the cache table's `at`): the saved values carry no time of their own.
const INSPECT_AT = Date.parse("2026-11-20T10:00:00Z");
const PSI_AT = Date.parse("2026-11-23T09:30:00Z");

const inspect = (over = {}) => ({
  ok: true,
  finalUrl: "https://jane.dev/",
  https: true,
  customDomain: true,
  description: "Jane builds things.",
  ogImage: "https://jane.dev/og.png",
  ogImageLoads: true,
  githubUrl: "https://github.com/jane",
  hasResume: true,
  hasContact: true,
  copyrightYear: 2026,
  ...over,
});
const facts = (over = {}) => ({
  v: 4,
  final_url: "https://jane.dev/",
  own_domain: true,
  resume: true,
  github: true,
  contact: true,
  footer_year: 2026,
  builder: null,
  project_links: { checked: 5, ok: 5, broken: 0, blocked: 0 },
  measured_at: "2026-11-22T08:00:00Z",
  ...over,
});
const psi = (scores) => ({ ok: true, scores });
const run = (over = {}) => profileReport({ url: URL_, inspectAt: INSPECT_AT, psiAt: PSI_AT, now: NOW, ...over });

const card = (r, id) => r.cards.find((c) => c.id === id);
const item = (r, id) => card(r, "basics").data.items.find((i) => i.id === id);

test("a site with everything in place: three cards, nothing to fix, an empty prompt list", () => {
  const r = run({ inspect: inspect(), facts: facts(), psi: psi({ performance: 97, accessibility: 100, seo: 100, "best-practices": 96 }) });
  assert.deepEqual(r.cards.map((c) => [c.id, c.fixes]), [["basics", 0], ["projects", 0], ["mobile", 0]]);
  assert.deepEqual(r.recommendations, []);
  assert.equal(r.checkedOn, "23 Nov 2026", "the newest saved measurement shown");
  assert.match(r.prompt, /Nothing was found to fix\.$/);
  // GitHub is a header button when found, so Basics lists it only when it is missing.
  assert.equal(item(r, "github"), undefined);
  assert.deepEqual(card(r, "basics").data.items.map((i) => [i.id, i.value]), [
    ["resume", "Yes"],
    ["contact", "Yes"],
    ["share", "Yes"],
    ["desc", "Yes"],
    ["domain", "Yes"],
    ["year", "2026"],
  ]);
});

test("dates are when the results were saved (the cache row's at), never a time inside the value", () => {
  const r = run({ inspect: inspect({ measuredAt: "2030-01-01T00:00:00Z" }), psi: { ...psi({ performance: 97 }), measuredAt: "2030-01-01T00:00:00Z" }, facts: null });
  assert.equal(card(r, "mobile").data.measuredOn, "23 Nov 2026");
  assert.equal(r.checkedOn, "23 Nov 2026");
  // Without a saved time there is no date, not a made-up one.
  const none = profileReport({ url: URL_, psi: psi({ performance: 97 }), now: NOW });
  assert.equal(card(none, "mobile").data.measuredOn, null);
  assert.equal(none.checkedOn, null);
});

test("no score and no points: presence checks read yes or no, measured things their number", () => {
  const r = run({ inspect: inspect(), facts: facts(), psi: psi({ performance: 71, accessibility: 92, seo: 100, "best-practices": 96 }) });
  assert.ok(!/points|\/100/i.test(JSON.stringify(r.cards.map((c) => c.data))), "no points in the cards");
  for (const i of card(r, "basics").data.items) assert.ok(["Yes", "No", "None", "None found", "Not shown", "Shared host", "Not secure", "Does not load"].includes(i.value) || /^\d{4}$/.test(i.value), i.value);
  const m = card(r, "mobile").data;
  assert.equal(m.speed, 71);
  assert.equal(m.speedState, "warn");
  assert.deepEqual(m.rows.map((x) => [x.label, x.value]), [["Accessibility", 92], ["Search", 100], ["Best practices", 96]]);
  assert.equal(m.measuredOn, "23 Nov 2026");
  assert.equal(m.testUrl, "https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fjane.dev%2F&form_factor=mobile");
});

test("what is not measured is left out, never a placeholder; a card with nothing measured is left out", () => {
  // No polish check, no capture, no Lighthouse: no report at all.
  assert.deepEqual(run().cards, []);
  assert.equal(run().checkedOn, null);
  // A failed Lighthouse run and a failed polish check count as not measured, and their dates are not used.
  const unread = facts();
  delete unread.footer_year;
  const r = run({ inspect: { ok: false, error: "unreachable" }, facts: unread, psi: { ok: false, error: "timeout" } });
  assert.deepEqual(r.cards.map((c) => c.id), ["basics", "projects"]);
  assert.equal(r.checkedOn, "22 Nov 2026", "the facts' own time");
  // From the capture alone: resume, contact and the domain; no share image or description (only the polish check
  // reads them), and no footer year (never read).
  assert.deepEqual(card(r, "basics").data.items.map((i) => i.id), ["resume", "contact", "domain"]);
  // A footer read with no year in it is measured: "Not shown", which is not a fault.
  const noYear = run({ facts: facts({ footer_year: null }) });
  assert.deepEqual([item(noYear, "year").value, item(noYear, "year").st, card(noYear, "basics").fixes], ["Not shown", "info", 0]);
  // Without project links or a builder, no Projects card.
  assert.equal(card(run({ inspect: inspect(), facts: facts({ project_links: null }) }), "projects"), undefined);
  // "Built with" only when a builder was recognised.
  assert.equal(card(run({ facts: facts() }), "projects").data.builtWith, null);
  assert.equal(card(run({ facts: facts({ builder: "Framer" }) }), "projects").data.builtWith, "Framer");
});

test("the footer year follows the rubric's rule (STALE_FOOTER_YEARS), not a second cutoff", () => {
  const year = NOW.getUTCFullYear();
  const at = (y) => item(run({ facts: facts({ footer_year: y }) }), "year").st;
  assert.equal(at(year - STALE_FOOTER_YEARS), "yes", "exactly the limit is fresh");
  assert.equal(at(year - STALE_FOOTER_YEARS - 1), "no");
});

test("findings: each fact that falls short is one thing to fix, and one recommendation, in card order", () => {
  const r = run({
    inspect: inspect({ githubUrl: null, hasGithubLink: false, description: null, ogImage: null, ogImageLoads: false, customDomain: false, finalUrl: "https://jane.vercel.app/" }),
    facts: facts({ github: false, resume: false, contact: false, footer_year: 2021, project_links: { checked: 4, ok: 2, broken: 2, blocked: 0 } }),
    psi: psi({ performance: 48, accessibility: 88, seo: 100, "best-practices": 96 }),
  });
  assert.deepEqual(r.cards.map((c) => [c.id, c.fixes]), [["basics", 7], ["projects", 1], ["mobile", 2]]);
  assert.equal(item(r, "github").value, "None found");
  assert.equal(item(r, "share").value, "None");
  assert.equal(item(r, "domain").value, "Shared host");
  assert.equal(item(r, "year").st, "no");
  assert.deepEqual(r.recommendations, [
    "Link your GitHub profile from the home page.",
    "Link your resume from the home page.",
    "Add a way to reach you: an email link, a contact form or LinkedIn.",
    "Add a share image, the picture shown when the link is posted.",
    'Add a search description (<meta name="description">).',
    "Move the site to a domain of your own.",
    "Update the footer year (it says 2021).",
    "Fix or remove the 2 project links that do not load.",
    "Speed up the page on mobile: Lighthouse gives it 48 of 100.",
    "Raise accessibility on mobile: Lighthouse gives it 88 of 100.",
  ]);
  assert.match(r.prompt, /2 of the 4 project links checked on the home page and its projects page did not load/);
});

test("the prompt is deterministic: the same findings give the same text, numbered, with what done looks like", () => {
  const input = { inspect: inspect({ description: null }), facts: facts({ project_links: { checked: 0, ok: 0, broken: 0, blocked: 0 } }), psi: psi({ performance: 95, accessibility: 100, seo: 100, "best-practices": 100 }) };
  const a = run(input).prompt;
  const b = run(structuredClone(input)).prompt;
  assert.equal(a, b);
  assert.ok(a.startsWith("My portfolio at https://jane.dev was checked on 23 Nov 2026. Please make the changes below in its code."), a);
  const items = a.split("\n\n").slice(1);
  assert.equal(items.length, 2);
  assert.match(items[0], /^1\. Add a search description\. .* Done when it is in the page source\.$/);
  assert.match(items[1], /^2\. Link my projects\. No project links were found in a projects section on the home page and its projects page\. .* Done when at least 3 project links load\.$/);
  assert.equal(fixPrompt({ url: "https://a.dev", checkedOn: null, items: [] }), "My portfolio at https://a.dev was checked. Please make the changes below in its code. Each says what was found and what done looks like. Do not change anything else, and tell me which files you changed.\n\nNothing was found to fix.");
});

test("projects: the product's words and counting, so this page and today's profile never disagree", () => {
  const cases = [
    { checked: 5, ok: 5, broken: 0, blocked: 0 },
    { checked: 4, ok: 1, broken: 0, blocked: 3 },
    { checked: 5, ok: 2, broken: 1, blocked: 1, own_unverified: 1 },
    { checked: 0, ok: 0, broken: 0, blocked: 0, not_counted: 4 },
    { checked: 0, ok: 0, broken: 0, blocked: 0 },
    { checked: 3, ok: 3, broken: 0, blocked: 3 },
  ];
  for (const links of cases) {
    const d = card(run({ facts: facts({ project_links: links }) }), "projects").data.links;
    assert.equal([d.headline, ...d.notes.map((n) => n.replace(/\.$/, "").replace(/^./, (c) => c.toLowerCase()))].join("; "), projectLinksText(links, 4), JSON.stringify(links));
  }
  // A link behind a bot check is out of the total: 1 of 1, with the 3 named; not a fault.
  const walled = card(run({ facts: facts({ project_links: { checked: 4, ok: 1, broken: 0, blocked: 3 } }) }), "projects");
  assert.deepEqual([walled.data.links.headline, walled.data.links.notes, walled.data.links.ok, walled.data.links.bad, walled.fixes], ["1 of 1 project links load", ["3 behind a bot check."], 1, 0, 0]);
  // Found, but not in a projects section: never "No project links found" without saying the others were not counted.
  const uncounted = card(run({ facts: facts({ project_links: { checked: 0, ok: 0, broken: 0, blocked: 0, not_counted: 4 } }) }), "projects");
  assert.equal(uncounted.data.links.headline, "No project links found in a projects section");
  assert.deepEqual(uncounted.data.links.notes, ["4 other links on the page were not counted."]);
  assert.match(run({ facts: facts({ project_links: { checked: 0, ok: 0, broken: 0, blocked: 0, not_counted: 4 } }) }).prompt, /\(4 other links on the page were not counted, as they are not in a projects section\)/);
  // Enough load: passes even with one broken, as the rubric reads it.
  assert.equal(card(run({ facts: facts({ project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 } }) }), "projects").fixes, 0);
  // Too few: link more, on the home page and its projects page.
  const few = run({ facts: facts({ project_links: { checked: 2, ok: 2, broken: 0, blocked: 0 } }) });
  assert.deepEqual(few.recommendations, ["Link more projects: 2 load, and 3 is the least that counts."]);
  assert.match(few.prompt, /Only 2 project links on the home page and its projects page load\./);
  // "At least 3" is the rule only for facts of version 3 and up; older facts keep their own words.
  assert.equal(card(run({ facts: facts() }), "projects").data.links.rule, true);
  const old = card(run({ facts: facts({ v: 2, project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 } }) }), "projects");
  assert.deepEqual([old.data.links.rule, old.data.links.headline, old.fixes], [false, "3 of 4 load, 1 broken", 1]);
});

test("the claim card says only what /claim offers in the running configuration", () => {
  const tools = claimCopy({ tools: true, games: false });
  assert.match(tools.can, /re-check the site/);
  assert.match(tools.steps, /GitHub Pages site of your own account is verified at once; otherwise add a small file or one meta tag to your site and press Verify\./);
  for (const games of [false, true]) {
    const old = claimCopy({ tools: false, games });
    assert.ok(!/re-check|small file|GitHub Pages/.test(`${old.can} ${old.steps}`), "no re-check and no file with the tools off");
    assert.match(old.steps, /verified at once when the site links to your GitHub profile; otherwise add a one-line meta tag/);
    assert.equal(/re-grade/.test(old.can), games, "a re-grade only while the games are on");
  }
  // The same switches as the claim page.
  const page = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "claim", "page.tsx"), "utf8");
  assert.match(page, /if \(tools\) return <VerifyFlow/);
  assert.match(page, /regrade=\{gamesEnabled\(\)\}/);
});

test("the hourly check of a site that stops working asks the redesigned page too while it is served", async () => {
  const asked = [];
  const answers = { "/p/https%3A%2F%2Fa.dev": 404, "/p/https%3A%2F%2Fa.dev/next": 200 };
  const statusOf = async (p) => {
    asked.push(p);
    return answers[p];
  };
  assert.equal(await profileOrigin(statusOf, { next: false })("https://a.dev"), 404);
  assert.deepEqual(asked, ["/p/https%3A%2F%2Fa.dev"]);
  // The redesigned page still answers 200 from a stale copy: not settled, asked again next hour.
  assert.equal(await profileOrigin(statusOf, { next: true })("https://a.dev"), 0);
  answers["/p/https%3A%2F%2Fa.dev/next"] = 404;
  assert.equal(await profileOrigin(statusOf, { next: true })("https://a.dev"), 404);
  // The Worker uses it, and the app drops the redesigned page's own cached copies with the profile's.
  const worker = fs.readFileSync(path.join(import.meta.dirname, "..", "worker", "index.ts"), "utf8");
  assert.match(worker, /const origin = profileOrigin\(/);
  assert.match(worker, /next: profileNextEnabled\(/);
  const route = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "api", "internal", "revalidate-profiles", "route.ts"), "utf8");
  assert.match(route, /revalidatePath\("\/p\/\[slug\]\/next", "page"\)/);
});

test("helpers: days in UTC, Lighthouse states, the PageSpeed link", () => {
  assert.equal(dayOf("2026-01-05T23:59:00Z"), "5 Jan 2026");
  assert.equal(dayOf(Date.parse("2026-12-31T00:00:00Z")), "31 Dec 2026");
  assert.equal(dayOf(undefined), null);
  assert.deepEqual([95, 90, 89, 50, 49].map(scoreState), ["yes", "yes", "warn", "warn", "no"]);
  assert.equal(pageSpeedUrl("https://a.dev/x?y=1"), "https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fa.dev%2Fx%3Fy%3D1&form_factor=mobile");
});

test("the launch switch: off unless PROFILE_NEXT is exactly true (any case), and off in production", () => {
  assert.equal(profileNextEnabled({}), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "false" }), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "1" }), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "TRUE" }), true);
  const wrangler = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  assert.deepEqual([...wrangler.matchAll(/"PROFILE_NEXT":\s*"(\w+)"/g)].map((m) => m[1]), ["false"]);
});
