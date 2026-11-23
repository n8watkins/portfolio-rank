// Projects kept on the site's own pages or opened from buttons (facts version
// 3, pipeline/facts.mjs projectCandidates, projectsPageFor, measurePage): the
// home page's projects section, the site's own projects page, the site's
// pages for single projects, and the destinations of project buttons. The
// fixtures are the rendered home and projects pages of listed sites as the
// capture read them on 2026-11-22 (eduardconstantin.github.io's projects page
// as its app shows it after the PROJECTS link is pressed), cut down to their
// markup, with emails and phone numbers replaced. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { homeProjectLinks, measurePage, pageLinks, projectCandidates, projectLinksText, projectsPageFor } from "../pipeline/facts.mjs";
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
  assert.equal(got[0].url, "https://mj-silver.vercel.app/");
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
  assert.equal(projectLinksText({ checked: got.length, ok: got.length, broken: 0, blocked: 0 }), "8 of 8 project links load");
});

test("eduardconstantin.github.io: the projects its app shows after PROJECTS is pressed", () => {
  const url = "https://eduardconstantin.github.io/";
  assert.equal(projectsPageFor(homeOf("eduardconstantin.github.io", url), url), "https://eduardconstantin.github.io/projects");
  const got = projectCandidates(withProjectsPage("eduardconstantin.github.io", url), url);
  assert.ok(got.length >= 3, JSON.stringify(got));
  assert.ok(got.some((c) => c.url === "https://github.com/eduardconstantin/react-motion-components"));
});

test("www.rapidtech1898.com: its own solution pages in the home page's portfolio section count, so no other page is read", () => {
  const url = "https://www.rapidtech1898.com/";
  const home = homeOf("www.rapidtech1898.com", url);
  const got = projectCandidates(home, url);
  const own = got.filter((c) => c.kind === "own page");
  assert.ok(own.length >= 3, JSON.stringify(got));
  assert.ok(own.every((c) => /\/solutions\/portfolio-[a-z-]+\/$/.test(c.url)));
  assert.equal(projectsPageFor(home, url), null);
  // Outbound demo and repository links come first, the site's own project pages after.
  assert.ok(got.findIndex((c) => c.kind === "own page") > -1);
});

test("nitishkr.fun: its project buttons carry no URL in the page; the destinations the capture reads from them are projects", () => {
  const url = "https://nitishkr.fun/";
  const html = fixture("nitishkr.fun.home.html");
  assert.match(html, /VS Code Marketplace/);
  const home = homeOf("nitishkr.fun", url);
  assert.deepEqual(projectCandidates(home, url).map((c) => c.url), ["https://codeberg.org/nk2552003/umd"], "the page alone has one project link");
  // What pressing them opened on 2026-11-22 (window.open from the buttons' handlers; pipeline/capture-projects.mjs).
  const buttonUrls = [
    "https://marketplace.visualstudio.com/items?itemName=NK2552003.focusforge",
    "https://pub.dev/packages/quiet_dock",
    "https://pypi.org/project/mac-deep-cleaner/",
    "https://nk2552003.github.io/Iconoodle/",
  ];
  const links = homeProjectLinks({ html, url, finalUrl: url, buttonUrls });
  const got = projectCandidates(links, url);
  assert.equal(got.length, 5);
  assert.deepEqual(got.filter((c) => c.from === "button").map((c) => c.url), buttonUrls);
  assert.equal(projectsPageFor(links, url), null, "with them it shows enough projects: no other page is read");
});

test("the projects page is followed only when the home page shows fewer than 3 projects, and only to the same site", () => {
  const url = "https://ana.dev/";
  const nav = `<nav><a href="/process">How I work</a><a href="/#projects">Projects</a><a href="https://other.example/projects">Elsewhere</a><a href="/work">Work</a></nav>`;
  const links = (html) => homeProjectLinks({ html, url, finalUrl: url });
  assert.equal(projectsPageFor(links(nav), url), "https://ana.dev/work", "not 'How I work', not a section of the page, not another site");
  const three = `${nav}<section id="projects"><a href="https://a.example/">a</a><a href="https://b.example/">b</a><a href="/projects/c">c</a></section>`;
  assert.equal(projectsPageFor(links(three), url), null);
  assert.equal(projectsPageFor(links(`<a href="/blog">Blog</a><a href="/about">About</a>`), url), null);
  // A link's words count when the path does not say it ("/stuff" labelled "Explore Work →").
  assert.equal(projectsPageFor(links(`<a href="/stuff">Explore Work →</a>`), url), "https://ana.dev/stuff");
  // A projects page's own links: its single-project pages count, its menu and the listing itself do not.
  const page = "https://ana.dev/work";
  const pageHtml = `<header><a href="/work/menu-item">menu</a></header><main><a href="/work">All</a><a href="/work/alpha">Alpha</a><a href="/case-studies/beta">Beta</a><a href="/blog/post">Post</a><a href="https://demo.example/">Demo</a></main>`;
  const all = [...links(nav), ...pageLinks(pageHtml, page).map((l) => ({ ...l, from: "projects_page", page }))];
  assert.deepEqual(
    projectCandidates(all, url).map((c) => [c.kind, c.url]),
    // The home page's nav link to another site is an outbound link of neither kind: last.
    [["outbound", "https://demo.example/"], ["own page", "https://ana.dev/work/alpha"], ["own page", "https://ana.dev/case-studies/beta"], ["outbound", "https://other.example/projects"]]
  );
});

test("measurePage records where the checked links came from and keeps the list for the nightly re-check", async () => {
  const url = "https://www.masirjafri.in/";
  const html = fixture("www.masirjafri.in.projects.html");
  const page = html.match(/^<!-- (\S+) -->/)[1];
  const f = await measurePage(
    { html: fixture("www.masirjafri.in.home.html"), text: "", url, finalUrl: url, projectsPage: { html, finalUrl: page }, buttonUrls: ["https://demo.example/"] },
    { fetchImpl: ok }
  );
  assert.equal(f.project_links.checked, 8);
  assert.equal(codeChecks(f).project_links, true);
  assert.deepEqual(f.views, ["desktop", "projects page"]);
  assert.deepEqual(f.project_links_from, { home: 1, phone: 0, buttons: 1, projects_page: { url: page, count: 6 }, own_pages: 0 });
  assert.equal(f.project_candidates.length, 8);
  assert.deepEqual(Object.keys(f.project_candidates[0]).sort(), ["from", "kind", "url"]);
  // Without a projects page or buttons: no projects page is recorded.
  const plain = await measurePage({ html: fixture("www.masirjafri.in.home.html"), text: "", url, finalUrl: url }, { fetchImpl: ok });
  assert.equal(plain.project_links_from.projects_page, null);
  assert.equal(plain.project_links.checked, 1);
  assert.equal(codeChecks(plain).project_links, false);
});
