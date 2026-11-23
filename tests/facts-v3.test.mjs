// Measuring version 3 (pipeline/facts.mjs FACTS_VERSION): project links are
// picked from the projects first and pass when at least three load, the
// footer year is read on either side of the mark, and the phone view's
// reading is merged into the desktop's. The fixtures are the rendered pages
// of three listed sites as a capture read them on 2026-11-22, cut down to
// their markup (no scripts, styles or images) with emails and phone numbers
// replaced. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FACTS_VERSION, MIN_PROJECT_LINKS, footerYear, isErrorPage, measureFacts, measurePage, mergeViews, pageLinks, projectLinkCandidates, projectLinksPass, projectLinksShare, projectLinksText } from "../pipeline/facts.mjs";
import { scanPage } from "../pipeline/page-controls.mjs";
import { codeChecks } from "../pipeline/rubric.mjs";
import { checkPoints, checkShares, libraryMedians } from "../lib/check-points.mjs";
import { factLines, strengthsAndFixes } from "../lib/grader/report.mjs";
import { checklistItems } from "../lib/tools/checklist.ts";

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "facts", name), "utf8");
const candidates = (html, url) => projectLinkCandidates(pageLinks(html, url), url);
/** A fetch that answers every link with `status` (or per URL), counting the requests. */
const fakeFetch = (status = 200) => {
  const seen = [];
  const f = async (url) => {
    seen.push(String(url));
    return { status: typeof status === "function" ? status(String(url)) : status, body: null };
  };
  f.seen = seen;
  return f;
};

test("the measuring version is 3, and the whole-list re-measure skips by it", () => {
  assert.equal(FACTS_VERSION, 3);
  assert.equal(MIN_PROJECT_LINKS, 3);
  const wf = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "remeasure-all.yml"), "utf8");
  assert.match(wf, new RegExp(`skip_version:[\\s\\S]*?default: "${FACTS_VERSION}"`));
  assert.equal([...wf.matchAll(/SKIP_VERSION:-(\d+)/g)].every((m) => Number(m[1]) === FACTS_VERSION), true);
});

test("yashitanamdeo.github.io: the projects are checked, not the school and employers named before them", () => {
  const url = "https://yashitanamdeo.github.io/";
  const got = candidates(fixture("yashitanamdeo.github.io.html"), url);
  assert.equal(got.length, 8);
  // The featured projects' repositories and demos first, in page order.
  assert.deepEqual(got.slice(0, 7), [
    "https://github.com/yashitanamdeo/face-landmark-detection",
    "https://www.pyimagesearch.com/2020/05/04/covid-19-face-mask-detector-with-opencv-keras-tensorflow-and-deep-learning/",
    "https://github.com/yashitanamdeo/Realtime-Face-Mask-Detection",
    "https://disney-clone-83e44.web.app/",
    "https://github.com/yashitanamdeo/Disney-plus-Clone",
    "https://covid19-tracker-84ef4.web.app/",
    "https://github.com/yashitanamdeo/Covid19-tracker",
  ]);
  // The about section's university, club and the experience section's employers (main checked these first) come
  // only after every project link: here the university takes the last free slot. Its face-landmark demo page on
  // the same host is not under a listing path ("/projects/..."), so it is not counted as one of its own project pages.
  assert.deepEqual(got.slice(7), ["https://www.svvv.edu.in/"]);
  for (const notProject of ["https://www.internationalmun.org/", "https://internship.suvenconsultants.com/", "https://www.theforage.com/"]) {
    assert.ok(!got.includes(notProject), notProject);
  }
});

test("yeabsiras-portfolio.vercel.app: 3 dead client sites of 8 still pass, and the result says 5 of 8", () => {
  const url = "https://yeabsiras-portfolio.vercel.app/";
  const got = candidates(fixture("yeabsiras-portfolio.vercel.app.html"), url);
  assert.deepEqual(got, [
    "https://ideeza.com/",
    "https://tigat.net/",
    "https://www.betterlink.ca/",
    "https://bike-sharing-web.vercel.app/",
    "https://humblecoffeewa.com/",
    "https://whalerapp.com/",
    "https://nileode.com/",
    "https://lalibelahoney.com/",
  ]);
  const links = { checked: 8, ok: 5, broken: 3, blocked: 0 };
  const facts = { v: 3, project_links: links };
  assert.equal(codeChecks(facts).project_links, true, "main failed it for one dead link");
  assert.equal(projectLinksText(links, 3), "5 of 8 project links load");
  const pts = checkPoints(checkShares({ grade: { facts } }), libraryMedians([]));
  assert.equal(pts.items.find((i) => i.id === "projects").points, 15, "full points: the points and the pass agree");
  const line = factLines({ checks: codeChecks(facts), facts }).find((l) => l.id === "project_links");
  assert.deepEqual([line.pass, line.detail, line.shownAs], [true, "5 of 8 project links load", "5 of 8 project links load"]);
});

