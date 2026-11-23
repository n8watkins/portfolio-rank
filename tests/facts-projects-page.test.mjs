// Projects kept on the site's own pages (facts version 3, pipeline/facts.mjs
// projectCandidates, projectsPageFor, measurePage): the home page's projects
// section, the site's own projects page and its pages for single projects.
// Buttons are never pressed: a project that opens only from a script handler
// is not found (nitishkr.fun). The fixtures are the rendered home and projects
// pages of listed sites as the capture read them on 2026-11-22
// (eduardconstantin.github.io's projects page as its app shows it after the
// PROJECTS link is pressed), cut down to their markup, with emails and phone
// numbers replaced. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homeProjectLinks, measurePage, pageLinks, projectCandidates, projectLinksShare, projectLinksText, projectsPageFor } from "../pipeline/facts.mjs";
import { codeChecks } from "../pipeline/rubric.mjs";

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "facts", name), "utf8");
const homeOf = (site, url) => homeProjectLinks({ html: fixture(`${site}.home.html`), url, finalUrl: url });
/** The home page's links plus its projects page's, as measurePage joins them. */
const withProjectsPage = (site, url) => {
  const html = fixture(`${site}.projects.html`);
  const page = html.match(/^<!-- (\S+) -->/)[1];
  return [...homeOf(site, url), ...pageLinks(html, page).map((l) => ({ ...l, from: "projects_page", page }))];
};
const ok = async (u) => ({ status: 200, body: null, url: u });

test("shreyanshportfolio.in: a home page with no projects leads to its /projects page, whose 8 projects are checked", () => {
  const url = "https://shreyanshportfolio.in/";
  assert.deepEqual(projectCandidates(homeOf("shreyanshportfolio.in", url), url), []);
  assert.equal(projectsPageFor(homeOf("shreyanshportfolio.in", url), url), "https://shreyanshportfolio.in/projects");
  const got = projectCandidates(withProjectsPage("shreyanshportfolio.in", url), url);
  assert.equal(got.length, 8);
  assert.ok(got.every((c) => c.from === "projects_page" && c.kind === "outbound"));
  // Its repositories and notebooks; an outbound link on that page outside a projects element or heading is not taken.
  assert.ok(got.every((c) => c.url.startsWith("https://github.com/")), JSON.stringify(got));
});

test("www.masirjafri.in: one project on the home page, the rest from its Projects page", () => {
  const url = "https://www.masirjafri.in/";
  const home = homeOf("www.masirjafri.in", url);
  assert.deepEqual(projectCandidates(home, url).map((c) => c.url), ["https://github.com/MasirJafri1/AI-Chatbots-and-Agents"]);
  assert.equal(projectsPageFor(home, url), "https://www.masirjafri.in/projects");
  const got = projectCandidates(withProjectsPage("www.masirjafri.in", url), url);
  assert.equal(got.length, 8);
  assert.deepEqual(got[0], { url: "https://github.com/MasirJafri1/AI-Chatbots-and-Agents", from: "home", kind: "outbound", tier: 1 });
  assert.equal(got.filter((c) => c.from === "projects_page").length, 7);
});

test("www.adhamdannaway.com: its case studies are its own pages under /portfolio, and they count as project links", () => {
  const url = "https://www.adhamdannaway.com/";
  assert.equal(projectsPageFor(homeOf("www.adhamdannaway.com", url), url), "https://www.adhamdannaway.com/portfolio");
  const got = projectCandidates(withProjectsPage("www.adhamdannaway.com", url), url);
  assert.equal(got.length, 8);
  assert.ok(got.every((c) => c.kind === "own page" && /^https:\/\/www\.adhamdannaway\.com\/portfolio\/[a-z0-9-]+$/.test(c.url)), JSON.stringify(got));
  assert.ok(!got.some((c) => /\/portfolio$/.test(c.url)), "never the projects page itself");
  // Its own pages supply at most 2 of the 3: with no project link elsewhere it is two thirds, a fail.
  const links = { checked: 8, ok: 8, broken: 0, blocked: 0, own_ok: 8 };
  assert.equal(projectLinksText(links, 3), "8 of 8 project links load");
  assert.equal(projectLinksShare(links, 3), 2 / 3);
  assert.equal(codeChecks({ v: 3, project_links: links }).project_links, false);
});

