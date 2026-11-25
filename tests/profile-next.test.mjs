// The redesigned profile's report and its prompt (lib/profile-next/report.mjs):
// only measured facts become cards, each fact reads yes or no or its number,
// nothing unmeasured shows as a placeholder, and "What we recommend changing"
// and "Copy as a prompt" are made from exactly the findings the cards show,
// the same way every time (no model). Also the launch switch: off unless
// PROFILE_NEXT is "true", and off in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dayOf, fixPrompt, pageSpeedUrl, profileReport, scoreState } from "../lib/profile-next/report.mjs";
import { profileNextEnabled } from "../lib/profile-next/flag.ts";

const NOW = new Date("2026-11-25T12:00:00Z");
const URL_ = "https://jane.dev/";

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
  measuredAt: "2026-11-20T10:00:00Z",
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
const psi = (scores, over = {}) => ({ ok: true, scores, measuredAt: "2026-11-23T09:30:00Z", ...over });

const card = (r, id) => r.cards.find((c) => c.id === id);
const item = (r, id) => card(r, "basics").data.items.find((i) => i.id === id);

test("a site with everything in place: three cards, nothing to fix, an empty prompt list", () => {
  const r = profileReport({ url: URL_, inspect: inspect(), facts: facts(), psi: psi({ performance: 97, accessibility: 100, seo: 100, "best-practices": 96 }), now: NOW });
  assert.deepEqual(r.cards.map((c) => [c.id, c.fixes]), [["basics", 0], ["projects", 0], ["mobile", 0]]);
  assert.deepEqual(r.recommendations, []);
  assert.equal(r.checkedOn, "23 Nov 2026", "the newest measurement shown");
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

test("no score and no points: presence checks read yes or no, measured things their number", () => {
  const r = profileReport({ url: URL_, inspect: inspect(), facts: facts(), psi: psi({ performance: 71, accessibility: 92, seo: 100, "best-practices": 96 }), now: NOW });
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
  assert.deepEqual(profileReport({ url: URL_, now: NOW }).cards, []);
  assert.equal(profileReport({ url: URL_, now: NOW }).checkedOn, null);
  // A failed Lighthouse run and a failed polish check count as not measured.
  const unread = facts();
  delete unread.footer_year;
  const r = profileReport({ url: URL_, inspect: { ok: false, error: "unreachable" }, facts: unread, psi: { ok: false, error: "timeout" }, now: NOW });
  assert.deepEqual(r.cards.map((c) => c.id), ["basics", "projects"]);
  // From the capture alone: resume, contact and the domain; no share image or description (only the polish check
  // reads them), and no footer year (never read).
  assert.deepEqual(card(r, "basics").data.items.map((i) => i.id), ["resume", "contact", "domain"]);
  // A footer read with no year in it is measured: "Not shown", which is not a fault.
  const noYear = profileReport({ url: URL_, facts: facts({ footer_year: null }), now: NOW });
  assert.deepEqual([item(noYear, "year").value, item(noYear, "year").st, card(noYear, "basics").fixes], ["Not shown", "info", 0]);
  // Without project links or a builder, no Projects card.
  const noProjects = profileReport({ url: URL_, inspect: inspect(), facts: facts({ project_links: null }), now: NOW });
  assert.equal(card(noProjects, "projects"), undefined);
  // "Built with" only when a builder was recognised.
  assert.equal(card(profileReport({ url: URL_, facts: facts() }), "projects").data.builtWith, null);
  assert.equal(card(profileReport({ url: URL_, facts: facts({ builder: "Framer" }) }), "projects").data.builtWith, "Framer");
});

test("findings: each fact that falls short is one thing to fix, and one recommendation, in card order", () => {
  const r = profileReport({
    url: URL_,
    inspect: inspect({ githubUrl: null, hasGithubLink: false, description: null, ogImage: null, ogImageLoads: false, customDomain: false, finalUrl: "https://jane.vercel.app/" }),
    facts: facts({ github: false, resume: false, contact: false, footer_year: 2021, project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 } }),
    psi: psi({ performance: 48, accessibility: 88, seo: 100, "best-practices": 96 }),
    now: NOW,
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
    "Fix or remove the project link that does not load.",
    "Speed up the page on mobile: Lighthouse gives it 48 of 100.",
    "Raise accessibility on mobile: Lighthouse gives it 88 of 100.",
  ]);
});

test("the prompt is deterministic: the same findings give the same text, numbered, with what done looks like", () => {
  const input = { url: URL_, inspect: inspect({ description: null }), facts: facts({ project_links: { checked: 0, ok: 0, broken: 0, blocked: 0 } }), psi: psi({ performance: 95, accessibility: 100, seo: 100, "best-practices": 100 }), now: NOW };
  const a = profileReport(input).prompt;
  const b = profileReport(structuredClone(input)).prompt;
  assert.equal(a, b);
  assert.ok(a.startsWith("My portfolio at https://jane.dev was checked on 23 Nov 2026. Please make the changes below in its code."), a);
  const items = a.split("\n\n").slice(1);
  assert.equal(items.length, 2);
  assert.match(items[0], /^1\. Add a search description\. .* Done when it is in the page source\.$/);
  assert.match(items[1], /^2\. Link my projects\. .* Done when at least 3 project links load\.$/);
  assert.equal(fixPrompt({ url: "https://a.dev", checkedOn: null, items: [] }), "My portfolio at https://a.dev was checked. Please make the changes below in its code. Each says what was found and what done looks like. Do not change anything else, and tell me which files you changed.\n\nNothing was found to fix.");
});

test("projects: counts as measured, a link wall is not a fault, too few links is", () => {
  const blocked = profileReport({ url: URL_, facts: facts({ project_links: { checked: 4, ok: 1, broken: 0, blocked: 3 } }) });
  assert.deepEqual(card(blocked, "projects").data.links, { checked: 4, ok: 1, broken: 0, blocked: 3, pass: null, min: 3 });
  assert.equal(card(blocked, "projects").fixes, 0, "blocked links might load: not counted against the site");
  const few = profileReport({ url: URL_, facts: facts({ project_links: { checked: 2, ok: 2, broken: 0, blocked: 0 } }) });
  assert.deepEqual(few.recommendations, ["Link more projects: 2 load, and 3 is the least that counts."]);
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
