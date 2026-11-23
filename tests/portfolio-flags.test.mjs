// The suspicion flags (pipeline/portfolio-flags.mjs): pure, no network. Each
// flag is raised on a page shaped like the kind of miss it was designed from,
// and stays quiet on the real portfolios that look closest to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAGS,
  READING_PROBLEMS,
  blogFacts,
  blogOnly,
  companyVoice,
  fillerText,
  forwardsElsewhere,
  hiddenSpamLinks,
  linkCard,
  movedNotice,
  placeholderPage,
  portfolioFlags,
  productPage,
  readSite,
  readingProblems,
  readmePage,
  sellsTeaching,
  subPage,
  subPageAddress,
  subPageOutcome,
  unreadablePage,
} from "../pipeline/portfolio-flags.mjs";

const page = (body, { title = "", url = "https://ana.dev/", name = "Ana Ruiz", ...rest } = {}) => ({
  url,
  finalUrl: url,
  name,
  html: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
  ...rest,
});
const flagNames = (site) => portfolioFlags(site).map((f) => f.flag);
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A real portfolio: projects, an about, a blog link and dated posts beside the work.
const PORTFOLIO = page(
  `
<nav><a href="/">Home</a><a href="#projects">Projects</a><a href="/blog">Blog</a></nav>
<h1>Hi, I'm Ana Ruiz</h1><p>I'm a frontend developer. I build design systems and tools.</p>
<section id="projects"><h2>Projects</h2>
<article><h3>Tidy</h3><p>A task app.</p><a href="https://tidy.app">Live</a> <a href="https://github.com/ana/tidy">Code</a></article>
<article><h3>Plot</h3><p>Charts.</p><a href="https://github.com/ana/plot">Code</a></article></section>
<section><h2>Writing</h2>
${[1, 2, 3, 4, 5, 6].map((i) => `<p><a href="/blog/post-${i}">Post ${i}</a> <time>${months[i]} ${i}, 2026</time></p>`).join("\n")}</section>
<footer><a href="mailto:ana@ana.dev">Email</a> <a href="https://github.com/ana">GitHub</a></footer>`,
  { title: "Ana Ruiz - Frontend developer" }
);

// Only a blog: dated posts, in <article> and <time>, linking to the site's own post pages.
const posts = (n, extra = "") =>
  Array.from({ length: n }, (_, i) => `<article><h2><a href="/blog/post-${i}">Post ${i}</a></h2><time>${months[i % 12]} ${i + 1}, 2026</time>${extra}</article>`).join("\n");
const BLOG = page(`<nav><a href="/">Home</a><a href="/tags">Tags</a><a href="/about">About</a></nav><h1>Abdul's Blog</h1>${posts(6)}`);

test("a real portfolio with a blog raises no flag, and its blog facts say why", () => {
  assert.deepEqual(flagNames(PORTFOLIO), []);
  const b = blogFacts(PORTFOLIO);
  assert.equal(b.hasBlog, true);
  assert.equal(b.verdict, null);
  assert.match(b.why, /6 dated posts, but also a projects entry in its menu \("Projects"\): not only a blog/);
});

