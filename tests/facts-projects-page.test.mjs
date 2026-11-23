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
  // The whole main content of the projects page is its projects: the featured card's live site (no projects
  // class, under the page's h1), then its repositories and notebooks.
  assert.equal(got[0].url, "https://mj-silver.vercel.app/");
  assert.ok(got.slice(1).every((c) => c.url.startsWith("https://github.com/")), JSON.stringify(got));
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
  // Its home page shows 3 case studies under "<div><h3>Some of my latest work</h3></div>" (the heading's wrapper
  // holds no link, so the section is the element around it): 3 projects shown, so its /portfolio is not needed.
  assert.deepEqual(projectCandidates(homeOf("www.adhamdannaway.com", url), url).map((c) => [c.tier, c.url.replace(url, "/")]), [
    [2, "/portfolio/figma-design-system"],
    [2, "/portfolio/ui-design-book"],
    [2, "/portfolio/creating-a-lean-design-system"],
  ]);
  assert.equal(projectsPageFor(homeOf("www.adhamdannaway.com", url), url), null);
  const got = projectCandidates(withProjectsPage("www.adhamdannaway.com", url), url);
  assert.equal(got.length, 8);
  assert.ok(got.every((c) => c.kind === "own page" && /^https:\/\/www\.adhamdannaway\.com\/portfolio\/[a-z0-9-]+$/.test(c.url)), JSON.stringify(got));
  assert.ok(!got.some((c) => /\/portfolio$/.test(c.url)), "never the projects page itself");
  // Real case-study pages on a host that answers 404 for nonsense: they count fully, a pass on its own pages alone.
  const links = { checked: 8, ok: 8, broken: 0, blocked: 0, own_ok: 8, own_unverified: 0, own_check: "status" };
  assert.equal(projectLinksText(links, 3), "8 of 8 project links load");
  assert.equal(projectLinksShare(links, 3), 1);
  assert.equal(codeChecks({ v: 3, project_links: links }).project_links, true);
});

test("eduardconstantin.github.io: the projects its app shows after PROJECTS is pressed", () => {
  const url = "https://eduardconstantin.github.io/";
  assert.equal(projectsPageFor(homeOf("eduardconstantin.github.io", url), url), "https://eduardconstantin.github.io/projects");
  const got = projectCandidates(withProjectsPage("eduardconstantin.github.io", url), url);
  assert.ok(got.length >= 3, JSON.stringify(got));
  assert.ok(got.some((c) => c.url === "https://github.com/eduardconstantin/react-motion-components"));
});

