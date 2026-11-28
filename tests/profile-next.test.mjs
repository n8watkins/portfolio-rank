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
import { claimCopy, claimIntro } from "../lib/profile-next/claim-copy.mjs";
import { profileOrigin } from "../lib/profile-next/origin.mjs";
import { profileNextEnabled } from "../lib/profile-next/flag.ts";
import { projectLinksText } from "../pipeline/facts.mjs";
import { STALE_FOOTER_YEARS } from "../pipeline/rubric.mjs";
import { makeReading, withReading } from "../pipeline/cookie-check.mjs";

const cookieFixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cookie-check", "readings.json"), "utf8"));
/** The stored cookie reading of one fixture case (tests/fixtures/cookie-check/readings.json), as facts.privacy. */
const privacy = (name) => withReading(null, makeReading({ ...cookieFixtures[name], at: new Date("2026-11-25T12:00:00Z") }));

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

test("projects: the checked links are listed when the capture stored them, each a link that opens, with its verdict", () => {
  const rowsOf = (items) => card(run({ facts: facts({ project_links: { checked: 4, ok: 1, broken: 1, blocked: 1, own_unverified: 1, not_counted: 1, ...(items ? { items } : {}) } }) }), "projects").data.links.items;
  // A row measured before the list was stored: the counts alone, never an empty list.
  assert.equal(rowsOf(null), null);
  assert.equal(rowsOf([]), null);
  const rows = rowsOf([
    { url: "https://www.demo.dev/app/", name: "  Chess engine  ", kind: "outbound", verdict: "ok" },
    { url: "https://github.com/jane/gone", name: null, kind: "outbound", verdict: "broken" },
    { url: "https://shop.example/x", name: "Shop", kind: "outbound", verdict: "blocked" },
    { url: "https://jane.dev/projects/thin", name: "Thin", kind: "own page", verdict: "own_unverified" },
    { url: "https://docs.example/", name: "Docs", kind: "outbound", verdict: "not_counted" },
    // In no count and never requested: not listed. Nor is anything that is not a web address, or a verdict we do not know.
    { url: "http://192.168.0.4/", name: "Local", kind: "outbound", verdict: "not_checked" },
    { url: "javascript:alert(1)", name: "Bad", kind: "outbound", verdict: "ok" },
    { url: "not an address", name: "Worse", kind: "outbound", verdict: "ok" },
    { url: "https://x.example/", name: "New", kind: "outbound", verdict: "something_new" },
  ]);
  assert.deepEqual(rows, [
    { url: "https://www.demo.dev/app/", name: "Chess engine", address: "demo.dev/app", word: "Loads", st: "yes" },
    // No text on the page: the address is the name.
    { url: "https://github.com/jane/gone", name: "github.com/jane/gone", address: "github.com/jane/gone", word: "Does not load", st: "no" },
    { url: "https://shop.example/x", name: "Shop", address: "shop.example/x", word: "Behind a bot check", st: "info" },
    { url: "https://jane.dev/projects/thin", name: "Thin", address: "jane.dev/projects/thin", word: "Could not be verified", st: "warn" },
    { url: "https://docs.example/", name: "Docs", address: "docs.example", word: "Not counted", st: "info" },
  ]);
});