test("facts of version 1 and 2 keep the old rule and the old words everywhere, so nothing flips before the re-measure", () => {
  const links = { checked: 8, ok: 5, broken: 3, blocked: 0 };
  for (const v of [undefined, 1, 2]) {
    const facts = { v, project_links: links };
    assert.equal(projectLinksPass(links, v), false, `v${v}: one broken link failed it`);
    assert.equal(codeChecks(facts).project_links, false);
    // The points under the old rule: the loading share times checked / 3 (5 of 8: 9.4 of 15).
    const pts = checkPoints(checkShares({ grade: { facts } }), libraryMedians([]));
    assert.equal(pts.items.find((i) => i.id === "projects").points, 9.4);
    assert.equal(projectLinksText(links, v), "5 of 8 load, 3 broken");
    const line = factLines({ checks: codeChecks(facts), facts }).find((l) => l.id === "project_links");
    assert.deepEqual([line.detail, line.shownAs], ["5 of 8 load, 3 broken", "Project links load"], "the label, not 'N of M project links load'");
    assert.equal(strengthsAndFixes({ checks: codeChecks(facts), facts }).fixes.find((f) => f.criterion === "project_links").title, "Fix broken project links");
    const row = checklistItems({ ok: true, facts, checks: codeChecks(facts) }).find((r) => r.id === "project_links");
    assert.equal(row.found, "8 checked, 3 broken");
  }
  assert.equal(projectLinksText({ checked: 0, ok: 0, broken: 0, blocked: 0 }, 2), "No project links to check");
  // The same links under version 3: a pass, full points, the new words and fix.
  const v3 = { v: 3, project_links: links };
  assert.equal(codeChecks(v3).project_links, true);
  assert.equal(strengthsAndFixes({ checks: { project_links: false }, facts: v3 }).fixes.find((f) => f.criterion === "project_links").title, "Link at least 3 projects that load");
});

test("a site's own pages supply at most 2 of the 3: a host that answers every address cannot pass on them alone", () => {
  // Three own pages that load, nothing elsewhere: two thirds, a fail.
  assert.equal(projectLinksShare({ checked: 3, ok: 3, broken: 0, blocked: 0, own_ok: 3 }, 3), 2 / 3);
  assert.equal(projectLinksPass({ checked: 8, ok: 8, broken: 0, blocked: 0, own_ok: 8 }, 3), false);
  // Two own pages and one outbound link that loads: a pass.
  assert.equal(projectLinksPass({ checked: 3, ok: 3, broken: 0, blocked: 0, own_ok: 2 }, 3), true);
  assert.equal(projectLinksPass({ checked: 4, ok: 3, broken: 1, blocked: 0, own_ok: 3 }, 3), false);
});

test("a link behind a bot check is neither loading nor broken: left out of the count, unknown when it could decide", () => {
  // 2 load and 1 behind a bot check: it could have been the third, so the check is unknown (no fail, no points of its own).
  assert.equal(projectLinksShare({ checked: 3, ok: 2, broken: 0, blocked: 1 }, 3), null);
  assert.equal(projectLinksPass({ checked: 3, ok: 2, broken: 0, blocked: 1 }, 3), null);
  assert.equal(projectLinksText({ checked: 3, ok: 2, broken: 0, blocked: 1 }, 3), "2 of 2 project links load; 1 behind a bot check");
  // 3 load and 1 behind a bot check: a pass; 1 load, 1 broken, 1 behind a bot check: still short, a fail.
  assert.equal(projectLinksPass({ checked: 4, ok: 3, broken: 0, blocked: 1 }, 3), true);
  assert.equal(projectLinksShare({ checked: 3, ok: 1, broken: 1, blocked: 1 }, 3), 1 / 3);
  assert.equal(projectLinksText({ checked: 3, ok: 1, broken: 1, blocked: 1 }, 3), "1 of 2 project links load; 1 behind a bot check");
  assert.equal(projectLinksText({ checked: 2, ok: 0, broken: 0, blocked: 2 }, 3), "Project links: 2 behind a bot check");
});

