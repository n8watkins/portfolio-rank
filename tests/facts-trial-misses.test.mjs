// Measuring version 4 (pipeline/facts.mjs FACTS_VERSION): the five project-link
// misses of the production trial of version 3 on 25 sites (2026-11-23), each in
// both directions. The fixtures are the pages as the capture read them on
// 2026-11-23, cut down to their markup (no scripts, styles, drawings or images)
// with emails and phone numbers replaced. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  FACTS_VERSION,
  OWN_PAGE_MIN_WORDS,
  PER_HOST_MAX,
  checkLinks,
  hashRoute,
  homeProjectLinks,
  hostKey,
  measurePage,
  newProjectRule,
  pageLinks,
  projectCandidates,
  projectLinksPass,
  projectLinksText,
  projectsPageFor,
  saysNotFound,
  textLines,
} from "../pipeline/facts.mjs";

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "facts", name), "utf8");
/** The candidates from a home page and the projects page the capture read, as measurePage gathers them. */
const fromPages = ({ home, homeHtml = "", page, pageHtml }) => {
  const links = homeProjectLinks({ html: homeHtml, url: home, finalUrl: home });
  links.push(...pageLinks(pageHtml, page).map((l) => ({ ...l, from: "projects_page", page })));
  return projectCandidates(links, home);
};
/** A fake host: `pages` maps a path to [status, html]; anything else answers `other`. Records what was asked. */
const fakeHost = (pages, other) => {
  const asked = [];
  const f = async (url, init) => {
    asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    const [status, html] = pages[new URL(url).pathname] ?? other;
    return new Response(init?.method === "HEAD" ? null : html, { status, headers: { "content-type": "text/html" } });
  };
  f.asked = asked;
  return f;
};

test("version 4 is read by the version 3 project-link rule, words and points", () => {
  assert.equal(FACTS_VERSION, 4);
  assert.equal(newProjectRule(4), true);
  const links = { checked: 8, ok: 5, broken: 3, blocked: 0 };
  assert.equal(projectLinksText(links, 4), projectLinksText(links, 3));
  assert.equal(projectLinksPass(links, 4), projectLinksPass(links, 3));
});

// 1. bhavaniravi.com answers a made-up address with its home page, and every page carries the same menu of
// several hundred words: its project pages were 97% the same words as the nonsense page.
const BH_NONSENSE = fixture("bhavaniravi.com.nonsense.html");
const BH_PROJECT = fixture("bhavaniravi.com.analyza.html");
// The stored home text: the same page as the nonsense one, line by line.
const BH_HOME_TEXT = textLines(BH_NONSENSE).join("\n");
const bh = (pages) => fakeHost(pages, [200, BH_NONSENSE]);
const ownPages = (paths) => paths.map((p) => ({ url: `https://bhavaniravi.com${p}`, kind: "own page", tier: 2 }));

