// The project-link follow-up to #278, from the fresh-25 live test (2026-11-22): lowered links cannot make the
// pass on their own, a bare "work" class is no projects element, profiles and certificates are not projects,
// a credit is never a project, and an address on a code host is not a portfolio site. Real markup, cut down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLinks, homeProjectLinks, isCodeHostAddress, measurePage, projectCandidates, projectLinksPass, projectLinksText } from "../pipeline/facts.mjs";
import { codeChecks } from "../pipeline/rubric.mjs";
import { urlNotPortfolio } from "../pipeline/junk-rules.mjs";

const ok = async () => new Response(null, { status: 200 });
const show = (html, url = "https://ana.dev/") => projectCandidates(homeProjectLinks({ html, url, finalUrl: url }), url).map((c) => [c.tier, c.url]);
const homeNav = `<nav><a href="/projects">Projects</a></nav><main><h1>Ana</h1></main>`;
async function viaPage(pp, ppUrl = "https://ana.dev/projects") {
  const url = "https://ana.dev/";
  return measurePage({ html: homeNav, text: "", url, finalUrl: url, projectsPage: { html: pp, finalUrl: ppUrl } }, { fetchImpl: ok });
}

test("links outside the projects never count (LOW_LINKS 'never', the default); 'beside' counts them next to one that loads", async () => {
  const low = (u) => ({ url: u, kind: "outbound", tier: 3 });
  const high = (u) => ({ url: u, kind: "outbound", tier: 1 });
  // The default: lowered links are never requested and never count, only named.
  const seen = [];
  const counting = async (u, init) => {
    seen.push(String(u));
    return ok(u, init);
  };
  const strict = await checkLinks([high("https://p.example/"), low("https://a.example/"), low("https://b.example/")], { fetchImpl: counting });
  assert.deepEqual([strict.checked, strict.ok, strict.not_counted], [1, 1, 2]);
  assert.ok(seen.every((u) => u.includes("p.example")), seen.join(" "));
  assert.equal(projectLinksText(strict, 3), "1 of 1 project links load; 2 other links on the page were not counted");
  const none = await checkLinks([low("https://a.example/"), low("https://b.example/"), low("https://c.example/"), low("https://d.example/")], { fetchImpl: ok });
  assert.deepEqual([none.checked, none.ok, none.not_counted], [0, 0, 4]);
  assert.equal(projectLinksPass(none, 3), false);
  assert.equal(projectLinksText(none, 3), "No project links found in a projects section; 4 other links on the page were not counted");
  // "beside": only lowered links, none found; one project link that loads lets them count toward the three.
  const beside = { lowLinks: "beside" };
  const noneA = await checkLinks([low("https://a.example/"), low("https://b.example/"), low("https://c.example/"), low("https://d.example/")], { fetchImpl: ok, ...beside });
  assert.deepEqual([noneA.checked, noneA.ok, noneA.not_counted], [0, 0, 4]);
  const one = await checkLinks([high("https://p.example/"), low("https://a.example/"), low("https://b.example/")], { fetchImpl: ok, ...beside });
  assert.deepEqual([one.checked, one.ok, one.not_counted], [3, 3, undefined]);
  assert.equal(projectLinksPass(one, 3), true);
  // A project link that does not load does not open the door; the text names what was left out.
  const down = async (u) => new Response(null, { status: String(u).includes("p.example") ? 404 : 200 });
  const broken = await checkLinks([high("https://p.example/"), low("https://a.example/"), low("https://b.example/"), low("https://c.example/")], { fetchImpl: down, ...beside });
  assert.deepEqual([broken.checked, broken.ok, broken.broken, broken.not_counted], [1, 0, 1, 3]);
  assert.equal(projectLinksText(broken, 3), "0 of 1 project links load; 3 other links on the page were not counted");
  // "all" (the re-pick of facts of version 1 and 2): every link counts.
  const all = await checkLinks([low("https://a.example/"), low("https://b.example/")], { fetchImpl: ok, lowLinks: "all" });
  assert.deepEqual([all.checked, all.ok, all.not_counted], [2, 2, undefined]);
  // Every own project page goes ahead of the lowest tier in the list of 8 (sujanbhatta.tech's 6 case studies).
  const many = `<section id="projects">${[1, 2, 3, 4].map((i) => `<a href="/projects/p${i}">p${i}</a>`).join("")}</section><p><a href="https://other.example/">o</a></p>`;
  const url = "https://ana.dev/";
  assert.deepEqual(projectCandidates(homeProjectLinks({ html: many, url, finalUrl: url }), url).map((c) => c.tier), [2, 2, 2, 2, 3]);
  // Candidates without a tier (a plain list, older stored facts) count as before.
  const plain = await checkLinks(["https://a.example/", "https://b.example/", "https://c.example/"], { fetchImpl: ok });
  assert.deepEqual([plain.checked, plain.ok, plain.not_counted], [3, 3, undefined]);
});

