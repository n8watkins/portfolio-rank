// The facts and signals see buttons and other non-link controls, not only
// <a href> (facts audit, 2026-11-21, scripts/experiments/facts-audit/), and
// the capture reads a page once its text has stopped growing
// (pipeline/render.mjs settleText). The two fixtures are the parts of the
// rendered pages of two listed sites the owner found stored with no resume,
// as the capture read them, with the people's details replaced by
// placeholders. Deterministic; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FACTS_VERSION, extractLinks, measureFacts, pageLinks, projectLinkCandidates } from "../pipeline/facts.mjs";
import { extractControls, LABEL_MAX, scanPage } from "../pipeline/page-controls.mjs";
import { portfolioSignals } from "../pipeline/signals.mjs";
import { settleText } from "../pipeline/render.mjs";
import { readRenderedPage, titleOf, visibleText } from "../pipeline/gate.mjs";

const fixture = (name) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", "facts", name), "utf8");

test("adityapillai.dev: the hero's View Resume button is a resume", () => {
  const html = fixture("adityapillai.dev.html");
  assert.match(html, /<button[^>]*aria-label="View Resume"/, "the fixture has the button and no resume link");
  const f = measureFacts({ html, text: "", url: "https://adityapillai.dev", finalUrl: "https://www.adityapillai.dev/", name: "Aditya Pillai" });
  assert.equal(f.v, FACTS_VERSION);
  assert.equal(f.resume, true);
  assert.equal(f.github, true);
  assert.equal(f.contact, true);
  assert.equal(f.signals.resume, true);
});

test("kalpsenghani.com: a Resume button and an icon-only Download Resume button are a resume", () => {
  const html = fixture("kalpsenghani.com.html");
  const f = measureFacts({ html, text: "", url: "https://kalpsenghani.com", name: "Kalp Senghani" });
  assert.equal(f.resume, true);
  assert.equal(f.signals.resume, true);
  assert.equal(f.signals.projects, true, "the My Work link goes to #projects");
});

test("a resume button counts; the word resume in prose, or in a big clickable card, does not", () => {
  const url = "https://ana.dev";
  assert.equal(measureFacts({ html: `<button type="button">Download CV</button>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<div role="button" tabindex="0"><span>Résumé</span></div>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<button aria-label="Open my resume"><svg></svg></button>`, url }).resume, true);
  assert.equal(measureFacts({ html: `<span onclick="window.open('/files/ana_resume.pdf')">Download</span>`, url }).resume, true, "a script that opens the resume PDF");
  assert.equal(
    measureFacts({ html: `<article><h2>How I rewrote my resume</h2><p>Last year I rewrote my resume three times before it worked.</p></article>`, url }).resume,
    false,
    "a blog post about a resume is not a resume"
  );
  const card = `<div role="button"><h3>Job board</h3><p>Upload a resume, match it with openings and track every application in one place.</p></div>`;
  assert.ok(card.replace(/<[^>]+>/g, "").length > LABEL_MAX);
  assert.equal(measureFacts({ html: card, url }).resume, false, "a project card that mentions resumes is not a resume button");});

test("GitHub and contact from buttons; a project opened from a button is a project link", () => {
  const url = "https://ana.dev";
  const html = `<button onclick="window.open('https://github.com/ana/weather-app','_blank')">Code</button>
    <button onclick="location.href='https://weather.ana.dev'">Live demo</button>
    <button class="cta">Contact me</button>`;
  const f = measureFacts({ html, url });
  assert.equal(f.github, true);
  assert.equal(f.contact, true);
  assert.deepEqual(projectLinkCandidates(pageLinks(html, url), url), ["https://github.com/ana/weather-app", "https://weather.ana.dev/"]);
  const s = portfolioSignals(html, "Ana");
  assert.equal(s.github, true);
  assert.equal(s.contact, true);
  assert.equal(measureFacts({ html: `<button onclick="window.open('https://github.com/features')">Features</button>`, url }).github, false, "github.com's own pages are not a profile");
});