test("bhavaniravi.com: a real project page under the same long menu loads, judged by the text it does not share", async () => {
  const pages = { "/projects/analyza": [200, BH_PROJECT] };
  // A second real page: the same write-up for another project (other words of its own).
  pages["/projects/interviewbot"] = [200, BH_PROJECT.replace(/Analyza/g, "Interviewbot").replace(/An application that converts plain english to SQL queries, inspired by Google&#39;s Analyza research\./, "A chatbot that automates technical screening, enabling recruiters to filter applicants before a formal interview round.")];
  const r = await checkLinks(ownPages(["/projects/analyza", "/projects/interviewbot"]), { fetchImpl: bh(pages), homeText: BH_HOME_TEXT });
  assert.equal(r.own_check, "text", "the host answers a made-up address with 200");
  assert.deepEqual([r.ok, r.own_ok, r.own_unverified], [2, 2, 0]);
});

test("bhavaniravi.com's host: the home page again, an empty page and a thin page still do not count", async () => {
  const thin = BH_NONSENSE.replace("</main>", "<h1>Analyza</h1><p>A tool for queries.</p></main>");
  assert.notEqual(thin, BH_NONSENSE, "the thin page has its own line");
  const pages = { "/projects/same": [200, BH_NONSENSE], "/projects/empty": [200, ""], "/projects/thin": [200, thin], "/projects/shell": [200, "<div id=root></div>"] };
  const r = await checkLinks(ownPages(Object.keys(pages)), { fetchImpl: bh(pages), homeText: BH_HOME_TEXT });
  assert.deepEqual([r.ok, r.own_unverified], [0, 4]);
  assert.equal(projectLinksPass(r, 4), false);
  // The threshold: a page needs OWN_PAGE_MIN_WORDS distinct words of its own.
  const words = (n) => Array.from({ length: n }, (_, i) => `ownword${i}`).join(" ");
  const at = await checkLinks(ownPages(["/projects/a", "/projects/b"]), {
    fetchImpl: bh({ "/projects/a": [200, `${BH_NONSENSE}<p>${words(OWN_PAGE_MIN_WORDS)}</p>`], "/projects/b": [200, `${BH_NONSENSE}<p>${words(OWN_PAGE_MIN_WORDS - 1)}</p>`] }),
    homeText: BH_HOME_TEXT,
  });
  assert.deepEqual([at.ok, at.own_unverified], [1, 1]);
});

test("own pages on a host that answers 404 for nonsense still count by their status, with no text read", async () => {
  const f = fakeHost({ "/projects/analyza": [200, BH_PROJECT] }, [404, "<h1>Not found</h1>"]);
  const r = await checkLinks(ownPages(["/projects/analyza"]), { fetchImpl: f, homeText: BH_HOME_TEXT });
  assert.deepEqual([r.ok, r.own_check], [1, "status"]);
});

test("bhavaniravi.com: its projects page's 8 own project pages are the candidates, and none of its menu", () => {
  const got = fromPages({ home: "https://bhavaniravi.com/", page: "https://bhavaniravi.com/projects/", pageHtml: fixture("bhavaniravi.com.projects.html") });
  assert.equal(got.length, 8);
  assert.ok(got.every((c) => c.kind === "own page" && c.url.startsWith("https://bhavaniravi.com/projects/")), JSON.stringify(got));
});

// 2. amanhimself.dev's projects page links its own apps at the top level of the site.
const AMAN = { home: "https://amanhimself.dev/", homeHtml: fixture("amanhimself.dev.home.html"), page: "https://amanhimself.dev/projects/", pageHtml: fixture("amanhimself.dev.projects.html") };

test("amanhimself.dev: the apps its projects page links at the top of the site are its own project pages", () => {
  const got = fromPages(AMAN);
  assert.deepEqual(
    got.filter((c) => c.tier <= 2).map((c) => c.url),
    [
      "https://github.com/amandeepmittal/react-native-examples",
      "https://github.com/amandeepmittal/mobilenet-tfjs-expo",
      "https://amanhimself.dev/rht",
      "https://amanhimself.dev/lasttimei",
      "https://amanhimself.dev/skillsbar",
    ]
  );
  // Its index of other pages ("/slash/", "Slashes a.k.a. Other pages") is a section of the site, not a project.
  assert.ok(!got.some((c) => c.url.includes("/slash")));
});

/** A projects page: its cards (each a title link and a line), then `rest` in the same main content. */
const cardsPage = (rest = "") => `<nav><a href="/menu-app">Menu</a></nav><main><h1>Projects</h1>
  <div class="grid">
    <div class="card"><a href="/tracker"><h3>Tracker</h3></a><p>Habits, streaks and reminders.</p></div>
    <div class="card"><a href="/apps/budget"><h3>Budget</h3></a><p>A budget for two.</p></div>
    <div class="card"><a href="/notes-app.html"><h3>Notes app</h3></a><p>Notes that sync.</p></div>
    <div class="card"><a href="/ai-chat"><h3>AI chat</h3></a><p>Chat with your files.</p></div>
    <div class="card"><a href="/go-cli"><h3>go-cli</h3></a><p>A CLI in Go.</p></div>
  </div>${rest}</main>`;
const PROJECTS_ONLY = ["https://ana.dev/tracker", "https://ana.dev/apps/budget", "https://ana.dev/notes-app.html", "https://ana.dev/ai-chat", "https://ana.dev/go-cli"];
const ownOf = (html) => fromPages({ home: "https://ana.dev/", page: "https://ana.dev/projects", pageHtml: html }).map((c) => c.url);

test("on the projects page, a same-site link to a section of the site, a language, a year or a page number is not a project", () => {
  // Each in the main content, written as real pages write them.
  const sections = [
    `<p>Read more <a href="/about">about me</a> or the <a href="/blog/how-i-built-it">story of the tracker</a>.</p>`,
    `<div class="tags"><a href="/tags/react">#react</a> <a href="/topics/react">React</a> <a href="/series/rust">Rust series</a> <a href="/categories/web">Web</a></div>`,
    `<p><a href="/uses">What I use</a> · <a href="/now">What I'm doing now</a> · <a href="/en">EN</a> <a href="/pt-br">PT</a> <a href="/zh-hans/projects">中文</a></p>`,
    `<p>Posted in <a href="/2024/05/launch">May 2024</a>. Also: <a href="/resume">my resume</a>, <a href="/work">all work</a>.</p>`,
    `<div class="pagination"><a href="/projects/page/2">2</a> <a href="/projects/2">3</a> <a href="/projects?page=4">4</a> <a href="/archive/older">Older posts →</a></div>`,
    `<p><a href="/privacy-policy">Privacy</a> <a href="/impressum">Impressum</a> <a href="/datenschutz">Datenschutz</a> <a href="/logout">Sign out</a> <a href="/search?q=x">Search</a></p>`,
    `<p>Also see <a href="/achievements">what I achieved</a>, <a href="/certifications">my certificates</a>, <a href="/awards">awards</a>, <a href="/publications">papers</a>, <a href="/research">research</a>, <a href="/stack">my stack</a>, <a href="/tools">tools</a>, <a href="/resources">resources</a>, <a href="/journey">my journey</a>, <a href="/timeline">timeline</a>, <a href="/authors/ana">Ana</a>.</p>`,
    `<p><a href="/contacto">Escríbeme</a> <a href="/sobre-mi">Quién soy</a> <a href="/kontakt">Schreib mir</a> <a href="/a-propos">Qui suis-je</a> <a href="/ueber-mich">Wer ich bin</a></p>`,
    `<aside class="tools"><a href="/stack-tool">Tool</a></aside>`,
  ].join("\n");
  assert.deepEqual(ownOf(cardsPage(sections)), PROJECTS_ONLY);
});

test("on the projects page, a menu built from divs, a call-to-action band and a 'next project' link are not projects", () => {
  // A navbar of divs, not a <nav>: it links the home page and the projects page itself, so it is a menu.
  const divMenu = `<div class="navbar"><div class="nav-item"><a href="/">Home</a></div><div class="nav-item"><a href="/projects">Projects</a></div>
    <div class="nav-item"><a href="/achievements">Achievements</a></div><div class="nav-item"><a href="/certs">Certifications</a></div><div class="nav-item"><a href="/pubs">Publications</a></div></div>`;
  assert.deepEqual(ownOf(`<div id="app">${divMenu}${cardsPage()}</div>`), PROJECTS_ONLY);
  // A site with no project is not passed through its menu, even on a host that answers 404 for made-up addresses.
  assert.deepEqual(ownOf(`<div id="app">${divMenu}<main><h1>Projects</h1><p>Coming soon.</p></main></div>`), []);
  // A call-to-action band and a next/previous pair, under addresses that are on no list.
  const cta = `<section class="cta"><h2>Have an idea?</h2><a class="btn" href="/get-in-touch">Get in touch</a> <a class="btn" href="/lets-talk">Let's talk →</a> <a href="/start">Home</a></section>
    <div class="pager"><a href="/p/older-one">← Previous project</a> <a href="/p/newer-one">Next project →</a> <a href="/everything">View all</a></div>`;
  assert.deepEqual(ownOf(cardsPage(cta)), PROJECTS_ONLY);
});

test("a menu is told from a project grid: a breadcrumb or a back link beside the cards does not make the cards a menu", () => {
  const crumb = `<div class="crumbs"><a href="/">Home</a> / <a href="/projects">Projects</a> / <span>All</span></div>`;
  // The breadcrumb sits in the same main content as the cards, as on bhavaniravi.com.
  assert.deepEqual(ownOf(cardsPage().replace("<h1>Projects</h1>", `${crumb}<h1>Projects</h1>`)), PROJECTS_ONLY);
  assert.deepEqual(ownOf(cardsPage().replace("<h1>Projects</h1>", `<a href="/">← Back home</a><h1>Projects</h1>`)), PROJECTS_ONLY);
  // A list whose items are short links and one of them the home page is a menu, whatever stands beside the links.
  const list = `<ul class="links"><li><a href="/">Home</a></li><li><a href="/rht">Reading</a> <span>what I read</span></li><li><a href="/skillsbar">Skills</a> <span>what I know</span></li></ul>`;
  assert.deepEqual(ownOf(`<main>${list}</main>`), []);
});

test("younes-megaache.com: a project card that links the site itself, labelled with its address, makes no menu of the cards", () => {
  // As the page writes its cards (cut from younes-megaache.com/projects): each links its project by its address.
  const card = (name, href, label) => `<li><div><div><img alt="${name}"><div><h1>${name}</h1></div><a href="${href}" target="_blank"><span>${label}</span></a></div><p>${name}, a project of mine.</p></div></li>`;
  const html = `<main><div>${card("Tawasal watch app", "https://appgallery.huawei.com/app/C105867571", "appgallery.huawei.com")}
    ${card("Bananalyzer", "https://github.com/megaacheyounes/Bananalyzer", "github.com")}
    ${card("Personal website", "https://younes-megaache.com", "younes-megaache.com")}
    ${card("Nan Mo Hoam's website", "https://nan-mo-hoam.com", "nan-mo-hoam.com")}</div></main>`;
  const got = fromPages({ home: "https://younes-megaache.com/", page: "https://younes-megaache.com/projects", pageHtml: html }).map((c) => c.url);
  assert.deepEqual(got, ["https://appgallery.huawei.com/app/C105867571", "https://github.com/megaacheyounes/Bananalyzer", "https://nan-mo-hoam.com/"]);
});

test("a language is only an ISO 639-1 code at the start of the path; 'ai-chat', 'go-cli', 'ml-lab' and 'ui-kit' are projects", () => {
  const paths = ["/ai-chat", "/my-app", "/js-quiz", "/ui-kit", "/ml-lab", "/go-cli", "/ar-demo", "/en", "/pt-br", "/zh-hant", "/de/impressum", "/en/foo"];
  const html = `<main><div class="grid">${paths.map((p) => `<div class="card"><a href="${p}"><h3>Project ${p}</h3></a><p>One of my projects, with a line about it.</p></div>`).join("")}</div></main>`;
  assert.deepEqual(ownOf(html), ["/ai-chat", "/my-app", "/js-quiz", "/ui-kit", "/ml-lab", "/go-cli", "/ar-demo"].map((p) => `https://ana.dev${p}`));
});

test("not on the home page: a same-site link at the top of the site stays a section of the site there", () => {
  const html = `<section id="projects"><h2>Projects</h2><a href="/rht">Reading Habit Tracker</a> <a href="/lasttimei">Last Time I</a></section>`;
  assert.deepEqual(projectCandidates(homeProjectLinks({ html, url: "https://ana.dev/", finalUrl: "https://ana.dev/" }), "https://ana.dev/"), []);
});

// 3. bekahhw.com's "My Work" page: eight links to one company site that has shut down came first.
test("bekahhw.com: at most 3 links of one outside site first, so its live community work is checked", () => {
  const got = fromPages({ home: "https://bekahhw.com/", homeHtml: fixture("bekahhw.com.home.html"), page: "https://bekahhw.com/my-work", pageHtml: fixture("bekahhw.com.my-work.html") }).map((c) => c.url);
  assert.equal(got.length, 8);
  assert.equal(got.filter((u) => hostKey(u) === "opensauced.pizza").length, PER_HOST_MAX);
  for (const live of ["https://hacktoberfest.virtualcoffee.io/", "https://virtualcoffee.io/monthlychallenges"]) assert.ok(got.includes(live), live);
});

test("the spread rule: 3 per outside host first, then the places left in order; repositories count one by one", () => {
  const home = "https://ana.dev/";
  const section = (hrefs) => `<section id="projects">${hrefs.map((h) => `<a href="${h}">x</a>`).join(" ")}</section>`;
  const pick = (hrefs, extra = "") => projectCandidates(homeProjectLinks({ html: section(hrefs) + extra, url: home, finalUrl: home }), home).map((c) => c.url);
  const one = Array.from({ length: 10 }, (_, i) => `https://one.example/p${i}`);
  // 3 of one.example, the 2 others, then one.example again for the places left; the list keeps page order.
  assert.deepEqual(pick([...one, "https://two.example/", "https://three.example/"]), [...one.slice(0, 6), "https://two.example/", "https://three.example/"]);
  // Only one host: the 8 places are still all filled.
  assert.equal(pick(one).length, 8);
  // Eight repositories of one owner are eight projects; links into one repository are one.
  const repos = Array.from({ length: 9 }, (_, i) => `https://github.com/ana/app${i}`);
  assert.deepEqual(pick(repos), repos.slice(0, 8));
  assert.equal(hostKey("https://github.com/Ana/App/tree/main"), hostKey("https://github.com/ana/app"));
  // Version 4 review: one repository is one link, wherever into it the links go (garebear99.github.io linked three
  // releases of one plugin); the same outside page twice, with another fragment, is one link too.
  const oneRepo = [...["", "/tree/main", "/releases/tag/v2.3.1", "/releases/tag/v2.3.0", "/wiki", "/blob/main/a.md"].map((p) => `https://github.com/ana/app${p}`), "https://github.com/ana/other", "https://demo.example/#top", "https://demo.example/#features"];
  assert.deepEqual(pick(oneRepo), ["https://github.com/ana/app", "https://github.com/ana/other", "https://demo.example/"]);
  // The link kept is the one in the projects, even when a link into the same repository comes first outside them.
  const kept = projectCandidates(homeProjectLinks({ html: `<p>Credits: <a href="https://github.com/ana/app/wiki">wiki</a></p>${section(["https://github.com/ana/app/releases/tag/v1"])}`, url: home, finalUrl: home }), home);
  assert.deepEqual(kept.map((c) => [c.url, c.tier]), [["https://github.com/ana/app/releases/tag/v1", 1]]);
  // A link outside the projects never takes the place of a project link, however many share a host.
  const many = Array.from({ length: 6 }, (_, i) => `https://one.example/q${i}`);
  const got = projectCandidates(homeProjectLinks({ html: `${section(many)}<p>${["https://x.example/", "https://y.example/", "https://z.example/"].map((h) => `<a href="${h}">x</a>`).join(" ")}</p>`, url: home, finalUrl: home }), home);
  assert.deepEqual(got.map((c) => c.tier), [1, 1, 1, 1, 1, 1, 3, 3]);
});

test("the list stored for the nightly re-check is the spread list the capture checked", async () => {
  const asked = [];
  const facts = await measurePage(
    { html: fixture("bekahhw.com.home.html"), text: "Bekah", url: "https://bekahhw.com/", finalUrl: "https://bekahhw.com/", projectsPage: { html: fixture("bekahhw.com.my-work.html"), finalUrl: "https://bekahhw.com/my-work" } },
    { fetchImpl: async (u, init) => (asked.push(`${init?.method} ${u}`), new Response(null, { status: 200 })) }
  );
  const stored = facts.project_candidates.map((c) => c.url);
  assert.equal(stored.filter((u) => hostKey(u) === "opensauced.pizza").length, PER_HOST_MAX);
  assert.deepEqual([...new Set(asked.map((a) => a.split(" ")[1]))].sort(), [...stored].sort(), "exactly the stored list was requested");
  assert.equal(facts.v, 4);
});

// 5. chiragsamal.github.io: an app whose projects are at "#/projects".
test("chiragsamal.github.io: a hash route that names a projects page is the projects page", () => {
  const home = "https://chiragsamal.github.io/";
  assert.equal(projectsPageFor(homeProjectLinks({ html: fixture("chiragsamal.github.io.home.html"), url: home, finalUrl: home }), home), "https://chiragsamal.github.io/#/projects");
});

test("only a hash route is a route: an in-page anchor, another route, a query or another path is not", () => {
  const home = "https://ana.dev/";
  const at = (href, text = "Projects") => projectsPageFor([{ href: new URL(href, home).href, raw: href, text }], home);
  assert.equal(at("#/projects"), "https://ana.dev/#/projects");
  assert.equal(at("#!/work"), "https://ana.dev/#!/work");
  assert.equal(at("/index.html#/portfolio/"), "https://ana.dev/index.html#/portfolio/");
  assert.equal(at("#/p", "My work"), "https://ana.dev/#/p", "a route named by its label, as a path is");
  assert.equal(at("#projects"), null, "an in-page anchor");
  assert.equal(at("#/about"), null);
  assert.equal(at("#/projects?tab=all"), null, "a route with a query");
  assert.equal(at("#/logout", "Projects"), null, "an action");
  assert.equal(at("https://other.dev/#/projects"), null, "another site");
  assert.equal(hashRoute({ href: "https://ana.dev/blog/#/projects" }, home), null, "another page's route");
  // A site served under a path: its own routes.
  assert.equal(projectsPageFor([{ href: "https://ana.github.io/site/#/projects", raw: "#/projects", text: "Projects" }], "https://ana.github.io/site/"), "https://ana.github.io/site/#/projects");
});

test("a hash route's page: its outbound project links count as the projects page's", () => {
  const page = "https://chiragsamal.github.io/#/projects";
  const html = `<nav><a href="#/home">Home</a></nav><div><h1>Projects</h1><a href="https://github.com/chiragsamal/zomato">Zomato</a> <a href="https://github.com/chiragsamal">GitHub</a></div>`;
  const got = fromPages({ home: "https://chiragsamal.github.io/", page, pageHtml: html });
  assert.deepEqual(got.map((c) => [c.url, c.from, c.tier]), [["https://github.com/chiragsamal/zomato", "projects_page", 1]]);
});

// Found in the sample of 40 sites after the fixes (nevo.is-a.dev): its project pages are drawn in the browser, so
// a plain fetch of one is the same shell as a made-up address, but the made-up one says "Project Not Found".
test("nevo.is-a.dev: a host whose made-up address answers 200 but says not found tells its own pages apart", async () => {
  const SC = fixture("nevo.is-a.dev.smart-care.html");
  const HOME = SC.replace(/NEVO \| Smart Care/g, "NEVO | Frontend Developer");
  const nf = fakeHost({ "/": [200, HOME], "/projects/smart-care": [200, SC], "/projects/drawly": [200, SC.replace(/Smart Care/g, "Drawly")], "/projects/gone": [200, fixture("nevo.is-a.dev.nonsense.html")] }, [200, fixture("nevo.is-a.dev.nonsense.html")]);
  const r = await checkLinks(["/projects/smart-care", "/projects/drawly", "/projects/gone"].map((p) => ({ url: `https://nevo.is-a.dev${p}`, kind: "own page", tier: 2 })), { fetchImpl: nf, homeText: "NEVO" });
  assert.deepEqual([r.own_check, r.ok, r.own_ok, r.broken, r.own_unverified], ["not_found_page", 2, 2, 1, 0], "a page that says not found is broken");
  // The same shell pages on a host whose made-up address does not say so: they still cannot be told apart.
  const shell = fakeHost({}, [200, SC]);
  const t = await checkLinks([{ url: "https://nevo.is-a.dev/projects/smart-care", kind: "own page", tier: 2 }], { fetchImpl: shell, homeText: "NEVO" });
  assert.deepEqual([t.own_check, t.ok, t.own_unverified], ["text", 0, 1]);
  // Only the title or the first h1 says so: a menu or a post about 404 errors further down does not.
  assert.equal(saysNotFound("<title>Ana | Page not found</title>"), true);
  assert.equal(saysNotFound("<title>Ana</title><h1>404</h1>"), true);
  assert.equal(saysNotFound("<title>Ana</title><h1>Ana Ruiz</h1><h2>Fixing 404 errors in Next.js</h2><p>Not found</p>"), false);
  assert.equal(saysNotFound(BH_NONSENSE), false, "bhavaniravi.com's made-up address is its home page, not a not-found page");
  // A site whose name has "404" in it says so on every page, the home page included: that is no not-found page.
  const studio = (t) => `<title>404 Studio - ${t}</title><body><nav>404 Studio</nav><main><h1>404 Studio</h1><div id="root"></div></main></body>`;
  const named = fakeHost({ "/": [200, studio("Ana Ruiz")], "/work/a": [200, studio("Alpha")] }, [200, studio("Ana Ruiz")]);
  const s = await checkLinks([{ url: "https://404studio.dev/work/a", kind: "own page", tier: 2 }], { fetchImpl: named, homeText: "404 Studio" });
  assert.notEqual(s.own_check, "not_found_page");
  assert.equal(s.broken, 0, "its own page is not marked broken for its name");
  assert.ok(named.asked.includes("GET /"), "the home page was asked once, to tell");
});

// Found in the sample of 40 sites after the fixes (expensive.toys).
test("expensive.toys: a first-level '/toys' page labelled 'Toys' is the projects page, and its toys are its own pages", () => {
  const home = "https://expensive.toys/";
  const links = homeProjectLinks({ html: `<header><a href="/blog">Blog</a> <a href="/toys">Toys</a></header><main><p>I build quality UIs for fun.</p></main>`, url: home, finalUrl: home });
  assert.equal(projectsPageFor(links, home), "https://expensive.toys/toys");
  const page = "https://expensive.toys/toys";
  const got = fromPages({ home, page, pageHtml: `<header><a href="/blog">Blog</a></header><main><a href="/toys/reactions">Reactions</a> <a href="/toys/stickers">Stickers</a> <a href="/blog">Blog</a></main>` });
  assert.deepEqual(got.map((c) => [c.url, c.kind]), [["https://expensive.toys/toys/reactions", "own page"], ["https://expensive.toys/toys/stickers", "own page"]]);
  // Not under another label, and not below the first segment.
  assert.equal(projectsPageFor(homeProjectLinks({ html: `<a href="/toys">Shop</a>`, url: home, finalUrl: home }), home), null);
  assert.equal(projectsPageFor(homeProjectLinks({ html: `<a href="/shop/toys">Toys</a>`, url: home, finalUrl: home }), home), null);
});

// The independent review of #287 (krupal-portfolio.vercel.app in the sample of 40).
test("krupal-portfolio.vercel.app: a 'Company Experiences' column title inside 'Works' lowers its employers; client work still counts", () => {
  const home = "https://krupal-portfolio.vercel.app/";
  const cands = (html) => projectCandidates(homeProjectLinks({ html, url: home, finalUrl: home }), home).map((c) => [c.url, c.tier]);
  // As the site writes it (cut from its page): the column titles are <p>, not headings.
  const works = (title) => `<section id="works"><h2>Works</h2><div><div><div><p>${title}</p><div>
    <a target="_blank" href="https://virtuoustechlogic.com/"><img alt="Virtuous Techlogic"><div><p>Virtuous Techlogic</p><div><p>Junior Flutter Developer</p></div></div><div><p>2023 - 2024</p></div></a>
    <a target="_blank" href="https://hencesoft.com/"><img alt="HENCE SOFT"><div><p>HENCE SOFT</p><div><p>Frontend Developer</p></div></div><div><p>2021 - 2023</p></div></a>
    </div></div></div><div><div><p>Learning Projects</p><div>
    <a target="_blank" href="https://github.com/Krupal19/Expense-Tracker"><div>Expence Tracker</div><p>A simple Flutter app to track expenses.</p></a>
    <a target="_blank" href="https://krupal19.github.io/TodoListApp-JavaScript/"><div>TodoList App - Javascript</div><p>A JavaScript app for managing tasks.</p></a>
    </div></div></div></div></section>`;
  for (const title of ["Company Experiences", "Work experience", "<strong>Where I've</strong> worked", "Employment"]) {
    assert.deepEqual(cands(works(title)), [
      ["https://github.com/Krupal19/Expense-Tracker", 1],
      ["https://krupal19.github.io/TodoListApp-JavaScript/", 1],
      ["https://virtuoustechlogic.com/", 3],
      ["https://hencesoft.com/", 3],
    ], title);
  }
  // Client work is work the person shows: those columns still count.
  for (const title of ["Client work", "Selected clients", "Companies I founded", "Career Compass"]) {
    assert.deepEqual(cands(works(title)).map(([, t]) => t), [1, 1, 1, 1], title);
  }
  // Only as the column's first text, holding no link: a project card that mentions experience is a project.
  const card = `<section id="projects"><h2>Projects</h2><div><a href="https://exp.example/">Exp</a><p>Experiences</p><a href="https://two.example/">Two</a></div></section>`;
  assert.deepEqual(cands(card).map(([, t]) => t), [1, 1]);
});

test("a project page written in Chinese, Japanese or Thai counts by its letters; a thin one still does not", async () => {
  const frame = `<header><a href="/">Ana</a> <a href="/projects">Projects</a></header>`;
  const page = (body) => `<html><head><title>Ana</title></head><body>${frame}<main>${body}</main></body></html>`;
  const zh = page(`<h1>智能客服系统</h1><p>这是一个为电商平台开发的智能客服系统，支持多轮对话、订单查询和售后处理。系统使用大语言模型理解用户问题，并结合知识库给出准确回答，上线后人工客服工作量下降了一半。</p>`);
  const ja = page(`<h1>家計簿アプリ</h1><p>毎月の支出を写真から自動で記録できる家計簿アプリです。レシートを撮影すると品目と金額を読み取り、カテゴリごとに集計してグラフで表示します。家族で共有することもできます。</p>`);
  const th = page(`<h1>ระบบจองคิวร้านอาหาร</h1><p>ระบบจองคิวออนไลน์สำหรับร้านอาหาร ลูกค้าสามารถจองโต๊ะล่วงหน้า ดูเวลารอ และรับการแจ้งเตือนเมื่อถึงคิว ร้านค้าจัดการคิวทั้งหมดได้จากหน้าจอเดียว</p>`);
  const thin = page(`<h1>智能客服系统</h1><p>即将推出。</p>`);
  const f = fakeHost({ "/projects/zh": [200, zh], "/projects/ja": [200, ja], "/projects/th": [200, th], "/projects/thin": [200, thin] }, [200, page("")]);
  const r = await checkLinks(["zh", "ja", "th", "thin"].map((p) => ({ url: `https://ana.dev/projects/${p}`, kind: "own page", tier: 2 })), { fetchImpl: f, homeText: "Ana\nProjects" });
  assert.deepEqual([r.own_check, r.ok, r.own_unverified], ["text", 3, 1]);
});

// Found in the sample of 40 sites after the fixes (houssambouzid.dev).
test("a certificate's verification or badge page is never a project, on any host; an app named for certificates is", () => {
  const home = "https://ana.dev/";
  const html = `<section id="projects"><h2>Projects</h2>
    <a href="https://catalog-education.oracle.com/ords/certview/sharebadge?id=AA14">OCI badge</a>
    <a href="https://academy.example/verify-certificate/123">Verify</a>
    <a href="https://certs.example/certificate-verification/9">Verify</a>
    <a href="https://certificate-maker.vercel.app/">Certificate maker</a>
    <a href="https://github.com/ana/certificate-generator">Generator</a></section>`;
  assert.deepEqual(projectCandidates(homeProjectLinks({ html, url: home, finalUrl: home }), home).map((c) => c.url), ["https://certificate-maker.vercel.app/", "https://github.com/ana/certificate-generator"]);
});

test("alestor123.is-a.dev: its projects page read once the list has arrived gives its repositories", () => {
  const got = fromPages({ home: "https://alestor123.is-a.dev/", page: "https://alestor123.is-a.dev/projects/", pageHtml: fixture("alestor123.is-a.dev.projects.html") });
  assert.equal(got.length, 8);
  assert.ok(got.every((c) => c.tier === 1 && /^https:\/\/github\.com\/alestor123\//.test(c.url)), JSON.stringify(got));
});