test("projects: a link named only with generic text is named by its address, like a link with no text", () => {
  const rowsOf = (names) =>
    card(run({ facts: facts({ project_links: { checked: names.length, ok: names.length, broken: 0, blocked: 0, items: names.map((name, i) => ({ url: `https://p${i}.example.dev/app/`, name, kind: "outbound", verdict: "ok" })) } }) }), "projects").data.links.items;
  const generic = ["View", "  view  ", "LIVE DEMO", "Visit Site →", "Demo ↗", "Click here.", "Learn more »", "Source Code", "GitHub", "Repo", "View Project  ›"];
  for (const row of rowsOf(generic)) {
    assert.equal(row.name, row.address, row.url);
    assert.match(row.address, /^p\d+\.example\.dev\/app$/);
  }
  // A real name that merely contains a generic word keeps its name.
  const kept = ["Viewfinder app", "Live chat", "Demo reel studio", "Open source tracker", "Code Quest"];
  assert.deepEqual(rowsOf(kept).map((r) => r.name), kept);
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
  // Enough load: passes even with one broken, as the rubric reads it, but never "Nothing to fix" beside a red
  // mark: the broken one is noted as information.
  const enough = card(run({ facts: facts({ project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 } }) }), "projects");
  assert.deepEqual([enough.fixes, enough.notice, enough.data.links.bad], [0, "1 link does not load", 1]);
  assert.equal(card(run({ facts: facts({ project_links: { checked: 6, ok: 4, broken: 2, blocked: 0 } }) }), "projects").notice, "2 links do not load");
  assert.equal(card(run({ facts: facts() }), "projects").notice, null, "every tested link loads: nothing noted");
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
  // The card says what /claim's own introduction says: one sentence, shared (claimIntro).
  const tools = claimCopy({ tools: true });
  assert.equal(tools.can, claimIntro(true));
  assert.match(tools.can, /re-check it, hide its grade or remove it/);
  assert.match(tools.steps, /GitHub Pages site of your own account is verified at once; otherwise add a small file or one meta tag to your site and press Verify\./);
  // The older flow: hiding the grade and removing the site need the code (the meta tag) even when the GitHub link
  // verified the claim (lib/games/claims.mjs hide_needs_meta, remove_needs_meta).
  const old = claimCopy({ tools: false });
  assert.equal(old.can, "First prove it's yours: a link to your GitHub profile on the site, or a short code you add to the page. Then, with the code, you can hide its grade or remove it.");
  assert.ok(!/re-check|small file|GitHub Pages|verified at once/.test(`${old.can} ${old.steps}`), "nothing the older flow does not offer");
  const claims = fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "games", "claims.mjs"), "utf8");
  assert.match(claims, /hide_needs_meta/);
  assert.match(claims, /remove_needs_meta/);
  // The claim page reads the same sentence and decides its flow by the same switch.
  const page = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "claim", "page.tsx"), "utf8");
  assert.match(page, /\{claimIntro\(tools\)\}/);
  assert.ok(!page.includes("First prove it's yours"), "not copied");
  assert.match(page, /if \(tools\) return <VerifyFlow/);
});

test("the hourly check of a site that stops working: the current profile decides, the redesigned page is asked and logged", async () => {
  const asked = [];
  const answers = { "/p/https%3A%2F%2Fa.dev": 404, "/p/https%3A%2F%2Fa.dev/next": 200 };
  const statusOf = async (p) => {
    asked.push(p);
    return answers[p];
  };
  const logged = [];
  const log = (line) => logged.push(line);
  assert.equal(await profileOrigin(statusOf, { next: false, log })("https://a.dev"), 404);
  assert.deepEqual(asked, ["/p/https%3A%2F%2Fa.dev"]);
  assert.deepEqual(logged, []);
  // The current profile decides: the redesigned page answering otherwise is logged, never held against the
  // site, so one broken page cannot keep it purged and reloaded every hour.
  assert.equal(await profileOrigin(statusOf, { next: true, log })("https://a.dev"), 404);
  assert.deepEqual(logged, [{ event: "profile_next.origin_disagrees", url: "https://a.dev", profile: 404, next: 200 }]);
  // An error on the redesigned page: the same.
  logged.length = 0;
  const failing = async (p) => {
    if (p.endsWith("/next")) throw new Error("boom");
    return 200;
  };
  assert.equal(await profileOrigin(failing, { next: true, log })("https://a.dev"), 200);
  assert.deepEqual(logged, [{ event: "profile_next.origin_disagrees", url: "https://a.dev", profile: 200, next: 0, error: "boom" }]);
  // They agree: nothing logged.
  logged.length = 0;
  answers["/p/https%3A%2F%2Fa.dev/next"] = 404;
  assert.equal(await profileOrigin(statusOf, { next: true, log })("https://a.dev"), 404);
  assert.deepEqual(logged, []);
  // The Worker uses it, and the app drops the redesigned page's own cached copies with the profile's.
  const worker = fs.readFileSync(path.join(import.meta.dirname, "..", "worker", "index.ts"), "utf8");
  assert.match(worker, /const origin = profileOrigin\(/);
  assert.match(worker, /next: profileNextEnabled\(/);
  assert.match(worker, /log: \(line\) => console\.log\(JSON\.stringify\(line\)\)/);
  const route = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "api", "internal", "revalidate-profiles", "route.ts"), "utf8");
  assert.match(route, /revalidatePath\("\/p\/\[slug\]\/next", "page"\)/);
});