test("www.rapidtech1898.com: its own solution pages in the home page's portfolio menu count, so no other page is read", () => {
  const url = "https://www.rapidtech1898.com/";
  const home = homeOf("www.rapidtech1898.com", url);
  const got = projectCandidates(home, url);
  const own = got.filter((c) => c.kind === "own page");
  assert.ok(own.length >= 3, JSON.stringify(got));
  assert.ok(own.every((c) => /\/solutions\/portfolio-[a-z-]+\/$/.test(c.url)));
  // Its own pages show 3 projects, as many as the pass needs, so the listing page is not read.
  assert.equal(projectsPageFor(home, url), null);
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
  // Nor a link a GET could act on, whatever its label says ("/unsubscribe", "/logout", "/pay", "/download").
  for (const html of [`<a href="/how-it-works">How it works</a>`, `<a href="/networks">Networks</a><a href="/workshop">Workshop</a>`, `<a href="/?page=work">FR</a>`, `<a href="/clients">Our work</a>`, `<a href="/api/download?file=projects">Download</a>`,
    `<a href="/unsubscribe">Projects</a>`, `<a href="/newsletter/unsubscribe">Work</a>`, `<a href="/logout">Projects</a>`, `<a href="/sign-out">Projects</a>`, `<a href="/account/delete">Projects</a>`, `<a href="/checkout">Projects</a>`, `<a href="/pay">Portfolio</a>`, `<a href="/download">Projects</a>`, `<a href="/confirm">Work</a>`]) {
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
  // A projects page's own links: its single-project pages and every outbound link in its main content count (the
  // page is a listing by its path or label, so its content is the projects: a client named there is work shown);
  // its menu, the listing itself, its paging and tag pages, and its social list do not.
  const page = "https://ana.dev/work";
  const pageHtml = `<header><a href="/work/menu-item">menu</a><a href="https://press.example/">Press</a></header><main><h1>Work</h1><p>Clients: <a href="https://bigcorp.example/">BigCorp</a></p>
    <section class="projects"><a href="https://demo.example/">Demo</a><a href="/work/alpha">Alpha</a><a href="/case-studies/beta">Beta</a></section>
    <a href="/work">All</a><a href="/work?page=2">Next</a><a href="/work/tag/react">React</a><a href="/blog/post">Post</a>
    <section><h2>Find me</h2><a href="https://social.example/ana">Ana</a></section></main><footer><a href="https://host.example/">Hosted by</a></footer>`;
  const all = [...links(nav), ...pageLinks(pageHtml, page).map((l) => ({ ...l, from: "projects_page", page }))];
  assert.deepEqual(
    projectCandidates(all, url).map((c) => [c.kind, c.url]),
    // The home page's nav link to another site is an outbound link of neither kind: last.
    [["outbound", "https://bigcorp.example/"], ["outbound", "https://demo.example/"], ["own page", "https://ana.dev/work/alpha"], ["own page", "https://ana.dev/case-studies/beta"], ["outbound", "https://other.example/projects"]]
  );
  // The reviewer's case: the projects page titled with an h1, plain cards with no projects class.
  const pp = "https://ana.dev/projects";
  const ppHtml = `<main><h1>Projects</h1><div><h3>Alpha</h3><a href="https://alpha.example/">Live</a></div><div><h3>Beta</h3><a href="https://beta.example/">Live</a></div><div><h3>Gamma</h3><a href="https://gamma.example/">Live</a><a href="/projects/gamma">Read</a></div></main>`;
  assert.deepEqual(
    projectCandidates(pageLinks(ppHtml, pp).map((l) => ({ ...l, from: "projects_page", page: pp })), url).map((c) => [c.tier, c.url]),
    [[1, "https://alpha.example/"], [1, "https://beta.example/"], [1, "https://gamma.example/"], [2, "https://ana.dev/projects/gamma"]]
  );
  // The home page keeps "an h1 opens nothing": the same plain cards there are other outbound links, tier 3.
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: ppHtml, url, finalUrl: url }), url).map((c) => c.tier), [3, 3, 3]);
});

test("a project's own name may be any word; the path above it must not be a blog, tag or action page", () => {
  const url = "https://ana.dev/";
  const counted = (p) => projectCandidates(homeProjectLinks({ html: `<section id="projects"><a href="${p}">x</a></section>`, url, finalUrl: url }), url).length === 1;
  for (const p of ["/projects/api-gateway", "/work/dashboard-redesign", "/portfolio/admin-panel", "/projects/dashboard", "/projects/admin", "/projects/api", "/work/store", "/projects/auth",
    "/projects/profile", "/projects/export", "/portfolio/settings", "/case-studies/checkout", "/projects/news", "/projects/download", "/projects/photo-editor", "/work/cancel-culture", "/projects/remove-bg"]) {
    assert.ok(counted(p), p);
  }
  // An action is never requested, even as the name right under the listing ("/projects/logout", "/projects/x/delete").
  for (const p of ["/projects/tag/react", "/projects/category/web", "/blog/projects/x", "/account/projects/x", "/projects/download/file", "/admin/work/x", "/projects/page/2",
    "/projects/logout", "/projects/edit", "/projects/verify", "/projects/register", "/projects/unsubscribe", "/projects/delete", "/work/sign-out", "/projects/x/delete", "/projects/x/edit", "/projects/react/tag"]) {
    assert.ok(!counted(p), p);
  }
  // On the projects page, the name right under that page's path is the project's too ("/builds/checkout" under "/builds").
  const page = "https://ana.dev/builds";
  const own = (p) => projectCandidates(pageLinks(`<main><a href="${p}">x</a></main>`, page).map((l) => ({ ...l, from: "projects_page", page })), url).length === 1;
  assert.ok(own("/builds/checkout"));
  assert.ok(!own("/builds/tag/react"));
  // The page that is loaded in a browser is never an action, at any depth (projectsPageFor, tested above).
  assert.equal(projectsPageFor(homeProjectLinks({ html: `<nav><a href="/projects/unsubscribe">Projects</a></nav>`, url, finalUrl: url }), url), null);
});