test("a tool list of hosts not on the tool-site list, on a projects page with no project links, does not pass (pure6)", async () => {
  const pp = `<main><h1>Projects</h1><section><h2>Tools I use</h2><a href="https://storybook.js.org/">Storybook</a><a href="https://chakra-ui.com/">Chakra</a><a href="https://www.electronjs.org/">Electron</a><a href="https://zod.dev/">Zod</a></section><div><img alt="shot"></div></main>`;
  const g = await viaPage(pp);
  assert.deepEqual(g.project_candidates.map((c) => c.tier), [3, 3, 3, 3]);
  assert.deepEqual([g.project_links.checked, g.project_links.not_counted], [0, 4]);
  assert.equal(codeChecks(g).project_links, false);
});

test("certificates and documentation links outside any projects section do not pass (aradhyapuneeth.github.io, galaxir.vercel.app)", async () => {
  const url = "https://aradhyapuneeth.github.io/";
  // aradhyapuneeth: certificates in section#credentials ("Proof, not promises."), a Devpost profile in the footer.
  const certs = `<main><h2>Proof, not promises.</h2><section id="credentials"><a href="https://learn.microsoft.com/api/credentials/share/en-us/PuneethAradhya-6002/ED2CB021D">MICROSOFT DevOps Engineer Expert</a><a href="https://learn.microsoft.com/en-us/users/puneetharadhya-6002/credentials/bb5ee1e11">Azure Developer</a><a href="https://graphacademy.neo4j.com/c/d453634b-d0a8-4a65-aecd-596ea13e7fce/">Neo4j Certified Professional</a><a href="https://www.credly.com/badges/091dfc79/linked_in_profile">Harness</a></section></main><div><a href="https://devpost.com/aradhyapuneeth">Devpost</a></div>`;
  assert.deepEqual(show(certs, url), []);
  // galaxir: documentation sites under "Galactic Tech Arsenal." / "Domain: Core Languages", lowered, and alone.
  const docs = `<main><h2>Milestones.</h2><h3>Winner - Best Open-Source AI Project</h3><a href="https://aegentrix-cs.vercel.app/">Explore AEGENTRIX</a><h2>Galactic Tech Arsenal.</h2><h3>Domain: Core Languages</h3><a href="https://en.cppreference.com/w/c">C</a><a href="https://isocpp.org/">C++</a><a href="https://www.oracle.com/java/">Java</a><a href="https://www.gnu.org/software/bash/">Bash</a></main>`;
  const g = await measurePage({ html: docs, text: "", url: "https://galaxir.vercel.app/", finalUrl: "https://galaxir.vercel.app/" }, { fetchImpl: ok });
  assert.ok(g.project_candidates.every((c) => c.tier === 3));
  assert.deepEqual([g.project_links.checked, g.project_links.not_counted], [0, 5]);
  assert.equal(codeChecks(g).project_links, false);
});