test("one or two project links that load: a third or two thirds of the points, and the check fails; none found fails with nothing", () => {
  const share = (ok, checked) => projectLinksShare({ checked, ok, broken: checked - ok, blocked: 0 }, 3);
  assert.equal(share(1, 1), 1 / 3);
  assert.equal(share(2, 2), 2 / 3);
  assert.equal(share(2, 8), 2 / 3);
  assert.equal(share(3, 3), 1);
  assert.equal(share(0, 0), 0);
  for (const [ok, checked, pass] of [[1, 1, false], [2, 5, false], [3, 8, true], [0, 0, false]]) {
    assert.equal(codeChecks({ v: 3, project_links: { checked, ok, broken: checked - ok, blocked: 0 } }).project_links, pass, `${ok} of ${checked}`);
  }
  assert.equal(projectLinksText({ checked: 0, ok: 0, broken: 0, blocked: 0 }, 3), "Project links: none found");
  assert.equal(projectLinksText({ checked: 2, ok: 1, broken: 1, blocked: 0 }, 3), "1 of 2 project links load");
  // Never checked, or every link behind a bot check: unknown, left out, never a fail.
  assert.equal(projectLinksText(null, 3), null);
  assert.equal(projectLinksShare({ checked: 3, ok: 0, broken: 0, blocked: 3 }, 3), null);
  assert.equal(codeChecks({ v: 3, project_links: { checked: 3, ok: 0, broken: 0, blocked: 3 } }).project_links, null);
  assert.equal(codeChecks({ v: 3, project_links: null }).project_links, null);
  // The free checklist says the same.
  const row = checklistItems({ ok: true, facts: { v: 3, project_links: { checked: 4, ok: 2, broken: 2, blocked: 0 } }, checks: { project_links: false } }).find((r) => r.id === "project_links");
  assert.deepEqual([row.pass, row.found], [false, "2 of 4 project links load"]);
});

test("project candidates: a projects section or heading first, GitHub repositories next to them, the rest after; work experience is not projects", () => {
  const url = "https://ana.dev/";
  const html = `
    <header><nav><a href="https://github.com/ana/site-source">Source</a></nav></header>
    <section id="experience"><h2>Work experience</h2><a href="https://employer.example/">Employer</a></section>
    <section class="work-history"><a href="https://old-job.example/">Old job</a></section>
    <div><h2>Things I've built</h2><ul><li><a href="https://demo-one.example/">One</a></li></ul></div>
    <div class="project-card"><a href="https://demo-two.example/">Two</a></div>
    <p>My <a href="https://github.com/ana/tool">tool</a> on GitHub.</p>
    <footer><a href="https://github.com/bchiang7/v4">Designed by Brittany Chiang</a></footer>`;
  assert.deepEqual(candidates(html, url), [
    "https://demo-one.example/",
    "https://demo-two.example/",
    "https://github.com/ana/tool",
    "https://github.com/ana/site-source",
    "https://employer.example/",
    "https://old-job.example/",
    "https://github.com/bchiang7/v4",
  ]);
  const links = scanPage(html, url).links;
  assert.deepEqual(links.filter((l) => l.inProjects).map((l) => l.href), ["https://demo-one.example/", "https://demo-two.example/"]);
  assert.deepEqual(links.filter((l) => l.inChrome).map((l) => l.href), ["https://github.com/ana/site-source", "https://github.com/bchiang7/v4"]);
  // At most eight, projects kept first.
  const many = `<a href="https://x1.example/">x</a><a href="https://x2.example/">x</a>${Array.from({ length: 9 }, (_, i) => `<section id="projects"><a href="https://p${i}.example/">p</a></section>`).join("")}`;
  const got = candidates(many, url);
  assert.equal(got.length, 8);
  assert.ok(got.every((u) => /^https:\/\/p\d\./.test(u)));
});