test("eduardconstantin.github.io: the projects its app shows after PROJECTS is pressed", () => {
  const url = "https://eduardconstantin.github.io/";
  assert.equal(projectsPageFor(homeOf("eduardconstantin.github.io", url), url), "https://eduardconstantin.github.io/projects");
  const got = projectCandidates(withProjectsPage("eduardconstantin.github.io", url), url);
  assert.ok(got.length >= 3, JSON.stringify(got));
  assert.ok(got.some((c) => c.url === "https://github.com/eduardconstantin/react-motion-components"));
});

test("www.rapidtech1898.com: its own solution pages count, at most 2 of them, so its Solutions page is read too", () => {
  const url = "https://www.rapidtech1898.com/";
  const home = homeOf("www.rapidtech1898.com", url);
  const got = projectCandidates(home, url);
  const own = got.filter((c) => c.kind === "own page");
  assert.ok(own.length >= 3, JSON.stringify(got));
  assert.ok(own.every((c) => /\/solutions\/portfolio-[a-z-]+\/$/.test(c.url)));
  // Its own pages show 2 of the 3 the pass counts, so the listing page is read for more.
  assert.equal(projectsPageFor(home, url), "https://rapidtech1898.com/topic/solutions/");
});

test("nitishkr.fun: its project buttons carry no URL in the page, and nothing is pressed to find one", () => {
  const url = "https://nitishkr.fun/";
  const html = fixture("nitishkr.fun.home.html");
  assert.match(html, /VS Code Marketplace/);
  const home = homeOf("nitishkr.fun", url);
  // What the markup shows: one source link. Its other projects open from script handlers, which are never run.
  assert.deepEqual(projectCandidates(home, url).map((c) => c.url), ["https://codeberg.org/nk2552003/umd"]);
  assert.equal(projectsPageFor(home, url), null, "its Projects link is a section of the same page");
});

test("the projects page is followed only when the home page shows fewer than 3 projects, and only to the same site", () => {
  const url = "https://ana.dev/";
  const nav = `<nav><a href="/process">How I work</a><a href="/#projects">Projects</a><a href="https://other.example/projects">Elsewhere</a><a href="/work">Work</a></nav>`;
  const links = (html) => homeProjectLinks({ html, url, finalUrl: url });
  assert.equal(projectsPageFor(links(nav), url), "https://ana.dev/work", "not 'How I work', not a section of the page, not another site");
  const three = `${nav}<section id="projects"><a href="https://a.example/">a</a><a href="https://b.example/">b</a><a href="/projects/c">c</a></section>`;
  assert.equal(projectsPageFor(links(three), url), null);
  assert.equal(projectsPageFor(links(`<a href="/blog">Blog</a><a href="/about">About</a>`), url), null);
  // Never a page whose path only contains the word: "/how-it-works", "/networks", "/workshop", a query, a client list.
  for (const html of [`<a href="/how-it-works">How it works</a>`, `<a href="/networks">Networks</a><a href="/workshop">Workshop</a>`, `<a href="/?page=work">FR</a>`, `<a href="/clients">Our work</a>`, `<a href="/api/download?file=projects">Download</a>`]) {
    assert.equal(projectsPageFor(links(html), url), null, html);
  }
  assert.equal(projectsPageFor(links(`<a href="/es/projects">Proyectos</a>`), url), "https://ana.dev/es/projects");
  // A site served under a path: its own home page is never one of its project pages (samrinjaji.github.io/my-portfolio/).
  const sub = "https://samrin.github.io/my-portfolio/";
  const subLinks = homeProjectLinks({ html: `<div class="portfolio"><a href="/my-portfolio/">Home</a><a href="/my-portfolio/index.html">Home</a><a href="https://github.com/s/a">a</a></div>`, url: sub, finalUrl: sub });
  assert.deepEqual(projectCandidates(subLinks, sub).map((c) => c.url), ["https://github.com/s/a"]);
  assert.equal(projectsPageFor(subLinks, sub), null);
  // A link's words count when the path does not say it ("/stuff" labelled "Explore Work →").
  assert.equal(projectsPageFor(links(`<a href="/stuff">Explore Work →</a>`), url), "https://ana.dev/stuff");
  // A projects page's own links: its single-project pages and the outbound links in its projects count; its menu,
  // the listing itself, its paging and tag pages, and outbound links outside the projects (clients, press) do not.
  const page = "https://ana.dev/work";
  const pageHtml = `<header><a href="/work/menu-item">menu</a></header><main><h1>Work</h1><p>Clients: <a href="https://bigcorp.example/">BigCorp</a></p>
    <section class="projects"><a href="https://demo.example/">Demo</a><a href="/work/alpha">Alpha</a><a href="/case-studies/beta">Beta</a></section>
    <a href="/work">All</a><a href="/work?page=2">Next</a><a href="/work/tag/react">React</a><a href="/blog/post">Post</a></main>`;
  const all = [...links(nav), ...pageLinks(pageHtml, page).map((l) => ({ ...l, from: "projects_page", page }))];
  assert.deepEqual(
    projectCandidates(all, url).map((c) => [c.kind, c.url]),
    // The home page's nav link to another site is an outbound link of neither kind: last.
    [["outbound", "https://demo.example/"], ["own page", "https://ana.dev/work/alpha"], ["own page", "https://ana.dev/case-studies/beta"], ["outbound", "https://other.example/projects"]]
  );
});