test("a bare 'work' class or id is no projects element, and an experience, network or credentials heading is never projects", () => {
  // nuwanjaliyagoda.com: employers in section.work-section under "Work Experiences"; the real projects follow.
  const nuwan = `<main><section class="work-section"><h2>Work Experiences</h2><h4>Associate Technical Lead</h4><a href="https://www.sph.com.sg/">SPH Media</a><a href="https://singlife.com/en">Singlife</a></section>
    <section><h2>Featured Projects</h2><a href="/projects/smart-inventory/">Smart Inventory Management System</a><a href="https://github.com/cepdnaclk/Smart-Agriculture">Codebase</a></section></main>`;
  assert.deepEqual(show(nuwan, "https://nuwanjaliyagoda.com/"), [
    [1, "https://github.com/cepdnaclk/Smart-Agriculture"],
    [2, "https://nuwanjaliyagoda.com/projects/smart-inventory/"],
    [3, "https://www.sph.com.sg/"],
    [3, "https://singlife.com/en"],
  ]);
  // sujanbhatta.tech: partner logos in section#work-connections, then six case studies under "Selected work / 06".
  const sujan = `<main><section id="work-connections"><h2>Network &amp; recognition.</h2><a href="https://www.ucla.edu/">UCLA</a><a href="https://www.usc.edu/">USC</a></section>
    <section><h2>Selected work / 06</h2><a href="/work">All projects</a><h3>Mobile AI agents</h3><a href="/work/llm-phone-automation">Explore project</a><h3>Research assistant</h3><a href="/work/health-assistant-hardening">Explore project</a><h3>Project workspace</h3><a href="/work/cross-platform-delivery">Explore project</a></section></main>`;
  assert.deepEqual(show(sujan, "https://sujanbhatta.tech/").map(([t, u]) => [t, u.replace("https://sujanbhatta.tech", "")]), [
    [2, "/work/llm-phone-automation"],
    [2, "/work/health-assistant-hardening"],
    [2, "/work/cross-platform-delivery"],
    [3, "https://www.ucla.edu/"],
    [3, "https://www.usc.edu/"],
  ]);
  // reaganhsu.com: div.work-item holds his employers under "Work"; not projects any more.
  assert.deepEqual(show(`<main><h2>Work</h2><div class="work-item">Member of Technical Staff at <a href="https://datacurve.ai/">Datacurve AI</a></div></main>`), [[3, "https://datacurve.ai/"]]);
  // Still projects: "my-work", "selected-work", "recent-work", "work-samples", "case-studies", and the plural "works"
  // (kentom.co.ke's "ul.works", its products); a "Clients" or "Certifications" heading inside a projects element is not.
  for (const cls of ["my-work", "selected-work", "recent-work", "work-samples", "case-studies", "featured-works", "works", "works-list"]) {
    assert.deepEqual(show(`<section class="${cls}"><a href="https://p.example/">p</a></section>`), [[1, "https://p.example/"]], cls);
  }
  for (const cls of ["work", "work-section", "work-grid", "work-item"]) {
    assert.deepEqual(show(`<section class="${cls}"><a href="https://p.example/">p</a></section>`), [[3, "https://p.example/"]], cls);
  }
  assert.deepEqual(show(`<section class="projects"><h2>Clients</h2><a href="https://client.example/">c</a></section>`), [[3, "https://client.example/"]]);
  assert.deepEqual(show(`<main><h2>Experience</h2><a href="https://job.example/">job</a><h3>Projects</h3><a href="https://p.example/">p</a></main>`), [[1, "https://p.example/"], [3, "https://job.example/"]]);
});

test("profiles and certificates are never project links; the same sites' project pages are", () => {
  const counted = (u) => show(`<section id="projects"><a href="${u}">x</a></section>`).length === 1;
  for (const u of ["https://vsco.co/ashzaeen/gallery", "https://devpost.com/ashzaeen?ref_content=user-portfolio", "https://gitlab.com/ana", "https://bitbucket.org/ana/", "https://huggingface.co/ana", "https://replit.com/@ana", "https://ana.itch.io/", "https://about.me/ana", "https://peerlist.io/naved",
    "https://learn.microsoft.com/api/credentials/share/en-us/Ana-6002/ED2CB021D", "https://learn.microsoft.com/en-us/users/ana-6002/credentials/bb5ee1e11", "https://www.credly.com/badges/091dfc79", "https://graphacademy.neo4j.com/c/d453634b/", "https://www.coursera.org/account/accomplishments/verify/X", "https://www.udemy.com/certificate/UC-1/", "https://www.freecodecamp.org/certification/ana/responsive-web-design"]) {
    assert.ok(!counted(u), u);
  }
  for (const u of ["https://devpost.com/software/ana-app", "https://gitlab.com/ana/project", "https://huggingface.co/spaces/ana/demo", "https://replit.com/@ana/game", "https://ana.itch.io/game", "https://learn.microsoft.com/en-us/samples/ana/x/", "https://ashzaeen.super.site/"]) {
    assert.ok(counted(u), u);
  }
});