test("profiles never fill a project-link slot: freelancing, link lists, coding, film and book sites, a CodePen profile", () => {
  const url = "https://ana.dev/";
  const html = ["https://www.upwork.com/freelancers/~01", "https://www.fiverr.com/ana", "https://linktr.ee/ana", "https://www.kaggle.com/ana", "https://www.imdb.com/name/nm1/", "https://goodreads.com/ana", "https://codepen.io/ana", "https://codepen.io/ana/pen/abc", "https://demo.example/"]
    .map((h) => `<a href="${h}">x</a>`)
    .join("");
  assert.deepEqual(candidates(html, url), ["https://codepen.io/ana/pen/abc", "https://demo.example/"]);
  // A "find me" list (stimmie.dev keeps 26 profiles there) and a "Let's connect" block are profiles, whatever their hosts.
  const lists = `<section><h2>~ find me ~</h2><a href="https://oeis.org/wiki/User:Ana">OEIS</a><a href="https://www.strava.com/athletes/1">Strava</a></section>
    <div class="socials"><a href="https://last.fm/user/ana">Last.fm</a></div>
    <section><h2>Let's connect</h2><a href="https://github.com/ana/dotfiles">dotfiles</a></section>
    <section><h2>~ stimmieverse ~</h2><a href="https://room.ana.dev/">Room</a></section>`;
  assert.deepEqual(candidates(lists, url), ["https://github.com/ana/dotfiles", "https://room.ana.dev/"]);
});

test("footer year: the mark before or after the year, ranges, never a bare year", () => {
  const now = new Date("2026-11-22T00:00:00Z");
  const cases = [
    ["2026 © Edition", 2026],
    ["2020 - 2026 © Ana", 2026],
    ["2019–2025 (c) Ana", 2025],
    ["2024 Copyright Ana", 2024],
    ["© 2026 Ana", 2026],
    ["&copy; 2023", 2023],
    ["Copyright 2021-2025", 2025],
    ["(c) 2022", 2022],
    ["Built in 2026 with care", null],
    ["2026", null],
    ["© 2031", null],
    ["Founded 2019 © 2025 Ana", 2025],
    // The year before the mark only where it opens a footer line, with only spaces before the mark.
    ["©\n2026 © Edition", 2026],
    ["Home | 2025 © Ana", 2025],
    ["Building websites since 2019 © All rights reserved", null],
    ["Graduated 2018\n© Jane Doe. All rights reserved.", null],
    ["Call +1 555 2019 © Jane", null],
    ["Experience\nAcme 2021 - 2023\n© Jane Doe", null],
    ["Last updated November 2024 © Jane", null],
  ];
  for (const [text, want] of cases) assert.equal(footerYear(text, now), want, JSON.stringify(text));
  // Read from the HTML, block elements end lines, as a browser lays them out (/api/inspect reads it so too).
  const html = `<footer><p>Graduated 2018</p><p>© Jane Doe</p></footer>`;
  assert.equal(measureFacts({ html, url: "https://ana.dev" }).footer_year, null);
  assert.equal(measureFacts({ html: `<footer><span>2026</span> © Ana</footer>`, url: "https://ana.dev" }).footer_year, 2026, "spaces before the year on its line are fine");
  assert.equal(measureFacts({ html: `<footer><p>Since <span>2019</span> © Ana</p></footer>`, url: "https://ana.dev" }).footer_year, null);
  assert.equal(measureFacts({ html: `<footer><p>2026 © Ana</p></footer>`, url: "https://ana.dev" }).footer_year, 2026);
});

test("a phone reading that is a host's error or placeholder page adds nothing", async () => {
  const url = "https://ana.dev/";
  const desktopHtml = `<main><h1>Ana</h1><p>Developer</p></main>`;
  const gh404 = `<h1>404</h1><p>There isn't a GitHub Pages site here.</p><a href="https://github.com/ana">ana</a><a href="https://help.github.com/pages/">Read the docs</a><a href="mailto:support@github.com">Contact support</a>`;
  assert.equal(isErrorPage({ html: gh404 }), true);
  assert.equal(isErrorPage({ html: `<h1>This domain is for sale</h1>` }), true, "a parked page");
  assert.equal(isErrorPage({ html: desktopHtml }), false);
  const desktop = measureFacts({ html: desktopHtml, url });
  const phone = measureFacts({ html: gh404, url });
  assert.equal(phone.error_page, true);
  assert.equal(mergeViews(desktop, phone), desktop);
  const f = await measurePage({ html: desktopHtml, text: "", url, phone: { html: gh404, text: "" } }, { fetchImpl: fakeFetch(200) });
  assert.deepEqual(f.views, ["desktop"]);
  assert.equal(f.github, false);
  assert.equal(f.contact, false);
  assert.equal(f.project_links.checked, 0, "its links are not candidates either");
});