test("tool lists, article sites, cookie banners and comment widgets: the host lists remove, a class or heading guess only lowers", async () => {
  const url = "https://ana.dev/";
  const ok = async () => new Response(null, { status: 200 });
  const homeNav = `<nav><a href="/projects">Projects</a></nav><main><h1>Ana</h1></main>`;
  const viaPage = async (ppHtml, pp = "https://ana.dev/projects") => {
    const g = await measurePage({ html: homeNav, text: "", url, finalUrl: url, projectsPage: { html: ppHtml, finalUrl: pp } }, { fetchImpl: ok });
    return { urls: (g.project_candidates || []).map((c) => c.url), pass: codeChecks(g).project_links };
  };
  const show = (html) => projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url).map((c) => [c.tier, c.url]);
  const asideOf = (html, host) => homeProjectLinks({ html, url, finalUrl: url }).find((l) => l.href.includes(host))?.inAside;
  // pure4: a "Tools I use" section beside image-only cards on a projects page still fails: the tools' sites are
  // removed by host; a repository in it stays (never lowered), but one link is no pass.
  const tools = await viaPage(`<main><h1>Projects</h1><section><h2>Tools I use</h2><a href="https://nodejs.org/">Node</a><a href="https://www.typescriptlang.org/">TS</a><a href="https://www.mongodb.com/">Mongo</a><a href="https://www.figma.com/">Figma</a><a href="https://www.docker.com/">Docker</a><a href="https://react.dev/">React</a><a href="https://vercel.com/">Vercel</a><a href="https://github.com/facebook/react">repo</a></section><div><img alt="project shot"></div></main>`);
  assert.deepEqual(tools, { urls: ["https://github.com/facebook/react"], pass: false });
  // An article list on /portfolio still fails: every host is an article site.
  const articles = await viaPage(`<main><h1>Portfolio</h1><article><a href="https://smashingmagazine.com/2024/a">a</a></article><article><a href="https://css-tricks.com/b">b</a></article><article><a href="https://medium.com/@ana/c">c</a></article><article><a href="https://www.freecodecamp.org/news/d">d</a></article></main>`, "https://ana.dev/portfolio");
  assert.deepEqual(articles, { urls: [], pass: false });
  // A cookie banner's provider links never count; a comment widget's link is lowered to tier 3.
  const cookie = await viaPage(`<main><h1>Projects</h1><div><img alt="x"></div><div id="disqus_thread"><a href="https://p.example/">p</a></div></main><div class="cookie-banner">We use cookies. <a href="https://www.cookiebot.com/">Cookiebot</a> <a href="https://www.onetrust.com/">OneTrust</a> <a href="/privacy">Privacy</a></div>`);
  assert.deepEqual(cookie, { urls: ["https://p.example/"], pass: false });
  // On the projects page an aside is not promoted by the whole-content rule: tier 3 after the card's own link.
  assert.deepEqual((await viaPage(`<main><h1>Projects</h1><div><a href="https://alpha.example/">Live</a></div><ul class="tech-stack"><li><a href="https://alpha-lib.example/">lib</a></li></ul></main>`)).urls, ["https://alpha.example/", "https://alpha-lib.example/"]);
  // pure5: a projects element wins over a class guess, and a guess never removes a link.
  assert.deepEqual(show(`<section id="projects"><div class="project-card"><h3>A</h3><ul class="tech-stack"><li>React</li></ul><a href="https://a.example/">Live</a><a href="https://github.com/ana/a">Code</a></div></section>`), [[1, "https://a.example/"], [1, "https://github.com/ana/a"]]);
  assert.deepEqual(show(`<section id="projects"><div class="card"><h3>A</h3><div class="card-tech"><span>React</span><a href="https://a.example/">Live</a><a href="https://github.com/ana/a">Code</a></div></div></section>`), [[1, "https://a.example/"], [1, "https://github.com/ana/a"]]);
  assert.deepEqual(show(`<section><h2>Projects</h2><div class="project-tech"><a href="https://a.example/">Live</a></div></section>`), [[1, "https://a.example/"]]);
  assert.deepEqual(show(`<section class="skills-projects"><a href="https://a.example/">a</a></section>`), [[1, "https://a.example/"]]);
  assert.deepEqual(show(`<section class="houses causes"><h2>Projects</h2><a href="https://a.example/">a</a></section>`), [[1, "https://a.example/"]]);
  // "Tools I built" is the person's own tools; an id "tools" around it only lowers the outbound link, and the repository stays.
  assert.deepEqual(show(`<section><h2>Tools I built</h2><a href="https://a.example/">a</a><a href="https://github.com/ana/t">t</a></section>`), [[1, "https://github.com/ana/t"], [3, "https://a.example/"]]);
  assert.deepEqual(show(`<section id="tools"><h2>Tools I built</h2><a href="https://a.example/">a</a><a href="https://github.com/ana/t">t</a></section>`), [[1, "https://github.com/ana/t"], [3, "https://a.example/"]]);
  // A page wrapper "tech-theme": the projects inside it win, the rest is lowered, nothing is dropped.
  assert.deepEqual(show(`<div class="app tech-theme"><section id="projects"><a href="https://a.example/">a</a></section><p><a href="https://b.example/">b</a></p></div>`), [[1, "https://a.example/"], [3, "https://b.example/"]]);
  // A project card named "cookie-clicker" inside the projects is a project.
  assert.deepEqual(show(`<section id="projects"><div class="cookie-clicker"><a href="https://cookie.example/">Cookie Clicker</a></div></section>`), [[1, "https://cookie.example/"]]);
  // A projects heading at h2 to h4 ends an open aside: "Skills" h2, then "Projects" h3 in a flat main.
  assert.deepEqual(show(`<main><h2>Skills</h2><p>React</p><h3>Projects</h3><a href="https://a.example/">a</a></main>`), [[1, "https://a.example/"]]);
  assert.deepEqual(show(`<main><section><h2>Tech Stack</h2><a href="https://nodejs.org/">Node</a></section><section><h2>Projects</h2><a href="https://a.example/">a</a></section></main>`), [[1, "https://a.example/"]]);
  // On the home page: a "Tech stack" section and a skills element are lowered, not removed.
  const home = `<main><section id="projects"><a href="https://p1.example/">p1</a></section><section><h2>Tech stack</h2><a href="https://tool.example/">tool</a></section><div class="skills"><a href="https://skill.example/">s</a></div><a href="https://other.example/">o</a></main>`;
  assert.deepEqual(show(home), [[1, "https://p1.example/"], [3, "https://tool.example/"], [3, "https://skill.example/"], [3, "https://other.example/"]]);
  // Only a heading that names tools, whole, is an aside: not "Tools I've built", nor an about section that
  // mentions technology (michellebrenner.com's "Bridging Technology & Human Potential").
  for (const h of ["Tools I've built", "Tools I built", "Open source tools", "Bridging Technology &amp; Human Potential", "Tech for good", "Skills that pay the bills: my work"]) {
    assert.equal(asideOf(`<main><h2>${h}</h2><a href="https://t.example/">t</a></main>`, "t.example"), false, h);
  }
  for (const h of ["Tools I use", "~ Technologies ~", "My Tech Stack", "Skills &amp; Tools", "02. Skills:", "Languages and frameworks", "Uses", "What I work with", "Built with", "Powered by"]) {
    assert.equal(asideOf(`<main><h2>${h}</h2><a href="https://t.example/">t</a></main>`, "t.example"), true, h);
  }
  // Cookie, consent and comment words are whole words of the class or id, not parts of other words.
  assert.equal(asideOf(`<div class="cookie-banner"><a href="https://t.example/">t</a></div>`, "t.example"), true);
  assert.equal(asideOf(`<div id="CybotCookiebotDialog"><a href="https://t.example/">t</a></div>`, "t.example"), true);
  assert.equal(asideOf(`<div class="fortune-cookies-app consentrate"><a href="https://t.example/">t</a></div>`, "t.example"), true);
  assert.equal(asideOf(`<div class="consentrate disqusting"><a href="https://t.example/">t</a></div>`, "t.example"), false);
  // A tool's site: its home and docs are removed, a person's own work on it counts.
  const counted = (u) => show(`<section id="projects"><a href="${u}">x</a></section>`).length === 1;
  for (const u of ["https://www.figma.com/community/file/123/my-design-system", "https://www.figma.com/proto/abc/App", "https://www.figma.com/file/abc/x", "https://www.figma.com/design/abc/x", "https://www.canva.com/design/DAF/view", "https://www.postman.com/ana/workspace/my-api", "https://huggingface.co/spaces/ana/demo", "https://ana.itch.io/game"]) {
    assert.ok(counted(u), u);
  }
  for (const u of ["https://nodejs.org/api/fs.html", "https://www.figma.com/", "https://www.figma.com/pricing", "https://supabase.com/", "https://www.canva.com/", "https://www.postman.com/downloads/", "https://www.prisma.io/docs"]) {
    assert.ok(!counted(u), u);
  }
  // Where people really ship stays in: their apps on the hosts' app domains, package pages, store listings.
  const shipped = ["https://ana-app.vercel.app/", "https://ana.netlify.app/", "https://ana.github.io/x/", "https://www.npmjs.com/package/ana-lib", "https://pypi.org/project/ana-lib/", "https://play.google.com/store/apps/details?id=dev.ana", "https://chromewebstore.google.com/detail/ana/abc", "https://apps.apple.com/app/id1", "https://hub.docker.com/r/ana/x", "https://addons.mozilla.org/firefox/addon/ana/"];
  const got = projectCandidates(homeProjectLinks({ html: `<section id="projects">${shipped.map((u) => `<a href="${u}">x</a>`).join("")}</section>`, url, finalUrl: url }), url, 20).map((c) => c.url);
  assert.deepEqual(got, shipped);
  // A registry's own home page is not a project.
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: `<section id="projects"><a href="https://www.npmjs.com/">npm</a><a href="https://pypi.org/">PyPI</a></section>`, url, finalUrl: url }), url), []);
});