test("only as many own pages as the pass counts go ahead of other outbound links (stimmie.dev's case)", () => {
  const url = "https://ana.dev/";
  const html = `<section id="projects">${[1, 2, 3, 4, 5, 6, 7].map((i) => `<a href="/projects/p${i}">p${i}</a>`).join("")}</section>
    <section><h2>~ ana-verse ~</h2><a href="https://app.ana.example/">App</a><a href="https://tool.ana.example/">Tool</a></section>`;
  const got = projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url);
  assert.deepEqual(
    got.map((c) => c.url.replace("https://ana.dev", "")),
    ["/projects/p1", "/projects/p2", "https://app.ana.example/", "https://tool.ana.example/", "/projects/p3", "/projects/p4", "/projects/p5", "/projects/p6"]
  );
});

test("a 'Portfolio' title heading opens no projects section, and a projects heading's section ends at the next heading", () => {
  const url = "https://ana.dev/";
  // The reviewer's case: a person's name heading with "Portfolio", then about, blog and contact pages.
  const html = `<header><nav><a href="/">Home</a></nav></header><main>
    <h1>Ana Ruiz - Portfolio</h1><p>I build things.</p>
    <h2>About</h2><p>Studied at <a href="https://uni.example/">Uni</a>, worked at <a href="https://employer.example/">Employer</a>.</p>
    <a href="/about">More about me</a> <a href="/blog">Blog</a> <a href="/contact">Contact me</a>
  </main><footer>© 2026</footer>`;
  const got = projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url);
  assert.deepEqual(got.map((c) => [c.tier, c.url]), [[3, "https://uni.example/"], [3, "https://employer.example/"]], "no own pages, nothing in the projects");
  // A real projects heading: its section ends at the next h2, so the about section's links are not projects.
  const sec = `<main><h2>Projects</h2><a href="https://one.example/">One</a><a href="/projects/two">Two</a><h3>Older</h3><a href="https://old.example/">Old</a>
    <h2>About</h2><a href="https://employer.example/">Employer</a><a href="/about">About</a></main>`;
  assert.deepEqual(
    projectCandidates(homeProjectLinks({ html: sec, url, finalUrl: url }), url).map((c) => [c.tier, c.url]),
    [[1, "https://one.example/"], [1, "https://old.example/"], [2, "https://ana.dev/projects/two"], [3, "https://employer.example/"]]
  );
});

test("measurePage records where the checked links came from and keeps the list for the nightly re-check", async () => {
  const url = "https://www.masirjafri.in/";
  const html = fixture("www.masirjafri.in.projects.html");
  const page = html.match(/^<!-- (\S+) -->/)[1];
  const f = await measurePage(
    { html: fixture("www.masirjafri.in.home.html"), text: "", url, finalUrl: url, projectsPage: { html, finalUrl: page } },
    { fetchImpl: ok }
  );
  assert.equal(f.project_links.checked, 8);
  assert.equal(codeChecks(f).project_links, true);
  assert.deepEqual(f.views, ["desktop", "projects page"]);
  assert.deepEqual(f.project_links_from, { home: 1, phone: 0, projects_page: { url: page, count: 7 }, own_pages: 0 });
  assert.equal(f.project_candidates.length, 8);
  assert.deepEqual(Object.keys(f.project_candidates[0]).sort(), ["from", "kind", "url"]);
  // Without a projects page or buttons: no projects page is recorded.
  const plain = await measurePage({ html: fixture("www.masirjafri.in.home.html"), text: "", url, finalUrl: url }, { fetchImpl: ok });
  assert.equal(plain.project_links_from.projects_page, null);
  assert.equal(plain.project_links.checked, 1);
  assert.equal(codeChecks(plain).project_links, false);
});