test("tracking in Basics: none is a yes, asking first is a yes, tracking before asking is the one fix, the rest is information", () => {
  const of = (name) => run({ inspect: inspect(), facts: facts({ privacy: privacy(name) }) });
  const row = (name) => item(of(name), "tracking");
  // No reading (a capture from before the cookie check): no row, never a placeholder.
  assert.equal(item(run({ inspect: inspect(), facts: facts() }), "tracking"), undefined);

  // The owner's rule: tracking is not a fault, and a site that tracks nothing has nothing to fix.
  assert.deepEqual([row("none-plain").chip, row("none-plain").st, card(of("none-plain"), "basics").fixes], ["No tracking", "yes", 0]);
  assert.deepEqual([row("after-consent-tool").chip, row("after-consent-tool").st, card(of("after-consent-tool"), "basics").fixes], ["Asks before tracking", "yes", 0]);

  // The site's own tracking started before a choice: one fix, with the cookie check's own sentences.
  for (const name of ["no-consent-cookies", "no-consent-beacon-only", "with-banner-tracker-fires-anyway"]) {
    const r = of(name);
    assert.deepEqual([row(name).chip, row(name).st, card(r, "basics").fixes], ["Tracks before asking", "no", 1], name);
    assert.equal(r.recommendations.length, 1);
    assert.match(r.recommendations[0], /^Ask before tracking visitors: start .+ only after the visitor agrees/);
    assert.match(r.prompt, /On our visit on 25 Nov 2026 from the United States, .+ Done when no tracker runs and no tracking cookie is set until the visitor has agreed\./);
    assert.doesNotMatch(`${row(name).explain} ${r.prompt}`, /law|illegal|GDPR|complian/i, "an observation, never a legal claim");
  }
  assert.match(row("no-consent-cookies").explain, /No cookie banner offering a choice was found on the page\./);
  assert.match(row("with-banner-tracker-fires-anyway").explain, /A cookie banner was shown, but .+ had already started\./);

  // Never blamed on the site: an embed's cookies, and a consent tool that showed our visit no banner.
  for (const name of ["youtube-embed", "region-only-tool-tracks", "tool-no-banner-nothing-tracked"]) {
    assert.deepEqual([row(name).st, card(of(name), "basics").fixes], ["info", 0], name);
  }
  assert.equal(row("youtube-embed").chip, "Cookies from an embed");
});

test("helpers: days in UTC, Lighthouse states, the PageSpeed link", () => {
  assert.equal(dayOf("2026-01-05T23:59:00Z"), "5 Jan 2026");
  assert.equal(dayOf(Date.parse("2026-12-31T00:00:00Z")), "31 Dec 2026");
  assert.equal(dayOf(undefined), null);
  assert.deepEqual([95, 90, 89, 50, 49].map(scoreState), ["yes", "yes", "warn", "warn", "no"]);
  assert.equal(pageSpeedUrl("https://a.dev/x?y=1"), "https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fa.dev%2Fx%3Fy%3D1&form_factor=mobile");
});

