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

test("on the projects page, a same-site link to a section of the site, a language, a year or another listing is not a project", () => {
  const page = "https://ana.dev/projects";
  const html = `<nav><a href="/menu-app">Menu</a></nav><main><h1>Projects</h1>
    <a href="/tracker">Tracker</a> <a href="/apps/budget">Budget</a> <a href="/notes-app.html">Notes app</a>
    <a href="/about">About</a> <a href="/blog/how-i-built-it">Post</a> <a href="/tags/react">React</a> <a href="/uses">Uses</a>
    <a href="/now">Now</a> <a href="/en">English</a> <a href="/2024/05/launch">Launch post</a> <a href="/work">Work</a> <a href="/resume">Resume</a>
    <a href="/contact">Contact</a> <a href="/projects">All</a> <a href="/">Home</a> <a href="/logout">Sign out</a> <a href="/search?q=x">Search</a>
    <aside class="tools"><a href="/stack-tool">Tool</a></aside></main>`;
  const got = fromPages({ home: "https://ana.dev/", page, pageHtml: html }).map((c) => c.url);
  assert.deepEqual(got, ["https://ana.dev/tracker", "https://ana.dev/apps/budget", "https://ana.dev/notes-app.html"]);
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
  const oneRepo = [...["", "/tree/main", "/releases", "/wiki", "/issues/1", "/actions", "/blob/main/a.md", "/blob/main/b.md", "/blob/main/c.md", "/pulse"].map((p) => `https://github.com/ana/app${p}`), "https://demo.example/"];
  const spread = pick(oneRepo);
  assert.ok(spread.includes("https://demo.example/"), "the demo after ten links into one repository still gets a place");
  assert.equal(spread.length, 8);
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
  const nf = fakeHost({ "/projects/smart-care": [200, SC], "/projects/drawly": [200, SC.replace(/Smart Care/g, "Drawly")], "/projects/gone": [200, fixture("nevo.is-a.dev.nonsense.html")] }, [200, fixture("nevo.is-a.dev.nonsense.html")]);
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
