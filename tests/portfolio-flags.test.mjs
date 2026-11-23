// The suspicion flags (pipeline/portfolio-flags.mjs): pure, no network. Each
// flag is raised on a page shaped like the miss it was designed from, and stays
// quiet on the real portfolios that look closest to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLAGS,
  blogFacts,
  blogOnly,
  companyVoice,
  fillerText,
  forwardsElsewhere,
  linkCard,
  littleText,
  movedNotice,
  placeholderPage,
  portfolioFlags,
  productPage,
  readmePage,
  sellsTeaching,
  singleDocument,
  subPage,
  subPageAddress,
  subPageOutcome,
} from "../pipeline/portfolio-flags.mjs";

const page = (body, { title = "", url = "https://ana.dev/", name = "Ana Ruiz", ...rest } = {}) => ({
  url,
  finalUrl: url,
  name,
  html: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
  ...rest,
});
const flagNames = (site) => portfolioFlags(site).map((f) => f.flag);

// A real portfolio: projects, an about, a blog link and a few dated posts beside the work.
const PORTFOLIO = page(`
<nav><a href="/">Home</a><a href="#projects">Projects</a><a href="/blog">Blog</a></nav>
<h1>Hi, I'm Ana Ruiz</h1><p>I'm a frontend developer. I build design systems and tools.</p>
<section id="projects"><h2>Projects</h2>
<article><h3>Tidy</h3><p>A task app.</p><a href="https://tidy.app">Live</a> <a href="https://github.com/ana/tidy">Code</a></article>
<article><h3>Plot</h3><p>Charts.</p><a href="https://github.com/ana/plot">Code</a></article></section>
<section><h2>Writing</h2>
<p><a href="/blog/a">Shipping a design system</a> March 3, 2026</p>
<p><a href="/blog/b">Notes on charts</a> February 1, 2026</p>
<p><a href="/blog/c">On testing</a> January 9, 2026</p>
<p><a href="/blog/d">Hello</a> December 2, 2025</p></section>
<footer><a href="mailto:ana@ana.dev">Email</a> <a href="https://github.com/ana">GitHub</a></footer>`, { title: "Ana Ruiz - Frontend developer" });

test("a real portfolio with a blog raises no flag", () => {
  assert.deepEqual(flagNames(PORTFOLIO), []);
  const b = blogFacts(PORTFOLIO);
  assert.equal(b.hasBlog, true);
  assert.equal(b.verdict, null);
  assert.match(b.why, /a portfolio with a blog/);
});

