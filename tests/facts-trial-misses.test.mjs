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
    `<p>Also see <a href="/achievements">My achievements</a>, <a href="/certifications">my certificates</a>, <a href="/awards">awards</a>, <a href="/publications">papers</a>, <a href="/research">research</a>, <a href="/stack">my stack</a>, <a href="/tools">tools</a>, <a href="/resources">resources</a>, <a href="/journey">my journey</a>, <a href="/timeline">timeline</a>, <a href="/authors/ana">Ana</a>.</p>`,
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

// Second review of #287: a card that links back to the site must never take its grid with it.
test("a card grid with Live and Code links keeps every project when one card's Live is the portfolio itself or a placeholder", () => {
  const card = (name, live, code) => `<div class="card"><img alt="${name}"><h3>${name}</h3><div class="links"><a href="${live}">Live</a><a href="${code}">Code</a></div></div>`;
  const grid = (cards) => `<main><h1>Projects</h1><div class="grid">${cards.join("")}</div></main>`;
  const three = [
    card("Weather", "https://weather-ana.vercel.app/", "https://github.com/ana/weather"),
    card("Chat", "https://chat-ana.netlify.app/", "https://github.com/ana/chat"),
    card("Todo", "https://todo-ana.vercel.app/", "https://github.com/ana/todo"),
  ];
  const six = ["https://weather-ana.vercel.app/", "https://github.com/ana/weather", "https://chat-ana.netlify.app/", "https://github.com/ana/chat", "https://todo-ana.vercel.app/", "https://github.com/ana/todo"];
  assert.deepEqual(ownOf(grid(three)), six);
  // The fourth card is this portfolio: its Live goes to "/". Then a placeholder Live to "/projects".
  assert.deepEqual(ownOf(grid([...three, card("This portfolio", "/", "https://github.com/ana/portfolio")])), [...six, "https://github.com/ana/portfolio"]);
  assert.deepEqual(ownOf(grid([...three, card("Soon", "/projects", "https://github.com/ana/soon")])), [...six, "https://github.com/ana/soon"]);
});

test("a breadcrumb, a logo or a '← home' line beside projects with short names does not make them a menu", () => {
  // A breadcrumb "Home" in the same container as cards whose links are just their names.
  const crumbAndCards = `<main><div class="wrap"><a href="/">Home</a><a href="/todo-app">Todo App</a><a href="/chat">Chat</a><a href="/weather">Weather</a></div></main>`;
  assert.deepEqual(ownOf(crumbAndCards), ["https://ana.dev/todo-app", "https://ana.dev/chat", "https://ana.dev/weather"]);
  // A logo image linking home, beside project links at the same depth, no nav or header.
  const logo = `<div class="page"><a href="/"><img alt=""></a><a href="https://weather-ana.vercel.app/">Weather</a><a href="https://chat-ana.netlify.app/">Chat</a><a href="/todo-app">Todo</a></div>`;
  assert.deepEqual(ownOf(logo), ["https://weather-ana.vercel.app/", "https://chat-ana.netlify.app/", "https://ana.dev/todo-app"]);
  // A minimal page: a home line, then one paragraph per project.
  const minimal = `<body><p><a href="/">← home</a></p><p><a href="/budget">Budget</a>: a budget for two.</p><p><a href="https://github.com/ana/notes">Notes</a>: notes that sync.</p><p><a href="/tracker">Tracker</a>: habits.</p></body>`;
  assert.deepEqual(ownOf(minimal), ["https://github.com/ana/notes", "https://ana.dev/budget", "https://ana.dev/tracker"]);
});

test("a div menu is still a menu with an image logo for its home link and long labels, and only its own pages go", () => {
  const menu = `<div class="topbar"><a href="/"><img alt=""></a><a href="/achievements-and-awards">Achievements and awards I received</a>
    <a href="/my-certifications">Professional certifications I hold</a><a href="/musings">Musings</a><a href="/publications">Selected publications and papers</a></div>`;
  // "/musings" names no section, but the menu it sits in does.
  assert.deepEqual(ownOf(`${menu}${cardsPage()}`), PROJECTS_ONLY);
  // A repository in a menu is not taken out with it.
  const withRepo = menu.replace("</div>", `<a href="https://github.com/ana/dotfiles">dotfiles</a></div>`);
  assert.deepEqual(ownOf(`${withRepo}${cardsPage()}`), ["https://github.com/ana/dotfiles", ...PROJECTS_ONLY]);
});