test("every flag returns its name, a sentence and the snippets, or null", () => {
  for (const [name, fn] of Object.entries(FLAGS)) assert.equal(fn(PORTFOLIO), null, name);
  const r = fillerText(page("<h1>Thomas</h1><p>Lorem ipsum dolor sit amet consectetur adipisicing elit.</p>"));
  assert.equal(r.flag, "filler-text");
  assert.match(r.reason, /^The text contains filler: "Lorem ipsum dolor sit amet/);
  assert.ok(r.snippets.length >= 1);
});

test("filler-text: Lorem ipsum, and the fill-in-the-blank family", () => {
  assert.equal(fillerText(page("<p>Your name here</p><p>Frontend developer</p>"))?.flag, "filler-text");
  assert.equal(fillerText(page("<p>I write about Latin. Dolores is my cat.</p>")), null);
});

test("placeholder-page: a short coming-soon page; any project evidence protects", () => {
  const soon = page("<h1>Vaibhav Singh</h1><p>Hey there! I'm currently cooking up something exciting for this space.</p>");
  assert.equal(placeholderPage(soon)?.flag, "placeholder-page");
  assert.match(placeholderPage(soon).reason, /shows no projects and says "cooking up something"/);
  const long = page(`<h1>Ana</h1><p>${"I build tools for teams. ".repeat(40)}</p><p>My next app is coming soon.</p>`);
  assert.equal(placeholderPage(long), null);
  const joke = page(`<h1>Robert Zheng</h1><p>permanent... under construction</p><nav><a href="#projects">Projects</a></nav>`);
  assert.equal(placeholderPage(joke), null);
  // A short portfolio with two project links and "Blog: coming soon".
  const two = page(`<h1>Ana</h1><p><a href="https://github.com/ana/tidy">Tidy</a> <a href="https://github.com/ana/plot">Plot</a></p><p>Blog: coming soon</p>`);
  assert.equal(placeholderPage(two), null);
});

test("unreadable-page: not a flag; says the code could not read the page", () => {
  const r = unreadablePage(page("<div>ælarassi</div>"));
  assert.equal(r.flag, "unreadable-page");
  assert.equal(r.reason, 'The code could not read this page: it shows only 8 characters of text ("ælarassi").');
  assert.equal(unreadablePage(PORTFOLIO), null);
  // Never one of the flags, never in portfolioFlags; only in the reading problems.
  assert.ok(!Object.values(FLAGS).includes(unreadablePage));
  assert.ok(!Object.keys(FLAGS).some((n) => /little|unreadable/.test(n)));
  assert.deepEqual(flagNames(page("<div>ælarassi</div>")), []);
  assert.deepEqual(Object.keys(READING_PROBLEMS), ["unreadable-page"]);
  assert.equal(readingProblems(page("<div>ælarassi</div>"))[0].flag, "unreadable-page");
});

test("moved-notice: a forwarding notice; not a person who moved city, nor a profile link", () => {
  const r = movedNotice(page('<h1>THIS PAGE HAS MOVED</h1><p>You can find me at akhshy.dev</p><a href="https://akhshy.dev">Take me there</a>', { url: "https://akhshyganesh.github.io/" }));
  assert.equal(r.flag, "moved-notice");
  assert.match(r.reason, /akhshy\.dev/);
  const moved = movedNotice(page('<p>We moved to rafalazar</p><a href="https://rafalazar.vercel.app">go</a>', { url: "https://rafalazar.github.io/" }));
  assert.equal(moved?.flag, "moved-notice");
  assert.equal(movedNotice(page("<h1>Ana</h1><p>I moved to Berlin in 2019 and joined a startup.</p>")), null);
  assert.equal(movedNotice(page('<h1>Ana</h1><p>Developer. Find me at github.com</p><a href="https://github.com/ana">GitHub</a>')), null);
  assert.equal(movedNotice(page(`<nav><a href="/projects">Projects</a></nav><h1>Hi. I'm Dima.</h1><p>This site has moved on from v1.</p>`)), null);
});

test("blog-only: dated posts in a post structure and nothing else", () => {
  const r = blogOnly(BLOG);
  assert.equal(r.flag, "blog-only");
  assert.equal(r.reason, "The page has 6 dated posts and no projects, project links, projects menu, case studies or work history: only a blog.");
  // Four posts are not enough.
  assert.equal(blogOnly(page(`<h1>Blog</h1>${posts(4)}`)), null);
  // Posts linked under the site's own blog path count without <time>.
  const linked = page(`<h1>Notes</h1>${Array.from({ length: 6 }, (_, i) => `<p><a href="/posts/n-${i}">N ${i}</a> ${months[i]} ${i + 2}, 2025</p>`).join("")}`);
  assert.equal(blogOnly(linked)?.flag, "blog-only");
});

test("blog-only never flags a portfolio with a blog: menu entries, buttons, project pages, headings, links", () => {
  for (const [what, swap] of [
    ["a Projects menu link", '<a href="/projects">Projects</a>'],
    ["a Work menu link", '<a href="/work">Work</a>'],
    ["a decorated label", '<a href="/x">/Projects</a>'],
    ["a dropdown button", '<button type="button">Projects</button>'],
    ["own project pages", '<a href="/projects/robot-arm">Robot arm</a>'],
  ]) {
    const site = page(BLOG.html.replace('<a href="/about">About</a>', swap));
    assert.equal(blogOnly(site), null, what);
  }
  // 14 posts and three projects under "Work" or "Open source".
  for (const h of ["Work", "Open source"]) {
    const site = page(`<h1>Blog</h1>${posts(14)}<h2>${h}</h2><p><a href="https://github.com/x/a">a</a> <a href="https://github.com/x/b">b</a> <a href="https://github.com/x/c">c</a></p>`);
    assert.equal(blogOnly(site), null, h);
  }
  // A page of whole posts that names a repository inside them: any project link protects.
  const repo = page(BLOG.html.replace("</article>", '<p><a href="https://github.com/abdul/tool">My tool</a></p></article>'));
  assert.equal(blogOnly(repo), null);
  // Dated case-study posts are work.
  assert.equal(blogOnly(page(`<h1>Case studies</h1>${posts(6, "<p>Case study</p>")}`)), null);
});

test("blog-only: a digital resume with posts is never only a blog", () => {
  const resume = page(`<h1>Karunika</h1><h2>Experience</h2><p>Engineer at Acme</p><h2>Writing</h2>${posts(6)}`);
  assert.equal(blogOnly(resume), null);
  assert.match(blogFacts(resume).why, /a resume or work history \("Experience"\): a digital resume/);
});

test("blog-only: calendars, talks, job timelines and month-less words are not posts", () => {
  // A contribution calendar in ISO dates and in words.
  const iso = Array.from({ length: 120 }, (_, i) => new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10));
  const words = iso.map((d) => {
    const t = new Date(`${d}T00:00:00Z`);
    return `No contributions on ${months[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
  });
  for (const cal of [iso, words]) {
    const site = page(`<h1>Ana</h1><div>${cal.map((d) => `<time>${d}</time>`).join(" ")}</div>`);
    assert.ok(blogFacts(site).posts < 5, cal[0]);
    assert.equal(blogOnly(site), null);
  }
  // A talks list: "30 min" is not a reading time.
  const talks = page(`<h1>Talks</h1>${Array.from({ length: 8 }, (_, i) => `<time>Talk at Conf ${i} · 30 min</time>`).join("")}`);
  assert.equal(blogFacts(talks).posts, 0);
  // A job timeline in "01.02.2011" dates under a work history.
  const jobs = page(`<h1>Ana</h1><h2>Work history</h2>${Array.from({ length: 6 }, (_, i) => `<p><time>01.0${i + 1}.201${i}</time> Engineer</p>`).join("")}`);
  assert.equal(blogOnly(jobs), null);
  // "Note 3, 2024" and "Semester 1 2023" have no month.
  const notes = page(`<h1>Ana</h1>${Array.from({ length: 6 }, (_, i) => `<p><a href="/blog/n${i}">x</a> <time>Note ${i + 1}, 2024</time> Semester ${i} 2023</p>`).join("")}`);
  assert.equal(blogFacts(notes).posts, 0);
});

test("blog-only: a 'Featured essays' heading and root post slugs are a blog's, a long post title is not a resume", () => {
  const slugs = Array.from({ length: 6 }, (_, i) => `<li><a href="/how-to-build-thing-number-${i}">Post ${i}</a> ${months[i]} ${i + 3}, 2026</li>`).join("");
  const home = page(`<h1>Ashwin</h1><h2>Featured essays, ideas and more</h2><ul>${slugs}</ul><h3>An exceptional user experience in retail with search</h3>`);
  assert.equal(blogOnly(home)?.flag, "blog-only");
  // The same list under a real projects heading is a portfolio.
  assert.equal(blogOnly(page(home.html.replace("Featured essays, ideas and more", "Featured projects"))), null);
});

test("blog-only: 'read more' links alone are not posts (testimonials have them)", () => {
  const recs = page(`<h1>Andrew Smith</h1>${"<blockquote>Great engineer. <a href='/r'>Read more</a></blockquote>".repeat(6)}`);
  assert.equal(blogOnly(recs), null);
});

test("link-card: a contact card, for the owner to rule on; work words or own pages protect", () => {
  const card = page(`<h1>Damian Markowski</h1><p>Results-driven Technical Leader</p>
    <a href="https://linkedin.com/in/dm">LinkedIn</a> <a href="https://x.com/dm">X</a> <a href="https://chess.com/member/dm">Chess.com</a>
    <a href="mailto:contact@dm.com">contact@dm.com</a>`);
  const r = linkCard(card);
  assert.equal(r?.flag, "link-card");
  assert.match(r.reason, /a contact card\.$/);
  const world = page(`<a href="#links">Skip to portfolio links</a><h1>Dor</h1><p>Senior engineer</p>
    <a href="https://github.com/dor">GitHub</a> <a href="https://linkedin.com/in/dor">LinkedIn</a>`);
  assert.equal(linkCard(world), null);
});

test("company-voice: we, our services and a team; a freelancer or a one-person studio is protected; two names are said", () => {
  const agency = page(`<h1>Beter Bekend</h1><p>We build websites. We design shops. Our clients love our work. We help you grow.
    We are a team. Our team of developers builds what we promise. We deliver. Our services: web, shops. Careers: we're hiring.</p>`);
  const r = companyVoice(agency);
  assert.equal(r?.flag, "company-voice");
  assert.match(r.reason, /speaks as "we" \d+ times against "I" 0 times/);
  const one = companyVoice(page(`<p>I like it. We build. We design. We deliver. We help. Our clients. Our services. We create. We develop.</p>`));
  assert.match(one.reason, /against "I" 1 time and/);
  const freelancer = page(`<h1>Dilip</h1><p>I'm a freelance web developer. We build websites. We design shops. Our clients love our work.
    We help you grow. Our services: web, shops. We deliver what we promise. Our team is me. Hire me.</p>`);
  assert.equal(companyVoice(freelancer), null);
  const studio = page(`<h1>Rahnoxa</h1><p>Rahnoxa is a consultancy founded and run by an independent software engineer.
    We build apps. We design systems. We deliver. Our services. Our pricing. We help. We create. Our clients.</p>`);
  assert.equal(companyVoice(studio), null);
  const couple = companyVoice(page(`<p>We are Anna and Ben. We build apps. We design systems. We deliver. Our services. Our pricing. We help. Our clients.</p>`));
  assert.match(couple.reason, /It names two people \("Anna and Ben"\): possibly a two-person studio/);
  assert.doesNotMatch(r.reason, /two people/);
});

test("sells-teaching: coaching, a book and speaking, with no projects", () => {
  const coach = page(`<h1>Michelle Brenner</h1><p>Coaching. Speaking. Buy my book! Michelle is a professional speaker.</p>
    <a href="/book">Book a call</a>`);
  assert.equal(sellsTeaching(coach)?.flag, "sells-teaching");
  assert.equal(sellsTeaching(page(`${PORTFOLIO.html}<p>Coaching and a masterclass for juniors.</p>`)), null);
});

const PRODUCT_PARTS_HTML = `<p>Free online calculators. No sign-up.</p><a href="/faq">FAQ</a>
  <a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a><p>165 calculators, it's free.</p>`;

test("product-page: a tool's own site with no person behind it", () => {
  const tool = page(`<h1>Calzye</h1>${PRODUCT_PARTS_HTML}<p>Freelance rate calculator.</p>`, { url: "https://calzye.com/", name: "Calzye" });
  assert.equal(productPage(tool)?.flag, "product-page");
});

test("product-page: a person, a one-person studio or a one-word name on a personal host is never a product", () => {
  const person = page(`<h1>Ana Ruiz</h1><p>I made a calculator. I wrote it in a week. My users like it.</p>${PRODUCT_PARTS_HTML}`);
  assert.equal(productPage(person), null);
  const solo = page(`<h1>Rahnoxa</h1><p>Rahnoxa is a consultancy founded and run by an independent software engineer.</p>${PRODUCT_PARTS_HTML}`, { url: "https://rahnoxa.antideploy.com/", name: "Rahul Kumar" });
  assert.equal(productPage(solo), null);
  const darshan = page(`<h1>Darshan</h1>${PRODUCT_PARTS_HTML}`, { url: "https://darshan.is-a.dev/", name: "Darshan" });
  assert.equal(productPage(darshan), null);
});

test("readme-page: a repository's README rendered as the page", () => {
  const readme = page(`<h1>MyPortfolio</h1><h2>Getting started</h2><pre>git clone https://github.com/a/b
cd b
npm install</pre><h2>Repository structure</h2><pre>├── app</pre><h2>License</h2><p>MIT License</p>`);
  assert.equal(readmePage(readme)?.flag, "readme-page");
  assert.equal(readmePage(page("<p>I set up CI/CD workflows. Contributing to open source. Ran on localhost:3000.</p>")), null);
});

const SPAM = (style, words = ["casino bonus", "slot gacor", "xxx videos", "viagra online"]) =>
  `<marquee style="${style}">${words.map((w, i) => `<a href="https://spam${i}.example/" title="${w}">${w}</a>`).join("")}</marquee>`;

test("hidden-spam-links: spam links in an invisible block; the reason never repeats them", () => {
  const hacked = page(`<h1>Naveed</h1><p>${"An essay. ".repeat(20)}</p>${SPAM("position: absolute; width: 0px;")}`, { url: "https://www.trixum.net/" });
  const r = hiddenSpamLinks(hacked);
  assert.equal(r?.flag, "hidden-spam-links");
  assert.match(r.reason, /^The page hides 4 links to other sites about adult content and gambling and pharmacy in an invisible block: the site appears to have been compromised\.$/);
  for (const w of ["casino", "gacor", "xxx", "viagra", "spam0"]) assert.ok(!JSON.stringify(r).includes(w), w);
  // The server's own HTML counts when the rendered page dropped it.
  assert.equal(hiddenSpamLinks({ ...page("<h1>Naveed</h1>"), plainHtml: `<body>${SPAM("width:0")}</body>` })?.flag, "hidden-spam-links");
  for (const style of ["display:none", "visibility: hidden", "font-size:0", "left:-9999px", "height: 0"]) {
    assert.equal(hiddenSpamLinks(page(SPAM(style).replace(/marquee/g, "div")))?.flag, "hidden-spam-links", style);
  }
});

test("hidden-spam-links: hidden menus, opacity 0, the hidden attribute and fewer than 3 spam links stay quiet", () => {
  const menu = `<div style="display:none"><a href="https://github.com/ana">GitHub</a><a href="https://x.com/ana">X</a><a href="https://blog.example/">Blog</a></div>`;
  assert.equal(hiddenSpamLinks(page(menu)), null);
  assert.equal(hiddenSpamLinks(page(SPAM("opacity: 0").replace(/marquee/g, "div"))), null);
  assert.equal(hiddenSpamLinks(page(`<div hidden>${SPAM("").replace(/<\/?marquee[^>]*>/g, "")}</div>`)), null);
  assert.equal(hiddenSpamLinks(page(SPAM("width:0", ["casino", "slot gacor", "my portfolio", "GitHub"]))), null);
  // Visible spam links are a different problem: this flag is about a hidden block.
  assert.equal(hiddenSpamLinks(page(SPAM("color: red").replace(/marquee/g, "div"))), null);
});

test("forwards-elsewhere: builds on the health check's redirect verdict; the person's own other domain is not flagged", () => {
  const moved = page("<h1>Siadialiga</h1><p>Software solutions.</p>", { url: "https://batuhan.tech/", finalUrl: "https://siadialiga.com/", name: "Batuhan Yilmaz", redirect: { moved: true, hijack: true, to: "siadialiga.com" } });
  assert.match(forwardsElsewhere(moved).reason, /^The listed address forwards to siadialiga\.com, and the page there does not carry the name "Batuhan Yilmaz"/);
  const company = page("<h1>Welcome SIADIALIGA</h1><p>founded by batuhan and demir. software solutions.</p>", { url: "https://batuhan.tech/", finalUrl: "https://siadialiga.com/", name: "Batuhan Eroglu", redirect: { moved: true, hijack: false, to: "https://siadialiga.com/" } });
  assert.match(forwardsElsewhere(company).reason, /forwards to siadialiga\.com, a domain without the person's name, and the page there carries only "batuhan" of "Batuhan Eroglu"/);
  // A forward that keeps the listed host's handle: oyi77.github.io to oyi77.is-a.dev, even when the check says hijack.
  const own = page("<h1>Paijo</h1>", { url: "https://oyi77.github.io/", finalUrl: "https://oyi77.is-a.dev/", name: "Muchammad Fikri Izzuddin", redirect: { moved: true, hijack: true, to: "is-a.dev" } });
  assert.equal(forwardsElsewhere(own), null);
  const named = page("<h1>Ana Ruiz</h1>", { url: "https://ana.netlify.app/", finalUrl: "https://studio.dev/", redirect: { moved: true, hijack: false, to: "studio.dev" } });
  assert.equal(forwardsElsewhere(named), null);
  assert.equal(forwardsElsewhere({ ...moved, redirect: null }), null);
});

test("subPageAddress: file names, personal pages on shared hosts, and shared hosts", () => {
  assert.equal(subPageAddress("https://ana.dev/"), null);
  assert.equal(subPageAddress("https://ana.dev/index.html"), null);
  assert.deepEqual(subPageAddress("https://ashwinhariharan.com/software-engineering"), { home: "https://ashwinhariharan.com/", path: "/software-engineering", pathIsSite: false, portfolioPath: false, sharedHost: false });
  assert.equal(subPageAddress("https://ana.github.io/Portfolio/").pathIsSite, true);
  assert.equal(subPageAddress("https://vale.rocks/portfolio").portfolioPath, true);
  assert.equal(subPageAddress("https://ana.dev/portfolio.html").portfolioPath, true);
  assert.equal(subPageAddress("https://ana.dev/site/portfolio.html").portfolioPath, true);
  assert.equal(subPageAddress("https://cs.example.edu/~jd/").pathIsSite, true);
  assert.equal(subPageAddress("https://cs.example.edu/people/jane-doe").pathIsSite, true);
  assert.equal(subPageAddress("https://github.com/ana/portfolio").sharedHost, true);
  assert.equal(subPageAddress("https://cs.example.edu/news/x").sharedHost, true);
});

test("sub-page: the outcomes, in plain words, and the legitimate ones never flagged", () => {
  const category = { ...BLOG, url: "https://ashwin.dev/software-engineering", finalUrl: "https://ashwin.dev/software-engineering" };
  assert.equal(subPageOutcome({ ...category, home: { plainHtml: PORTFOLIO.html } }).outcome, "home-is-portfolio");
  assert.match(subPage({ ...category, home: { plainHtml: PORTFOLIO.html } }).reason, /the listing should point at the home page/);
  assert.equal(subPageOutcome({ ...category, home: { plainHtml: BLOG.html } }).outcome, "home-not-portfolio");
  const r = subPage({ ...category, home: { plainHtml: BLOG.html } });
  assert.match(r.reason, /is not a portfolio either: it is only a blog\.$/);
  assert.doesNotMatch(r.reason, /blog-only|company-voice/);
  assert.equal(subPageOutcome(category).outcome, "home-not-read");
  // A github.io project site, a "/portfolio" path, a file-name path, a university page or any sub-page with projects.
  for (const url of ["https://ana.github.io/Portfolio/", "https://ana.dev/portfolio", "https://ana.dev/portfolio.html", "https://ana.dev/about-ana", "https://cs.example.edu/~jd/"]) {
    const s = { ...PORTFOLIO, url, finalUrl: url };
    assert.equal(subPageOutcome(s).outcome, "sub-page-is-portfolio", url);
    assert.equal(subPage(s), null, url);
  }
  // A university page that shows no projects is still the person's own page, never judged by the department's.
  const prof = { ...BLOG, url: "https://cs.example.edu/~jd/", finalUrl: "https://cs.example.edu/~jd/", home: { plainHtml: BLOG.html } };
  assert.equal(subPage(prof), null);
  // A code host's repository page: its home page is never the person's.
  const repo = { ...page("<h1>portfolio</h1><p>Some README text about things.</p>"), url: "https://github.com/ana/portfolio", finalUrl: "https://github.com/ana/portfolio", home: { plainHtml: BLOG.html } };
  assert.equal(subPageOutcome(repo).outcome, "shared-host");
  assert.equal(subPage(repo), null);
  // The name in the path is a whole word or the whole name run together, not any substring.
  const named = { ...page("<h1>Sam</h1><p>Software engineer.</p>"), url: "https://dinq.me/samlee", finalUrl: "https://dinq.me/samlee", name: "Sam Lee" };
  assert.equal(subPageOutcome(named).outcome, "sub-page-is-portfolio");
  assert.equal(subPageOutcome({ ...named, url: "https://portfolic.vercel.app/samlee01", finalUrl: "https://portfolic.vercel.app/samlee01" }).outcome, "sub-page-is-portfolio");
  const lalith = { ...page("<h1>Data Scientist</h1>"), url: "https://portfolic.vercel.app/lalithdabilpuram01", finalUrl: "https://portfolic.vercel.app/lalithdabilpuram01", name: "Lalith" };
  assert.equal(subPageOutcome(lalith).outcome, "sub-page-is-portfolio");
  const loose = { ...BLOG, url: "https://x.dev/samples/leeks", finalUrl: "https://x.dev/samples/leeks", name: "Sam Lee", home: { plainHtml: BLOG.html } };
  assert.equal(subPageOutcome(loose).outcome, "home-not-portfolio");
  assert.equal(subPageOutcome(PORTFOLIO), null);
});

test("contact details never reach a reason or a snippet", () => {
  const card = page(`<h1>Ana</h1><p>Engineer. jane@example.com +1 (555) 123-4567</p>
    <a href="https://linkedin.com/in/a">LinkedIn</a> <a href="https://x.com/a">X</a> <a href="https://wa.me/15551234567">WhatsApp</a> <a href="tel:+15551234567">Call</a>`);
  const tiny = page("<p>jane@example.com</p>");
  const soon = page("<h1>Ana</h1><p>Coming soon. Write to jane@example.com or wa.me/15551234567</p>");
  const out = JSON.stringify([...portfolioFlags(card), ...portfolioFlags(soon), ...readingProblems(tiny)]);
  assert.ok(out.length > 50);
  for (const secret of ["jane@example.com", "555", "15551234567"]) assert.ok(!out.includes(secret), secret);
  assert.match(readingProblems(tiny)[0].reason, /\[email\]/);
});

test("bounded: a huge page of unclosed tags is read quickly, and a changed site object is read again", () => {
  const huge = page(`${"<p>unclosed ".repeat(30000)}${"<h2>open ".repeat(10000)}${"<div style=\"display:none\">".repeat(5000)}`);
  const t0 = Date.now();
  portfolioFlags(huge);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const site = page("<h1>Ana</h1><p>Lorem ipsum dolor sit amet.</p>");
  assert.equal(fillerText(site)?.flag, "filler-text");
  site.html = PORTFOLIO.html;
  assert.equal(fillerText(site), null);
  assert.equal(readSite(site).projects.any, true);
});

test("reads the plain HTML when there is no rendered copy, and never throws on an empty site", () => {
  assert.equal(unreadablePage({ url: "https://a.dev/", plainHtml: "<p>Hi</p>" })?.flag, "unreadable-page");
  assert.doesNotThrow(() => portfolioFlags({}));
  assert.doesNotThrow(() => portfolioFlags({ url: "not a url", html: "<a href='/x'>x</a>" }));
});