test("krishnananda.netlify.app: the projects in the desktop's inactive tab are found in the phone view", async () => {
  const url = "https://krishnananda.netlify.app";
  const desktop = fixture("krishnananda.netlify.app.desktop.html");
  const phone = fixture("krishnananda.netlify.app.phone.html");
  assert.deepEqual(candidates(desktop, url), [], "desktop: the Works tab is not in the DOM");
  const fetchImpl = fakeFetch(200);
  const desktopOnly = await measurePage({ html: desktop, text: "", url, finalUrl: `${url}/` }, { fetchImpl });
  assert.equal(desktopOnly.project_links.checked, 0);
  assert.deepEqual(desktopOnly.views, ["desktop"]);
  const both = await measurePage({ html: desktop, text: "", url, finalUrl: `${url}/`, phone: { html: phone, text: "", finalUrl: `${url}/` } }, { fetchImpl });
  assert.deepEqual(both.views, ["desktop", "phone"]);
  assert.deepEqual(both.project_links, { checked: 8, ok: 8, broken: 0, blocked: 0, own_ok: 0 });
  assert.equal(codeChecks(both).project_links, true);
  assert.equal(both.v, FACTS_VERSION);
});

test("the phone view merges in: yes when either view has it, the higher footer year, the desktop's own facts kept", async () => {
  const url = "https://ana.dev";
  const desktopHtml = `<main><h1>Ana</h1><a href="https://github.com/ana">GitHub</a><section id="projects"><a href="https://one.example/">One</a></section></main><footer>© 2024 Ana</footer>`;
  const phoneHtml = `<main><h1>Ana</h1><button aria-label="View Resume">CV</button><section id="projects"><a href="https://one.example/">One</a><a href="https://two.example/">Two</a></section></main><footer>2020 - 2026 © Ana</footer>`;
  const d = measureFacts({ html: desktopHtml, url });
  const p = measureFacts({ html: phoneHtml, url });
  const m = mergeViews(d, p);
  assert.deepEqual([d.resume, p.resume, m.resume], [false, true, true]);
  assert.deepEqual([d.github, p.github, m.github], [true, false, true]);
  assert.deepEqual([d.footer_year, p.footer_year, m.footer_year], [2024, 2026, 2026]);
  assert.equal(m.signals.resume, true);
  assert.equal(m.signals.github, true);
  assert.equal(m.signals.score, Object.entries(m.signals).filter(([k, v]) => k !== "score" && v === true).length);
  assert.equal(m.final_url, d.final_url);
  assert.equal(mergeViews(d, null), d);
  // The link candidates of both views, once each, the desktop's first.
  const fetchImpl = fakeFetch(200);
  const f = await measurePage({ html: desktopHtml, text: "", url, phone: { html: phoneHtml, text: "" } }, { fetchImpl });
  assert.deepEqual(fetchImpl.seen.map((u) => u.replace(/\/$/, "")).sort(), ["https://one.example", "https://two.example"]);
  assert.equal(f.project_links.checked, 2);
  assert.equal(f.footer_year, 2026);
});

test("a phone view that is blocked or unreadable never blanks the desktop facts", async () => {
  const url = "https://ana.dev";
  const html = `<a href="https://github.com/ana">GitHub</a><a href="mailto:a@b.c">Mail</a><section id="projects"><a href="https://one.example/">One</a></section><footer>© 2026</footer>`;
  const fetchImpl = fakeFetch(200);
  const alone = await measurePage({ html, text: "", url }, { fetchImpl });
  for (const phone of [null, { html: "", text: "" }, { html: "   ", text: "" }]) {
    const f = await measurePage({ html, text: "", url, phone }, { fetchImpl });
    assert.deepEqual(f.views, ["desktop"]);
    for (const k of ["resume", "github", "contact", "footer_year", "project_links", "signals"]) assert.deepEqual(f[k], alone[k], k);
  }
  // A bot check page as the phone reading only adds what it has: nothing is taken away.
  const wall = await measurePage({ html, text: "", url, phone: { html: "<h1>Verify you are human</h1>", text: "Verify you are human" } }, { fetchImpl });
  for (const k of ["github", "contact", "footer_year"]) assert.deepEqual(wall[k], alone[k], k);
  assert.deepEqual(wall.project_links, alone.project_links);
});