test("a Projects button that scrolls to the projects section is an in-page section; the repo links in that section are project links", () => {
  const url = "https://ana.dev";
  const html = `<nav><button>About</button><button>Projects</button><a href="#contact">Contact</a></nav>
    <section id="projects"><h2>Projects</h2><div><h3>Weather</h3><a href="https://github.com/ana/weather">GitHub</a></div></section>`;
  const f = measureFacts({ html, url, name: "Ana" });
  assert.equal(f.sections, 3);
  assert.equal(f.signals.projects, true);
  assert.deepEqual(projectLinkCandidates(pageLinks(html, url), url), ["https://github.com/ana/weather"]);
});

test("links and texts main's code found as a resume still count; a single-accent Resumé counts too", () => {
  const url = "https://ana.dev";
  for (const label of ["下载CV", "CVをダウンロード", "我的Resume", "Resumé", "Résumé", "Curriculum Vitae"]) {
    assert.equal(measureFacts({ html: `<a href="/files/x">${label}</a>`, url }).resume, true, `link "${label}"`);
  }
  for (const label of ["下载CV", "Resumé", "Download Résumé"]) {
    assert.equal(measureFacts({ html: `<button>${label}</button>`, url }).resume, true, `button "${label}"`);
  }
});

test("links with a stray quote are read as main read them; a > inside a quoted class does not hide the href", () => {
  const base = "https://ana.dev/";
  assert.deepEqual(extractLinks(`<a href=/o'neil>Home</a>`, base).map((l) => [l.href, l.text]), [["https://ana.dev/o'neil", "Home"]]);
  assert.deepEqual(extractLinks(`<a href="/x" title=5">X</a>`, base).map((l) => [l.href, l.text]), [["https://ana.dev/x", "X"]]);
  assert.deepEqual(extractLinks(`<a class="[&>svg]:size-4" href="https://github.com/ana">GitHub</a>`, base).map((l) => l.href), ["https://github.com/ana"]);
  assert.deepEqual(extractLinks(`<a href="#a" aria-label="About">x</a>`, base), [{ raw: "#a", href: "https://ana.dev/#a", text: "x About", inProjects: false, inChrome: false, inSocial: false }]);
});

test("the word GitHub on a control is not a GitHub link: it needs a github.com URL", () => {
  const url = "https://shop.example";
  for (const html of [
    `<button>Sign in with GitHub</button>`,
    `<span role="button" class="chip">GitHub Actions</span>`,
    `<div role="tab">Git &amp; GitHub</div>`,
    `<button aria-label="GitHub"><svg></svg></button>`,
  ]) {
    assert.equal(measureFacts({ html, url }).github, false, html);
    assert.equal(portfolioSignals(html, "Shop").github, false, html);
  }
  assert.equal(measureFacts({ html: `<button data-href="https://github.com/ana">GitHub</button>`, url }).github, true, "a URL attribute on the control");
});

test("labels read text, aria-label, title and alt only: data-title and data-value are not labels", () => {
  const url = "https://ana.dev";
  const html = `<button data-title="Resume" data-value="CV" data-label="Contact">Go</button>`;
  assert.deepEqual(extractControls(html, url).map((c) => c.parts), [["Go"]]);
  assert.equal(measureFacts({ html, url }).resume, false);
  assert.equal(measureFacts({ html, url }).contact, false);
});

test("a control's project link is only a URL it navigates to, not any URL in a data- attribute", () => {
  const url = "https://ana.dev";
  const html = `<button data-track="https://collect.example/t?id=1" data-endpoint="https://forms.example/submit" onclick="send()">Send</button>
    <button onclick="location.assign('https://demo.ana-app.dev/')">Demo</button>`;
  assert.deepEqual(projectLinkCandidates(pageLinks(html, url), url), ["https://demo.ana-app.dev/"]);
});