test("root-level project pages named like a section count by their label; the same paths labelled as sections do not", () => {
  const link = (p, label) => `<div class="card"><a href="${p}">${label}</a><p>A line about it.</p></div>`;
  const page = (cards) => `<main><div class="grid">${cards.join("")}</div></main>`;
  assert.deepEqual(ownOf(page([link("/2048/", "2048"), link("/notes/", "Notes, a markdown app"), link("/timeline/", "Timeline.js"), link("/tools/", "Dev Tools Hub"), link("/journal/", "Journal: a writing app"), link("/now/", "Now Playing")])), [
    "https://ana.dev/2048/",
    "https://ana.dev/notes/",
    "https://ana.dev/timeline/",
    "https://ana.dev/tools/",
    "https://ana.dev/journal/",
    "https://ana.dev/now/",
  ]);
  assert.deepEqual(ownOf(page([link("/notes/", "Notes"), link("/timeline/", "Timeline"), link("/tools/", "My tools"), link("/resume/", "Resume"), link("/2048/", "Page 2048"), link("/2024/", "2023"), link("/achievements", "")])), []);
  // A page that is never a project at the top of a site is not counted whatever its label, a project named like one
  // included: a resume at "/resume" is common, a "Resume Builder" project there rare (a known limit).
  assert.deepEqual(ownOf(page([link("/resume/", "Resume Builder"), link("/services", "Studio 42"), link("/about-me", "Ana")])), []);
  // Below the top of the site the path still decides.
  assert.deepEqual(ownOf(page([link("/topics/react", "React apps"), link("/blog/2048", "2048")])), []);
});

// Final code review of #287: calls to action in the projects page's main content.
test("a row of calls to action in the projects page's main content is not counted; one real demo stays a fail", () => {
  const page = `<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/projects">Projects</a></nav><main><h1>Projects</h1>
    <div class="card"><h3>Weather</h3><p>A weather app.</p><a href="https://weather-ana.vercel.app/">Live demo</a></div>
    <div class="cta-row"><a class="btn" href="/resume">Download Resume</a><a class="btn" href="/services">Work with me on your next product</a>
    <a class="btn" href="/hire-me">Available for freelance</a><a class="btn" href="/blog">Read my latest articles</a>
    <a class="btn" href="/certifications">See what I'm certified in</a><a class="btn" href="/curriculum">Get my CV</a>
    <a class="btn" href="/kontakt">Schreib mir</a><a class="btn" href="/sobre-mi">Quién soy yo</a></div></main>`;
  assert.deepEqual(ownOf(page), ["https://weather-ana.vercel.app/"]);
  // A label that opens the project itself is not a call to action: "View project", "See the demo", "Explore the app".
  const cards = `<main><div class="grid">${[["/tracker", "View project"], ["/budget", "See the demo"], ["/chess", "Explore the app"], ["/learn-go", "Learn Go: an interactive course"]]
    .map(([p, t]) => `<div class="card"><h3>${p.slice(1)}</h3><p>One of my projects.</p><a href="${p}">${t}</a></div>`).join("")}</div></main>`;
  assert.deepEqual(ownOf(cards), ["https://ana.dev/tracker", "https://ana.dev/budget", "https://ana.dev/chess"]);
});

test("what the home page shows outside its projects is not raised by the projects page's text, whatever its label there", () => {
  const home = "https://ana.dev/";
  const homeHtml = `<section id="about"><h2>About</h2><p>I worked at <a href="https://acme.example/">Acme</a>, <a href="https://globex.example/">Globex</a> and <a href="https://initech.example/">Initech</a>.</p></section>`;
  const page = "https://ana.dev/projects";
  const pageHtml = `<main><h1>Projects</h1><p>Before going freelance I built products at <a href="https://acme.example/">Acme Inc.</a>,
    <a href="https://globex.example/">Globex Corporation</a> and <a href="https://initech.example/">Initech (2019)</a>.</p>
    <div class="card"><h3>Weather</h3><a href="https://weather-ana.vercel.app/">Live demo</a></div></main>`;
  const links = homeProjectLinks({ html: homeHtml, url: home, finalUrl: home });
  links.push(...pageLinks(pageHtml, page).map((l) => ({ ...l, from: "projects_page", page })));
  assert.deepEqual(projectCandidates(links, home).map((c) => [c.url, c.tier]), [
    ["https://weather-ana.vercel.app/", 1],
    ["https://acme.example/", 3],
    ["https://globex.example/", 3],
    ["https://initech.example/", 3],
  ]);
  // A project card that links it twice (its title and "open app →") is a project, as marbelona.com's ParkinganPH is.
  const card = `<main><div class="card"><a href="https://acme.example/">Acme dashboard</a><p>An internal tool.</p><a href="https://acme.example/">open app →</a></div></main>`;
  const twice = homeProjectLinks({ html: homeHtml, url: home, finalUrl: home });
  twice.push(...pageLinks(card, page).map((l) => ({ ...l, from: "projects_page", page })));
  assert.deepEqual(projectCandidates(twice, home).find((c) => c.url === "https://acme.example/")?.tier, 1);
  const marbelona = withPages("https://marbelona.com/", "marbelona.com.home.html", "https://marbelona.com/projects", "marbelona.com.projects.html");
  assert.deepEqual(marbelona.find(([u]) => u === "https://parkinganph.com/"), ["https://parkinganph.com/", 1]);
});