test("apps on the site's own subdomains are its own work, ahead of its own pages (stimmie.dev's case)", () => {
  const url = "https://ana.dev/";
  // stimmie.dev's "~ stimmieverse ~": "Apps, tools, and services I make and offer" on its own subdomains.
  const html = `<section id="projects">${[1, 2, 3, 4, 5, 6, 7].map((i) => `<a href="/projects/p${i}">p${i}</a>`).join("")}</section>
    <div><h2>~ ana-verse ~</h2><ul><li><a href="https://gradesim.ana.dev">GradeSim</a></li><li><a href="https://tutor.ana.dev/">Tutor</a></li><li><a href="https://blog.ana.dev/">Blog</a></li><li><a href="https://app.ana.example/">Other</a></li></ul></div>`;
  const got = projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url);
  assert.deepEqual(
    got.map((c) => [c.tier, c.url.replace("https://ana.dev", "")]),
    [[1, "https://gradesim.ana.dev/"], [1, "https://tutor.ana.dev/"], [2, "/projects/p1"], [2, "/projects/p2"], [2, "/projects/p3"], [2, "/projects/p4"], [2, "/projects/p5"], [2, "/projects/p6"]]
  );
  // Not on a shared host: another *.github.io is someone else's.
  const gh = "https://ana.github.io/";
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: `<p><a href="https://bob.github.io/x/">x</a><a href="https://app.ana.github.io/">y</a></p>`, url: gh, finalUrl: gh }), gh).map((c) => [c.tier, c.url]), [[1, "https://app.ana.github.io/"], [3, "https://bob.github.io/x/"]]);
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
  // An h1 is the page's title and opens no section at all, "Portfolio" and "My Portfolio" included (the reviewer's case):
  // the employer is not a project, and /work/a is no own page from that heading alone.
  for (const title of ["Portfolio", "My Portfolio", "Projects"]) {
    const h1only = `<main><h1>${title}</h1><a href="https://p1.example/">p1</a><a href="https://employer.example/">job</a><p>more</p><a href="/work/a">a</a></main>`;
    assert.deepEqual(projectCandidates(homeProjectLinks({ html: h1only, url, finalUrl: url }), url).map((c) => [c.tier, c.url]), [[3, "https://p1.example/"], [3, "https://employer.example/"]], title);
  }
  // A page whose projects sit under an h1 alone is read by its projects elements: cards with a project class count.
  const cards = `<main><h1>Projects</h1><div class="project-card"><a href="https://p1.example/">p1</a><a href="/work/a">a</a></div><p><a href="https://employer.example/">job</a></p></main>`;
  assert.deepEqual(
    projectCandidates(homeProjectLinks({ html: cards, url, finalUrl: url }), url).map((c) => [c.tier, c.url]),
    [[1, "https://p1.example/"], [2, "https://ana.dev/work/a"], [3, "https://employer.example/"]]
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
  assert.deepEqual(Object.keys(f.project_candidates[0]).sort(), ["from", "kind", "tier", "url"]);
  // Without a projects page or buttons: no projects page is recorded.
  const plain = await measurePage({ html: fixture("www.masirjafri.in.home.html"), text: "", url, finalUrl: url }, { fetchImpl: ok });
  assert.equal(plain.project_links_from.projects_page, null);
  assert.equal(plain.project_links.checked, 1);
  assert.equal(codeChecks(plain).project_links, false);
});