// ---------------------------------------------------------------- First five seconds

/** One view of facts.first_five (pipeline/first-five.mjs), measured. */
const view = (at5, { intro = false, at = "2026-11-24T06:00:00.000Z" } = {}) => ({ state: "measured", at, applied: "x", at5: { atMs: 5004, words: 40, ...at5 }, later: null, intro });
const firstFive = (mobile, desktop) => ({ v: 1, mobile, desktop });
const PRARIT = firstFive(view({ biggest: "Prarit Sidana", nameHit: "prarit", way: "Explore my work" }), view({ biggest: "Prarit Sidana", nameHit: "prarit", way: "Projects" }));
/** A stored Lighthouse result with its Largest Contentful Paint (ms) and how many runs it averages. */
const lh = (lcpMs, runs = 2) => ({ ok: true, scores: { performance: 90 }, runs, metrics: [{ id: "largest-contentful-paint", label: "Largest Contentful Paint", value: `${(lcpMs / 1000).toFixed(1)} s`, numeric: lcpMs }] });
const pair = (r, id) => card(r, "first5").data.rows.find((x) => x.id === id);

test("first five seconds: the card's rows, Mobile and Desktop side by side, first among the cards", () => {
  const r = run({ inspect: inspect(), facts: facts(), firstFive: PRARIT, psi: lh(3400), psiDesktop: lh(1100) });
  const c = card(r, "first5");
  assert.equal(r.cards[0].id, "first5");
  assert.deepEqual([c.name, c.kind, c.wide, c.tally], ["First five seconds", "first5", true, false]);
  assert.equal(
    c.data.caption,
    "The first screen only, with no scrolling, read by code five seconds after the page starts loading. Mobile on a typical mobile connection, Desktop on a fast one.",
  );
  assert.deepEqual(
    c.data.rows.map((x) => [x.label, x.m.v, x.m.st, x.d.v, x.d.st]),
    [
      ["The first screen says", "“Prarit Sidana”", "info", "“Prarit Sidana”", "info"],
      ["Your name is visible", "Yes", "yes", "Yes", "yes"],
      ["A way to reach you or see your work is visible", "Yes", "yes", "Yes", "yes"],
      ["Still on an intro or loading", "No", "yes", "No", "yes"],
      ["Main content appears after", "3.4 s", "warn", "1.1 s", "yes"],
    ],
  );
  assert.equal(pair(r, "says").def, "The biggest text on screen at that moment, quoted.");
  assert.equal(pair(r, "says").m.quote, true);
  assert.equal(pair(r, "lcp").def, "From Google Lighthouse, the average of two runs. Under 2.5 seconds is good.");
  assert.deepEqual(c.data.notes, []);
  // Nothing to fix, and the card is never counted.
  assert.equal(c.fixes, 0);
  assert.deepEqual(r.recommendations, []);
  assert.equal(r.checkedOn, "24 Nov 2026", "the reading's own time counts");
});

test("first five seconds: the main content row needs a stored Lighthouse result, and says one run where it is one", () => {
  assert.equal(pair(run({ firstFive: PRARIT }), "lcp"), undefined, "no Lighthouse result: no row");
  const one = pair(run({ firstFive: PRARIT, psi: lh(2500, 1) }), "lcp");
  assert.deepEqual([one.m.v, one.m.st, one.d.v, one.d.st], ["2.5 s", "yes", "Not measured", "info"]);
  assert.equal(one.def, "From Google Lighthouse, one run. Under 2.5 seconds is good.");
  const mixed = pair(run({ firstFive: PRARIT, psi: lh(2600, 2), psiDesktop: { ...lh(900), runs: undefined } }), "lcp");
  assert.equal(mixed.def, "From Google Lighthouse (Mobile: the average of two runs; Desktop: one run). Under 2.5 seconds is good.");
  assert.equal(mixed.m.st, "warn");
  // A failed Lighthouse run is not a result.
  assert.equal(pair(run({ firstFive: PRARIT, psi: { ok: false, error: "timeout" } }), "lcp"), undefined);
});