test("a beginner's one repository of practice projects: each folder is a project; releases and the wiki fold into it", () => {
  assert.notEqual(hostKey("https://github.com/ana/js-projects/tree/main/calculator"), hostKey("https://github.com/ana/js-projects/tree/main/todo"));
  assert.equal(hostKey("https://github.com/ana/js-projects/blob/main/todo/index.html"), hostKey("https://github.com/ana/js-projects/tree/main/todo"));
  for (const into of ["releases/tag/v1", "wiki", "issues/3", "commit/abc123", "blob/main/README.md", "tree/main"]) {
    assert.equal(hostKey(`https://github.com/ana/app/${into}`), "github.com/ana/app", into);
  }
  assert.notEqual(hostKey("https://gitlab.com/ana/practice/-/tree/main/clock"), hostKey("https://gitlab.com/ana/practice/-/tree/main/quiz"));
  const home = "https://ana.dev/";
  const section = `<section id="projects">${["calculator", "todo", "weather"].map((d) => `<a href="https://github.com/ana/js-projects/tree/main/${d}">${d}</a>`).join(" ")} <a href="https://github.com/ana/js-projects/releases">Releases</a></section>`;
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: section, url: home, finalUrl: home }), home).map((c) => c.url), ["calculator", "todo", "weather"].map((d) => `https://github.com/ana/js-projects/tree/main/${d}`).concat("https://github.com/ana/js-projects/releases"));
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

test("a project page written in Korean counts its two-syllable words; a thin one still does not", async () => {
  const page = (body) => `<html><head><title>Ana</title></head><body><header><a href="/">Ana</a></header><main>${body}</main></body></html>`;
  const ko = page(`<h1>식단 관리 앱</h1><p>매일 먹은 음식을 사진으로 기록하면 영양 성분을 자동 분석해 주는 식단 관리 앱입니다. 목표 체중과 활동량에 맞춰 하루 권장 칼로리를 계산하고, 일주일 단위 리포트와 맞춤 식단 추천을 제공합니다. 가족 계정 연동, 알림 설정, 데이터 백업 기능도 지원합니다.</p>`);
  const thin = page(`<h1>식단 관리 앱</h1><p>준비 중입니다.</p>`);
  const f = fakeHost({ "/projects/ko": [200, ko], "/projects/thin": [200, thin] }, [200, page("")]);
  const r = await checkLinks(["ko", "thin"].map((p) => ({ url: `https://ana.dev/projects/${p}`, kind: "own page", tier: 2 })), { fetchImpl: f, homeText: "Ana" });
  assert.deepEqual([r.own_check, r.ok, r.own_unverified], ["text", 1, 1]);
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

// The independent trial of 103 sites on 28c972d (trial-100.json), from its saved pages.
const withPages = (home, homeFile, page, pageFile) => {
  const links = homeFile ? homeProjectLinks({ html: fixture(homeFile), url: home, finalUrl: home }) : [];
  if (pageFile) links.push(...pageLinks(fixture(pageFile), page).map((l) => ({ ...l, from: "projects_page", page })));
  return projectCandidates(links, home).map((c) => [c.url, c.tier]);
};

test("a page the projects page's own menu, header or footer links is never a project: lewishadden's /contact and /skills, marbelona's /blog", () => {
  assert.deepEqual(withPages("https://portfolio.lewishadden.com/", null, "https://portfolio.lewishadden.com/projects", "portfolio.lewishadden.com.projects.html"), [
    ["https://getsidenote.app/", 1],
    ["https://portfolio.lewishadden.com/projects/sidenote", 2],
  ]);
  const marbelona = withPages("https://marbelona.com/", "marbelona.com.home.html", "https://marbelona.com/projects", "marbelona.com.projects.html");
  assert.ok(!marbelona.some(([u]) => u === "https://marbelona.com/blog"), JSON.stringify(marbelona));
  // The real projects at any path still count where the menu does not link them: amanhimself.dev's apps, yujay.dev's.
  assert.deepEqual(withPages("https://amanhimself.dev/", "amanhimself.dev.trial.home.html", "https://amanhimself.dev/projects/", "amanhimself.dev.trial.projects.html").filter(([, t]) => t <= 2).map(([u]) => u), [
    "https://github.com/amandeepmittal/react-native-examples",
    "https://github.com/amandeepmittal/mobilenet-tfjs-expo",
    "https://amanhimself.dev/rht",
    "https://amanhimself.dev/lasttimei",
    "https://amanhimself.dev/skillsbar",
  ]);
  assert.deepEqual(withPages("https://yujay.dev/", null, "https://yujay.dev/projects/", "yujay.dev.projects.html").map(([u]) => u), [
    "https://hanzidrill.com/",
    "https://ahashelf.com/",
    "https://yujay.dev/projects/video2any",
    "https://yujay.dev/projects/nearmetal",
    "https://yujay.dev/projects/subtitlerocket",
    "https://yujay.dev/templates",
  ]);
  // In plain markup: the menu links "/blog" and "/now"; the main content's "read the notes" to "/blog" is not a project,
  // and "/meter" (no menu link) is. A project under the listing stays one even when a sidebar lists it too.
  const page = `<header><a href="/">Ana</a> <a href="/blog">Blog</a> <a href="/now">Now</a> <a href="/projects/tracker">Tracker</a></header>
    <main><div class="card"><a href="/blog">read the notes</a></div><div class="card"><a href="/meter">Meter</a><p>A power meter.</p></div><div class="card"><a href="/projects/tracker">Tracker</a><p>Habits.</p></div></main>`;
  assert.deepEqual(ownOf(page), ["https://ana.dev/meter", "https://ana.dev/projects/tracker"]);
});

test("a link keeps the highest tier it is seen in: avi-aggarwal.com's hypjam.com, marbelona.com's ParkinganPH", () => {
  const avi = withPages("https://avi-aggarwal.com/", "avi-aggarwal.com.home.html");
  assert.deepEqual(avi.find(([u]) => u === "https://hypjam.com/"), ["https://hypjam.com/", 1]);
  const marbelona = withPages("https://marbelona.com/", "marbelona.com.home.html", "https://marbelona.com/projects", "marbelona.com.projects.html");
  assert.deepEqual(marbelona.find(([u]) => u === "https://parkinganph.com/"), ["https://parkinganph.com/", 1]);
  // Either order: first in the projects, then in a work list, or the other way round.
  const home = "https://ana.dev/";
  const work = `<section><h2>Experience</h2><a href="https://acme.example/">Acme</a></section>`;
  const projects = `<section id="projects"><h2>Projects</h2><a href="https://acme.example/">Acme app</a></section>`;
  for (const html of [work + projects, projects + work]) {
    assert.deepEqual(projectCandidates(homeProjectLinks({ html, url: home, finalUrl: home }), home).map((c) => [c.url, c.tier]), [["https://acme.example/", 1]]);
  }
  // A link only in the work list stays low.
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: work, url: home, finalUrl: home }), home).map((c) => c.tier), [3]);
  // What every page of the site shows at its foot under the same label (amanhimself.dev's webrings) is not made a
  // project by the projects page's main content: the webring links stay low, and the apps keep their places.
  const aman = withPages("https://amanhimself.dev/", "amanhimself.dev.trial.home.html", "https://amanhimself.dev/projects/", "amanhimself.dev.trial.projects.html");
  assert.ok(aman.filter(([u]) => /webring|static\.quest/.test(u)).every(([, t]) => t === 3), JSON.stringify(aman));
  // A booking link is never a project, in the projects or not.
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: `<section id="projects"><a href="https://calendar.app.google/abc">Book a call</a><a href="https://cal.com/ana">Cal</a></section>`, url: home, finalUrl: home }), home), []);
});