test("projects signal: Works, My work, Projects and Portfolio controls count; a Work / Education toggle does not", () => {
  assert.equal(portfolioSignals(`<div role="tablist"><button>Work</button><button>Education</button></div><p>Engineer at Acme</p>`, "Ana").projects, false);
  assert.equal(portfolioSignals(`<div role="tab">Works</div>`, "Ana").projects, true, "krishnananda.netlify.app's Works tab");
  assert.equal(portfolioSignals(`<button>My work</button>`, "Ana").projects, true);
});

test("a carousel's Resume slideshow button is not a resume", () => {
  const url = "https://ana.dev";
  for (const html of [`<button aria-label="Resume slideshow"><svg></svg></button>`, `<button title="Pause or resume the video"></button>`]) {
    assert.equal(measureFacts({ html, url }).resume, false, html);
    assert.equal(portfolioSignals(html, "Ana").resume, false, html);
  }
  // Visible text stays as main read it for the signal (any "resume" in the page text); the fact wants a resume-like label.
  assert.equal(measureFacts({ html: `<button>Resume autoplay</button>`, url }).resume, false);
  assert.equal(measureFacts({ html: `<button>View CV (PDF)</button>`.replace(" (PDF)", ".pdf"), url }).resume, true);
});

test("sections: a nav button inside a link to another page is no section, and a button that repeats a #hash link counts once", () => {
  const url = "https://ana.dev";
  const pages = `<a href="/about"><button>About</button></a><a href="/projects"><button>Projects</button></a><a href="/contact"><button>Contact</button></a>`;
  assert.equal(measureFacts({ html: pages, url }).sections, 0);
  const mobile = `<nav><a href="#about">About</a><a href="#projects">Projects</a></nav><div class="mobile"><button>About</button><button>Projects</button></div>`;
  assert.equal(measureFacts({ html: mobile, url }).sections, 2);
});

test("nested controls: one control with a label from its children; an outer onclick does not swallow the controls inside it", () => {
  const url = "https://ana.dev";
  const nested = `<div role="button"><div class="icon"></div><div class="label">Resume</div></div>`;
  assert.deepEqual(extractControls(nested, url).map((c) => c.label), ["Resume"]);
  assert.equal(measureFacts({ html: nested, url }).resume, true);
  const outer = `<div onclick="track()"><p>${"A long card about my work and the teams I helped. ".repeat(3)}</p><button>Download CV</button><a role="button">Contact me</a></div>`;
  const labels = extractControls(outer, url).map((c) => c.label);
  assert.ok(labels.includes("Download CV") && labels.includes("Contact me"), labels.join(" | "));
  const f = measureFacts({ html: outer, url });
  assert.equal(f.resume, true);
  assert.equal(f.contact, true);
});