test("a credit is never a project, its repository included; a repository in the projects stays", () => {
  // sanajitjana.github.io: "Powered by Hugo & Narrow" in a <p> of the page's bottom block (not a <footer>).
  const credit = `<section id="projects"><a href="https://github.com/sanajitjana/Food-Order-App">Food Order App</a></section>
    <div><p>© 2026 Sanajit Jana. All rights reserved.</p><p><span>Powered by</span>\n<a href="https://gohugo.io/">Hugo\n</a><span>&amp;</span>\n<a href="https://github.com/tom2almighty/hugo-narrow">Narrow</a></p></div>`;
  assert.deepEqual(show(credit), [[1, "https://github.com/sanajitjana/Food-Order-App"]]);
  for (const phrase of ["Theme by", "Designed by", "Built with", "Template:", "Made with ❤ by"]) {
    assert.deepEqual(show(`<footer><p>${phrase} <a href="https://github.com/someone/theme">x</a></p></footer><div><p>${phrase} <a href="https://credit.example/">y</a></p></div>`), [], phrase);
  }
  // In the projects, the same words describe the project: its repository stays tier 1.
  assert.deepEqual(show(`<section id="projects"><p>Built with React &amp; <a href="https://github.com/ana/app">source</a></p></section>`), [[1, "https://github.com/ana/app"]]);
  // A repository after a sentence that only mentions "built" earlier, in another block, is no credit.
  assert.deepEqual(show(`<p>I built this site.</p><p><a href="https://github.com/ana/site">Source</a></p>`), [[1, "https://github.com/ana/site"]]);
});

test("an address on a code host is not a portfolio site: no project links from the host's own menu", async () => {
  const url = "https://github.com/ThiagoSousa81";
  const html = `<header><div aria-label="Navigation Menu"><a href="https://docs.github.com/en">Docs</a><a href="https://github.blog/">Blog</a></div></header><main><div id="_R_17d_"><a href="https://learn.github.com/skills">Skills</a><a href="https://www.githubstatus.com/">Status</a><a href="https://docs.github.com/en/copilot">Copilot</a></div><a href="https://github.com/ThiagoSousa81/repo">repo</a></main>`;
  const g = await measurePage({ html, text: "", url, finalUrl: url }, { fetchImpl: ok });
  assert.deepEqual(g.project_candidates, []);
  assert.equal(projectLinksText(g.project_links, 3), "Project links: none found");
  for (const u of ["https://github.com/ana", "https://www.github.com/ana/portfolio", "https://gitlab.com/ana", "https://bitbucket.org/ana"]) {
    assert.ok(isCodeHostAddress(u), u);
    assert.ok(urlNotPortfolio(u), u);
  }
  for (const u of ["https://ana.github.io/", "https://ana.gitlab.io/", "https://ana.dev/"]) assert.ok(!isCodeHostAddress(u), u);
});

test("a project card's own header and a heading in a wrapper with no link do not hide the projects", () => {
  // hellosagar.vercel.app (a common template): each card's links sit in the card's <header>, inside a section.
  const cards = `<header><nav><a href="https://site.example/">nav</a></nav></header><main><section><h2>Other Noteworthy Projects</h2><div><div><header><div><a href="https://github.com/hellosagar/DrumKit" aria-label="GitHub Link"></a><a href="https://hellosagar.github.io/DrumKit/" aria-label="External Link"></a></div><h3>DrumKit</h3></header><footer><ul><li>HTML</li></ul></footer></div></div></section></main><footer><a href="https://credit.example/">x</a></footer>`;
  assert.deepEqual(show(cards, "https://hellosagar.vercel.app/"), [
    [1, "https://github.com/hellosagar/DrumKit"],
    [1, "https://hellosagar.github.io/DrumKit/"],
    [3, "https://site.example/"],
    [3, "https://credit.example/"],
  ]);
  // sahilbajajportfolio.vercel.app: the heading sits in its own wrapper with a "Projects" pill; the cards follow.
  const wrapped = `<section><h2>Skills</h2><div><span>C</span></div></section><section><div><div>Projects</div><h2>Check out my latest work</h2><p>Here are some of my projects.</p></div><div><div><h3>AlgoAnalyzer</h3><a href="https://github.com/sahilbajaj2004/AlgoAnalyzer">Source</a><a href="https://algo-analyzer.vercel.app/">Website</a></div></div></section>`;
  assert.deepEqual(show(wrapped, "https://sahilbajajportfolio.vercel.app/"), [[1, "https://github.com/sahilbajaj2004/AlgoAnalyzer"], [1, "https://algo-analyzer.vercel.app/"]]);
  // A heading wrapper that holds a link still ends the section with it.
  assert.deepEqual(show(`<section><div><h2>Projects</h2><a href="https://p.example/">p</a></div><div><a href="https://q.example/">q</a></div></section>`), [[1, "https://p.example/"], [3, "https://q.example/"]]);
});