test("first five seconds: no name and an intro on mobile are the two recommendations, after the basics", () => {
  const ff = firstFive(view({ biggest: null, nameHit: null, way: null, words: 0 }, { intro: true }), view({ biggest: "Home About Projects Resume Contact", nameHit: null, way: "Projects", words: 5 }, { intro: true }));
  const r = run({ inspect: inspect({ description: null }), facts: facts(), firstFive: ff });
  const rows = card(r, "first5").data.rows;
  assert.deepEqual(
    rows.map((x) => [x.id, x.m.v, x.m.st, x.d.v, x.d.st]),
    [
      ["says", "Nothing readable yet", "info", "“Home About Projects Resume Contact”", "info"],
      ["name", "No", "no", "No", "no"],
      ["way", "No", "no", "Yes", "yes"],
      ["intro", "Yes", "no", "Yes", "no"],
    ],
  );
  assert.deepEqual(r.recommendations, [
    'Add a search description (<meta name="description">).',
    "Show your name on the first screen on mobile.",
    "Shorten or remove the intro: on mobile the first screen is still loading after five seconds.",
  ]);
  assert.match(r.prompt, /does not show my name \(nothing readable shows there yet\)\. Put my name near the top of the hero/);
  assert.match(r.prompt, /Shorten or remove the intro\. Five seconds after loading on mobile over a slow 4G connection/);
  // The biggest text is quoted in the prompt when there is one.
  const named = run({ firstFive: firstFive(view({ biggest: "Portfolio", nameHit: null, way: "Let's talk" }), view({ biggest: "Portfolio", nameHit: "delba", way: "Let's talk" })) });
  assert.match(named.prompt, /\(the biggest text there is "Portfolio"\)/);
  assert.deepEqual(named.recommendations, ["Show your name on the first screen on mobile."]);
  // The desktop alone never makes a recommendation (the owner's list is about mobile).
  const desk = run({ firstFive: firstFive(view({ biggest: "Hi", nameHit: "jane", way: "Contact" }), view({ biggest: "Hi", nameHit: null, way: null }, { intro: true })) });
  assert.deepEqual(desk.recommendations, []);
});

test("first five seconds: a view that was not measured says so and why; with neither measured there is no card", () => {
  const failed = { state: "not-measured", reason: "the second visit was answered with HTTP 403 (challenge)", at: "2026-11-24T06:00:00.000Z", applied: "x" };
  const r = run({ firstFive: firstFive(failed, PRARIT.desktop) });
  const c = card(r, "first5");
  assert.ok(c.data.rows.every((x) => x.m.v === "Not measured" && x.m.st === "info"));
  assert.equal(pair(r, "name").d.v, "Yes");
  assert.deepEqual(c.data.notes, ["Mobile was not measured: the second visit was answered with HTTP 403 (challenge)."]);
  assert.deepEqual(r.recommendations, [], "nothing is recommended from a view that was not read");
  assert.equal(card(run({ firstFive: firstFive(failed, failed) }), "first5"), undefined);
  assert.equal(card(run({ facts: facts() }), "first5"), undefined, "facts from before the reading: no card");
  // The facts' own copy is read when no separate one is given.
  assert.ok(card(run({ facts: facts({ first_five: PRARIT }) }), "first5"));
});

test("the launch switch: off unless PROFILE_NEXT is exactly true (any case), and on in production (owner, 2026-11-26)", () => {
  assert.equal(profileNextEnabled({}), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "false" }), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "1" }), false);
  assert.equal(profileNextEnabled({ PROFILE_NEXT: "TRUE" }), true);
  const wrangler = fs.readFileSync(path.join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  assert.deepEqual([...wrangler.matchAll(/"PROFILE_NEXT":\s*"(\w+)"/g)].map((m) => m[1]), ["true"]);
});