test("the scan is linear: hostile inputs stay fast in measurePage's parts and the signals", () => {
  const inputs = {
    "4000 <img onclick>": `<img onclick="x()" src="a.png">`.repeat(4000),
    "4000 <input role=tab>": `<input role="tab" value="t">`.repeat(4000),
    "500 KB of 'a <b && c'": "a <b && c ".repeat(50000),
    "unclosed quotes": `<a href="x`.repeat(20000),
    "unclosed tags": "<div ".repeat(100000),
    "unclosed title and script": "<title><script>".repeat(50000),
  };
  for (const [name, html] of Object.entries(inputs)) {
    const t0 = performance.now();
    const scan = scanPage(html, "https://ana.dev/");
    measureFacts({ html, url: "https://ana.dev", scan });
    pageLinks(html, "https://ana.dev", scan);
    portfolioSignals(html, "Ana");
    visibleText(html);
    titleOf(html);
    const ms = performance.now() - t0;
    assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`);
  }
});

test("the linear text readers give what the old regexes gave", () => {
  const pages = [
    `<html><head><title> Ana | Dev </title><style>.a{}</style></head><body><script>var x = "<b>";</script><p>Hi &amp; welcome</p><noscript>enable js</noscript>a<>b <br/>c</body></html>`,
    `<p>1 < 2 and 3 > 2</p><title>x</title><title>y</title>`,
    `<div>unclosed <span`,
    `<SCRIPT>bad()</SCRIPT><p>ok</p><script>no end`,
  ];
  const oldVisible = (h) =>
    h
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  const oldTitle = (h) => (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  for (const h of pages) {
    assert.equal(visibleText(h), oldVisible(h), h);
    assert.equal(titleOf(h), oldTitle(h), h);
  }
});

test("controls: labels from text, aria-label, title and image alt; long text is not read for words", () => {
  const c = extractControls(`<button title="Download Resume"><img alt="file icon"></button><div role="tab">About</div><input type="submit" value="Send">`, "https://ana.dev/");
  assert.deepEqual(
    c.map((x) => [x.tag, x.label]),
    [
      ["button", "Download Resume file icon"],
      ["div", "About"],
      ["input", "Send"],
    ]
  );
});

test("a page over 400,000 characters drops inline images, srcsets and style attributes before the cut, so its footer links stay", (t) => {
  const footer = `<footer><a href="https://github.com/eduard">Github</a><a href="mailto:e@x.dev">Mail</a></footer>`;
  const img = `<img src="data:image/png;base64,${"A".repeat(380000)}" srcset="${"a.png 1x, ".repeat(3000)}" style="${"color:red;".repeat(2000)}">`;
  const page = `<html><head><title>Eduard</title></head><body><h1>Eduard</h1>${img}${footer}</body></html>`;
  assert.ok(page.length > 400000);
  const saved = globalThis.document;
  t.after(() => {
    globalThis.document = saved;
  });
  globalThis.document = { body: { innerText: "Eduard Github Mail" }, documentElement: { outerHTML: page }, querySelectorAll: () => [] };
  const { html } = readRenderedPage();
  assert.ok(html.length < 400000);
  const f = measureFacts({ html, url: "https://eduard.github.io", name: "Eduard" });
  assert.equal(f.github, true);
  assert.equal(f.contact, true);
  globalThis.document = { body: { innerText: "" }, documentElement: { outerHTML: "<html><body><img style=\"x\"></body></html>" }, querySelectorAll: () => [] };
  assert.equal(readRenderedPage().html, "<html><body><img style=\"x\"></body></html>", "a page under the cap is read as it is");
});

/** A fake page whose text length follows `lengths`, one value per sample. */
function fakePage(lengths) {
  let i = 0;
  let clock = 0;
  return {
    page: {
      evaluate: async () => lengths[Math.min(i++, lengths.length - 1)],
      waitForTimeout: async (ms) => {
        clock += ms;
      },
    },
    clock: () => clock,
  };
}

test("settleText waits while the text grows, stops once it holds, and has a ceiling", async (t) => {
  const real = Date.now;
  let base = 0;
  t.after(() => {
    Date.now = real;
  });
  const run = async (lengths, opts) => {
    const fake = fakePage(lengths);
    base = real();
    Date.now = () => base + fake.clock();
    return settleText(fake.page, { pollMs: 500, quietMs: 2000, maxMs: 10000, ...opts });
  };
  const still = await run([3000]);
  assert.equal(still.grew, 0);
  assert.ok(still.ms >= 2000 && still.ms <= 2500, `a still page costs the quiet time (${still.ms} ms)`);
  const late = await run([0, 0, 400, 1800, 2900, 2900]);
  assert.equal(late.grew, 2900);
  assert.ok(late.ms >= 4000, `it waits until the text stops growing (${late.ms} ms)`);
  const blank = await run([0]);
  assert.ok(blank.ms >= 10000 && blank.ms <= 10500, `a page with no text yet is waited for up to the ceiling (${blank.ms} ms)`);
  const ticker = await run(Array.from({ length: 100 }, (_, n) => n));
  assert.ok(ticker.ms <= 10500, `a page that never stops changing gets the ceiling (${ticker.ms} ms)`);
});