test("the third 25 (2026-11-23): one real project beside a tool list fails, named project pages and products count", async () => {
  // gauravgrv.vercel.app: one repository under "Things I've built", then "What I work with": library sites.
  const gaurav = `<main><section id="work"><h2>Things I've built</h2><a href="https://github.com/Gaurav-1008/JobPilot">GitHub</a></section>
    <section><h2>What I work with</h2><a href="https://scikit-learn.org">Scikit-Learn</a><a href="https://pandas.pydata.org">Pandas</a><a href="https://dev.java">Java</a><a href="https://tableau.com">Tableau</a><a href="https://shap.readthedocs.io">SHAP</a></section></main>`;
  const url = "https://gauravgrv.vercel.app/";
  const g = await measurePage({ html: gaurav, text: "", url, finalUrl: url }, { fetchImpl: ok });
  assert.deepEqual([g.project_links.checked, g.project_links.ok, g.project_links.not_counted], [1, 1, 5]);
  assert.equal(codeChecks(g).project_links, false);
  // sebascherny.github.io: its case studies are pages at the site's root named "project-...".
  const seba = `<section id="latest-projects"><div class="work_grid_cell"><a href="project-sync.html"><h3>Dashboard</h3></a></div><div class="work_grid_cell"><a href="project-solar-energy.html"><h3>Solar</h3></a></div><a href="contact.html">Contact</a><a href="about.html">About</a></section>`;
  assert.deepEqual(show(seba, "https://sebascherny.github.io/"), [[2, "https://sebascherny.github.io/project-sync.html"], [2, "https://sebascherny.github.io/project-solar-energy.html"]]);
  // phyominthein.com: "git.", "linkedin." and "ig." on its own domain are short links to profiles, not its work.
  const phyo = `<section id="hero"><a href="https://git.phyominthein.com/">g</a><a href="https://linkedin.phyominthein.com/">l</a><a href="https://ig.phyominthein.com/">i</a><a href="https://weflix.phyominthein.com/">w</a></section>`;
  assert.deepEqual(show(phyo, "https://phyominthein.com/"), [[1, "https://weflix.phyominthein.com/"], [3, "https://git.phyominthein.com/"], [3, "https://linkedin.phyominthein.com/"], [3, "https://ig.phyominthein.com/"]]);
});

test("the words that mark a projects section, in English and other languages, whole words with Unicode boundaries", () => {
  const demos = `<div><a href="https://one.example/">Live</a></div><div><a href="https://two.example/">Live</a></div>`;
  const tiers = (html) => show(html).map(([t]) => t);
  for (const h of ["Projects", "Things I've built", "Selected work", "Case studies", "Featured", "Featured projects", "Open source", "Side projects", "Apps", "Experiments", "Lab", "Playground", "Builds", "Creations", "Products", "Showcase", "Portfolio", "Recent work", "What I've made", "Things I've made", "Some of my work", "My creations",
    "Projets", "Proyectos", "Mis proyectos", "Projekte", "Projetos", "Projetos pessoais", "Progetti", "Projecten", "Projekty", "Проекты", "Мои проекты", "Проекти", "项目", "我的项目", "專案", "作品", "プロジェクト", "프로젝트", "Portafolio", "Portfólio", "Trabajos", "Travaux"]) {
    assert.deepEqual(tiers(`<main><section><h2>${h}</h2>${demos}</section></main>`), [1, 1], h);
  }
  for (const attr of ['id="projetos"', 'id="proyectos"', 'class="apps"', 'class="lab"', 'id="featured"', 'class="open-source"', 'class="mis-proyectos"', 'id="проекты"']) {
    assert.deepEqual(tiers(`<main><section ${attr}>${demos}</section></main>`), [1, 1], attr);
  }
  // A not-projects word wins over a weak projects word; a strong one wins over it.
  for (const h of ["Featured clients", "Featured in", "Featured articles", "Open source contributions", "Milestones", "Collaborators", "Labels"]) {
    assert.deepEqual(tiers(`<main><section><h2>${h}</h2>${demos}</section></main>`), [3, 3], h);
  }
  assert.deepEqual(tiers(`<main><section><h2>Projects &amp; experience</h2>${demos}</section></main>`), [1, 1]);
  // Not inside other words: a class "label laboratory" is neither "lab".
  assert.deepEqual(tiers(`<main><section class="label laboratory">${demos}</section></main>`), [3, 3]);
});