test("every flag returns its name, a sentence and the snippets, or null", () => {
  for (const [name, fn] of Object.entries(FLAGS)) {
    assert.equal(fn(PORTFOLIO), null, name);
  }
  const r = fillerText(page("<h1>Thomas</h1><p>Lorem ipsum dolor sit amet consectetur adipisicing elit.</p>"));
  assert.equal(r.flag, "filler-text");
  assert.match(r.reason, /^The text contains filler: "Lorem ipsum dolor sit amet/);
  assert.ok(r.snippets.length >= 1);
});

test("filler-text: Lorem ipsum, and the fill-in-the-blank family", () => {
  assert.equal(fillerText(page("<p>Your name here</p><p>Frontend developer</p>"))?.flag, "filler-text");
  assert.equal(fillerText(page("<p>I write about Latin. Dolores is my cat.</p>")), null);
});

test("placeholder-page: a short coming-soon page, not a long page that mentions it", () => {
  const soon = page("<h1>Vaibhav Singh</h1><p>Hey there! I'm currently cooking up something exciting for this space.</p>");
  assert.equal(placeholderPage(soon)?.flag, "placeholder-page");
  assert.match(placeholderPage(soon).reason, /"cooking up something"/);
  const long = page(`<h1>Ana</h1><p>${"I build tools for teams. ".repeat(40)}</p><p>My next app is coming soon.</p>`);
  assert.equal(placeholderPage(long), null);
});

test("little-text: almost nothing to read, said as what the code sees", () => {
  const r = littleText(page("<div>ælarassi</div>"));
  assert.equal(r.flag, "little-text");
  assert.equal(r.reason, 'The page shows only 8 characters of text: "ælarassi".');
  assert.equal(littleText(PORTFOLIO), null);
});

test("moved-notice: a short page that forwards a visitor by hand", () => {
  const r = movedNotice(page('<h1>THIS PAGE HAS MOVED</h1><p>You can find me at akhshy.dev</p><a href="https://akhshy.dev">Take me there</a>', { url: "https://akhshyganesh.github.io/" }));
  assert.equal(r.flag, "moved-notice");
  assert.match(r.reason, /akhshy\.dev/);
  assert.equal(movedNotice(page(`<p>${"I moved to Berlin in 2019 and joined a startup. ".repeat(40)}</p>`)), null);
});

const BLOG = page(`
<nav><a href="/">Home</a><a href="/tags">Tags</a><a href="/about">About</a></nav>
<h1>Abdul's Blog</h1>
<article><h2><a href="/p/1">Three dots</a></h2><p>Published on November 3, 2026</p></article>
<article><h2><a href="/p/2">Retail investors</a></h2><p>Published on October 25, 2026</p></article>
<article><h2><a href="/p/3">Next.js to Astro</a></h2><p>Published on March 14, 2026</p></article>
<article><h2><a href="/p/4">Hello</a></h2><p>Published on January 2, 2026</p></article>`);

test("blog-only: dated posts and no projects anywhere", () => {
  const r = blogOnly(BLOG);
  assert.equal(r.flag, "blog-only");
  assert.equal(r.reason, "The page has 4 dated posts and no projects section, project heading, projects menu link or project link.");
});

test("blog-only never flags a blog beside projects: a projects menu link, heading or link protects it", () => {
  const withMenu = page(BLOG.html.replace('<a href="/about">About</a>', '<a href="/projects">Projects</a>'));
  assert.equal(blogOnly(withMenu), null);
  assert.match(blogFacts(withMenu).why, /a projects link in its menu \("Projects"\)/);
  const withWork = page(BLOG.html.replace('<a href="/about">About</a>', '<a href="/work">Work</a>'));
  assert.equal(blogOnly(withWork), null);
  const withRepo = page(BLOG.html.replace("</article>", '<p><a href="https://github.com/abdul/tool">My tool</a></p></article>'));
  assert.equal(blogOnly(withRepo), null);
});

test("blog-only: 'read more' links alone are not posts (testimonials have them)", () => {
  const recs = page(`<h1>Andrew Smith</h1>${"<blockquote>Great engineer. <a href='/r'>Read more</a></blockquote>".repeat(6)}`);
  assert.equal(blogOnly(recs), null);
});

test("link-card: a name, a line and profile links", () => {
  const card = page(`<h1>Damian Markowski</h1><p>Results-driven Technical Leader</p>
    <a href="https://linkedin.com/in/dm">LinkedIn</a> <a href="https://x.com/dm">X</a> <a href="https://chess.com/member/dm">Chess.com</a>
    <a href="mailto:contact@dm.com">contact@dm.com</a>`);
  assert.equal(linkCard(card)?.flag, "link-card");
  // A card that says it holds work is not only a card.
  const world = page(`<a href="#links">Skip to portfolio links</a><h1>Dor</h1><p>Senior engineer</p>
    <a href="https://github.com/dor">GitHub</a> <a href="https://linkedin.com/in/dor">LinkedIn</a>`);
  assert.equal(linkCard(world), null);
});

test("company-voice: we, our services and a team; a freelancer or a one-person studio is protected", () => {
  const agency = page(`<h1>Beter Bekend</h1><p>We build websites. We design shops. Our clients love our work. We help you grow.
    We are a team. Our team of developers builds what we promise. We deliver. Our services: web, shops. Careers: we're hiring.</p>`);
  const r = companyVoice(agency);
  assert.equal(r?.flag, "company-voice");
  assert.match(r.reason, /speaks as "we" \d+ times against "I" 0 times/);
  const freelancer = page(`<h1>Dilip</h1><p>I'm a freelance web developer. We build websites. We design shops. Our clients love our work.
    We help you grow. Our services: web, shops. We deliver what we promise. Our team is me. Hire me.</p>`);
  assert.equal(companyVoice(freelancer), null);
  const studio = page(`<h1>Rahnoxa</h1><p>Rahnoxa is a consultancy founded and run by an independent software engineer.
    We build apps. We design systems. We deliver. Our services. Our pricing. We help. We create. Our clients.</p>`);
  assert.equal(companyVoice(studio), null);
});

test("sells-teaching: coaching, a book and speaking, with no projects", () => {
  const coach = page(`<h1>Michelle Brenner</h1><p>Coaching. Speaking. Buy my book! Michelle is a professional speaker.</p>
    <a href="/book">Book a call</a>`);
  assert.equal(sellsTeaching(coach)?.flag, "sells-teaching");
  assert.equal(sellsTeaching(page(`${PORTFOLIO.html}<p>Coaching and a masterclass for juniors.</p>`)), null);
});

test("product-page: a tool's own site with no person behind it", () => {
  const tool = page(`<h1>Calzye</h1><p>Free online calculators. No sign-up.</p><a href="/faq">FAQ</a>
    <a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a><p>165 calculators, it's free.</p>`, { url: "https://calzye.com/", name: "Calzye" });
  assert.equal(productPage(tool)?.flag, "product-page");
  // The same parts on a person's page, in their voice, stay quiet.
  const person = page(`<h1>Ana Ruiz</h1><p>I made a calculator. I wrote it in a week. I host it. My users like it. I keep it free.</p>
    <a href="/faq">FAQ</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a><p>Pricing: free. Sign up.</p>`);
  assert.equal(productPage(person), null);
});

test("readme-page: a repository's README rendered as the page", () => {
  const readme = page(`<h1>MyPortfolio</h1><h2>Getting started</h2><pre>git clone https://github.com/a/b
cd b
npm install</pre><h2>Repository structure</h2><pre>├── app</pre><h2>License</h2><p>MIT License</p>`);
  assert.equal(readmePage(readme)?.flag, "readme-page");
  // "CD workflows" and a contributing line are a portfolio's words, not a README.
  assert.equal(readmePage(page("<p>I set up CI/CD workflows. Contributing to open source. Ran on localhost:3000.</p>")), null);
});

test("single-document: an essay of long paragraphs with no projects", () => {
  const para = (n) => `<p>${`Paragraph ${n} says something about a reset and a decade of work, and why the path hit a dead end. `.repeat(4)}</p>`;
  const essay = page(`<h1>THE RESET</h1>${[1, 2, 3, 4, 5, 6].map(para).join("")}<a href="mailto:x@y.z">Email</a>`);
  assert.equal(singleDocument(essay)?.flag, "single-document");
  // Five long paragraphs are an about section, not yet a document.
  assert.equal(singleDocument(page(`<h1>About</h1>${[1, 2, 3, 4, 5].map(para).join("")}`)), null);
  assert.equal(singleDocument(PORTFOLIO), null);
});

test("forwards-elsewhere: builds on the health check's redirect verdict", () => {
  const moved = page("<h1>Siadialiga</h1><p>Software solutions.</p>", { url: "https://siadialiga.com/", name: "Batuhan Yilmaz", redirect: { moved: true, hijack: true, to: "siadialiga.com" } });
  assert.match(forwardsElsewhere(moved).reason, /^The listed address forwards to siadialiga\.com, and the page there does not carry the name "Batuhan Yilmaz"/);
  assert.equal(forwardsElsewhere({ ...moved, redirect: { moved: true, hijack: false, to: "ana.dev" } }), null);
  assert.equal(forwardsElsewhere({ ...moved, redirect: null }), null);
});

test("subPageAddress: a path is a sub-page; on github.io the path is the site", () => {
  assert.equal(subPageAddress("https://ana.dev/"), null);
  assert.equal(subPageAddress("https://ana.dev/index.html"), null);
  assert.deepEqual(subPageAddress("https://ashwinhariharan.com/software-engineering"), { home: "https://ashwinhariharan.com/", path: "/software-engineering", pathIsSite: false, portfolioPath: false });
  assert.equal(subPageAddress("https://ana.github.io/Portfolio/").pathIsSite, true);
  assert.equal(subPageAddress("https://vale.rocks/portfolio").portfolioPath, true);
});

test("sub-page: three outcomes, and the legitimate one is never flagged", () => {
  const category = { ...BLOG, url: "https://ashwin.dev/software-engineering", finalUrl: "https://ashwin.dev/software-engineering" };
  assert.equal(subPageOutcome({ ...category, home: { plainHtml: PORTFOLIO.html } }).outcome, "home-is-portfolio");
  assert.match(subPage({ ...category, home: { plainHtml: PORTFOLIO.html } }).reason, /the listing should point at the home page/);
  assert.equal(subPageOutcome({ ...category, home: { plainHtml: BLOG.html } }).outcome, "home-not-portfolio");
  assert.match(subPage({ ...category, home: { plainHtml: BLOG.html } }).reason, /is not a portfolio either \(blog-only\)/);
  assert.equal(subPageOutcome(category).outcome, "home-not-read");
  // A github.io project site, a "/portfolio" path or any sub-page with projects is the portfolio.
  for (const url of ["https://ana.github.io/Portfolio/", "https://ana.dev/portfolio", "https://ana.dev/about-ana"]) {
    const s = { ...PORTFOLIO, url, finalUrl: url };
    assert.equal(subPageOutcome(s).outcome, "sub-page-is-portfolio", url);
    assert.equal(subPage(s), null, url);
  }
  assert.equal(subPageOutcome(PORTFOLIO), null);
});

test("reads the plain HTML when there is no rendered copy, and never throws on an empty site", () => {
  assert.equal(littleText({ url: "https://a.dev/", plainHtml: "<p>Hi</p>" })?.flag, "little-text");
  assert.doesNotThrow(() => portfolioFlags({}));
  assert.doesNotThrow(() => portfolioFlags({ url: "not a url", html: "<a href='/x'>x</a>" }));
});