test("'Réalisations' and the other common words for projects and work open a projects section", () => {
  const home = "https://ana.dev/";
  for (const heading of ["Réalisations", "Mes réalisations", "Trabalhos", "Meine Arbeiten", "Lavori", "Mijn werk", "Projelerim", "Çalışmalarım", "Proyek", "Karya Saya", "作品集", "ポートフォリオ", "포트폴리오", "Proyectos", "Projetos", "Projekte", "Progetti", "Projets", "Projecten"]) {
    const html = `<section><h2>${heading}</h2><div><a href="https://demo.example/">Demo</a></div></section>`;
    assert.deepEqual(projectCandidates(homeProjectLinks({ html, url: home, finalUrl: home }), home).map((c) => c.tier), [1], heading);
  }
  // www.aalexis.fr's "Réalisations à la une" opens a projects section now (its "Tout voir" link is in it). Its cards
  // sit in the next element after the heading's wrapper, which holds that link, so they are still outside it: a known
  // limit, listed in the pull request.
  const aalexis = pageLinks(fixture("www.aalexis.fr.home.html"), "https://www.aalexis.fr/");
  assert.equal(aalexis.find((l) => l.text === "Tout voir")?.inProjects, true);
  // Not a heading about work experience or "how we work".
  for (const heading of ["Expériences", "Wie wir arbeiten", "Werkervaring", "Deneyim"]) {
    const html = `<section><h2>${heading}</h2><div><a href="https://acme.example/">Acme</a></div></section>`;
    assert.deepEqual(projectCandidates(homeProjectLinks({ html, url: home, finalUrl: home }), home).map((c) => c.tier), [3], heading);
  }
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