test("a repository in a section that is not projects is lowered; a pull request or an issue is no repository", async () => {
  const url = "https://ana.dev/";
  const v = async (html) => {
    const f = await measurePage({ html, text: "", url, finalUrl: url }, { fetchImpl: ok });
    return [codeChecks(f).project_links, projectLinksText(f.project_links, f.v)];
  };
  assert.deepEqual(await v(`<main><section><h2>Contributions</h2><a href="https://github.com/facebook/react/pull/1">react</a><a href="https://github.com/vercel/next.js/pull/2">next</a><a href="https://github.com/nodejs/node/issues/3">node</a></section></main>`), [false, "Project links: none found"]);
  assert.deepEqual(await v(`<main><section><h2>Work Experience</h2><a href="https://github.com/acme/platform">Acme</a><a href="https://github.com/acme/api">api</a><a href="https://github.com/acme/web">web</a></section></main>`), [false, "No project links found in a projects section; 3 other links on the page were not counted"]);
  assert.deepEqual(await v(`<main><section><h2>Repos I like</h2><a href="https://github.com/a/b">b</a><a href="https://github.com/c/d">d</a><a href="https://github.com/e/f">f</a></section></main>`), [false, "No project links found in a projects section; 3 other links on the page were not counted"]);
  // Outside every labelled section a repository still counts.
  assert.deepEqual(await v(`<main><p><a href="https://github.com/ana/a">a</a><a href="https://github.com/ana/b">b</a><a href="https://github.com/ana/c">c</a></p></main>`), [true, "3 of 3 project links load"]);
});

test("a heading's link-less wrapper hands its section only to the next element; after it nothing is projects", () => {
  // The reviewer's cases: an about line and a "Clients" block after the cards are not projects.
  assert.deepEqual(show(`<main><div><h2>Projects</h2></div><div class="grid"><a href="https://one.example/">one</a></div><div><p>I worked at <a href="https://employer.example/">Employer</a> and studied at <a href="https://uni.example/">Uni</a>.</p></div></main>`), [[1, "https://one.example/"], [3, "https://employer.example/"], [3, "https://uni.example/"]]);
  assert.deepEqual(show(`<main><div><h2>Projects</h2></div><div><a href="https://one.example/">one</a></div><section><p class="title">Clients</p><a href="https://client1.example/">c1</a></section></main>`), [[1, "https://one.example/"], [3, "https://client1.example/"]]);
  // adhamdannaway.com: "<div><h3>Some of my latest work</h3></div><ul id="thumbs">" then the case studies.
  assert.deepEqual(show(`<section><div><div><h3>Some of my latest work</h3></div><ul id="thumbs"><li><a href="/portfolio/a">a</a></li><li><a href="/portfolio/b">b</a></li></ul><p><a href="https://other.example/">o</a></p></div></section>`), [[2, "https://ana.dev/portfolio/a"], [2, "https://ana.dev/portfolio/b"], [3, "https://other.example/"]]);
});

test("named project pages and credits with a few words, the reviewer's cases", () => {
  const inProj = (links) => `<main><section id="projects">${links}</section></main>`;
  assert.deepEqual(show(inProj(`<a href="/project-sync.html">x</a><a href="/work-dashboard">y</a><a href="/works-cited">z</a><a href="/portfolio-2019">p</a>`)).map(([, u]) => u), ["https://ana.dev/project-sync.html", "https://ana.dev/work-dashboard"]);
  assert.deepEqual(show(`<main><p>Made with care by <a href="https://github.com/ana/site">me</a></p></main>`), []);
  assert.deepEqual(show(`<main><p>Made with love and coffee by <a href="https://credit.example/">me</a></p></main>`), []);
});
