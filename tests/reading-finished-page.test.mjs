// The reader of a listed site (pipeline/render.mjs createRenderer, then
// pipeline/signals.mjs portfolioSignals) reads the finished page: an intro
// screen is not the page, a size cap does not throw the text away, a parking
// page is not live, neighbouring menu items are separate words, and the role
// the page's head states is kept. The fixtures in tests/fixtures/reading/ are
// the real pages as they were read on 2026-11-23 (emails and phone numbers
// replaced; scripts removed where the page is served to the browser here).
// Pages are served locally to headless Chromium behind a policy that blocks
// every other address; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { createRenderer, settleText, scrollAndMeasure, SETTLE_THIN_MAX_MS } from "../pipeline/render.mjs";
import { portfolioSignals, statedRole, metaDescription, SIGNALS_MAX_HTML } from "../pipeline/signals.mjs";
import { PAGE_MAX_HTML, httpGate, parkedPage, parkingTitle, readRenderedPage } from "../pipeline/gate.mjs";
import { scanPage } from "../pipeline/page-controls.mjs";
import { checkSite } from "../pipeline/health.mjs";

const dir = path.join(import.meta.dirname, "fixtures", "reading");
const fixture = (name) => {
  const buf = fs.readFileSync(path.join(dir, name));
  return name.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
};
const yes = (s) => ["projects", "about", "contact", "resume", "github", "name"].filter((k) => s[k]);
const bodyOf = (html) => html.slice(html.indexOf(">", html.indexOf("<body")) + 1, html.lastIndexOf("</body>"));

// --- 1. An intro screen is not the page ---------------------------------------------------------

const ABHISHEK_INTRO = fixture("abhishekworks.intro.html");
const ABHISHEK_FINISHED = fixture("abhishekworks.finished.html.gz");
const MICHAELL = fixture("michaellalavedra.intro.html");
// www.abhishekworks.com's intro held still for 4.5 seconds after the page loaded (66 characters), then the site.
const INTRO_MS = 4500;
const swapIn = (html, script) => html.replace("</body>", `<script>${script}</script></body>`);
// Anything that presses, clicks or submits shows itself on the page.
const PRESS_WATCH = `for (const t of ["click", "mousedown", "pointerdown", "keydown", "submit", "touchstart"])
  addEventListener(t, () => { document.body.insertAdjacentHTML("beforeend", "<p>PRESSED projects about contact resume github</p>"); }, true);`;
const pages = {
  "/abhishek": swapIn(ABHISHEK_INTRO, `setTimeout(async () => { document.body.innerHTML = await (await fetch("/abhishek-body")).text(); }, ${INTRO_MS});`),
  "/abhishek-body": bodyOf(ABHISHEK_FINISHED),
  // The same site's top, its Experiences section added only once the end of the page scrolls into view.
  "/on-scroll": swapIn(
    `<html><head><title>Abhishek Singh | Software Developer</title></head><body><h1>Abhishek Singh</h1>${"<p>Full Stack MERN Developer, India. You've stumbled upon my little heaven on the internet; welcome and feel at home!</p>".repeat(8)}<div style="height:4000px"></div><div id="end"></div></body></html>`,
    `new IntersectionObserver((e, o) => { if (e[0].isIntersecting) { o.disconnect(); document.getElementById("end").innerHTML = "<h2>Experiences</h2><p>Software Developer at GomuGomu Studios. Projects shipped across web and mobile.</p><a href='https://github.com/abhishek'>GitHub</a><a href='/contact'>Contact</a>"; } }).observe(document.getElementById("end"));`
  ),
  "/michaell": swapIn(MICHAELL, PRESS_WATCH),
  "/still": `<html><head><title>Jane Doe</title></head><body><h1>Jane Doe</h1><p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(8)}</p></body></html>`,
};
let server;
let base;
let renderer;
before(async () => {
  server = http.createServer((req, res) =>
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" })
      .end(pages[req.url] ?? "")
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  renderer = createRenderer();
});
after(async () => {
  await renderer?.close();
  server?.close();
});

test("www.abhishekworks.com: the reader waits out the intro and reads the site behind it", async () => {
  const t0 = Date.now();
  const page = await renderer.render(`${base}/abhishek`);
  const ms = Date.now() - t0;
  assert.doesNotMatch(page.text, /^There's a new Dev in town/, "not the intro");
  assert.match(page.text, /Experiences/);
  const s = portfolioSignals(page.html, "Abhishek Singh");
  assert.deepEqual(yes(s), ["projects", "about", "contact", "resume", "github", "name"], `read ${page.text.split(/\s+/).length} words`);
  assert.ok(ms < SETTLE_THIN_MAX_MS + 8000, `within the limit (${ms} ms)`);
});

test("content that loads as it scrolls into view is read; the reader only scrolls", async () => {
  const page = await renderer.render(`${base}/on-scroll`);
  assert.match(page.text, /GomuGomu Studios/);
  assert.equal(portfolioSignals(page.html, "Abhishek Singh").github, true);
});

test("www.michaellalavedra.com: an intro that waits for a press is never pressed, and stays low", async () => {
  const t0 = Date.now();
  const page = await renderer.render(`${base}/michaell`);
  const ms = Date.now() - t0;
  assert.match(page.text, /Press the button to begin/);
  assert.doesNotMatch(page.text, /PRESSED/, "nothing was clicked, pressed or submitted");
  const s = portfolioSignals(page.html, "Michaell Alavedra");
  assert.deepEqual(yes(s), ["name"]);
  assert.equal(s.needsReview, true);
  assert.ok(ms >= SETTLE_THIN_MAX_MS - 1000, `a thin page is watched to the limit (${ms} ms)`);
  assert.ok(ms < SETTLE_THIN_MAX_MS + 8000, `and no longer (${ms} ms)`);
});

test("a page that has its text and holds still is read after the usual quiet time", async () => {
  const t0 = Date.now();
  const page = await renderer.render(`${base}/still`);
  assert.match(page.text, /payment systems/);
  assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
});

/** A fake page whose text length follows `lengths`, one value per sample; it records what each sample ran. */
function fakePage(lengths) {
  let i = 0;
  let clock = 0;
  const ran = [];
  return {
    page: {
      evaluate: async (fn) => {
        ran.push(fn);
        return lengths[Math.min(i++, lengths.length - 1)];
      },
      waitForTimeout: async (ms) => {
        clock += ms;
      },
    },
    clock: () => clock,
    ran,
  };
}

test("settleText: a thin page that holds still is watched to the thin limit; a page with text is not", async (t) => {
  const real = Date.now;
  t.after(() => {
    Date.now = real;
  });
  const run = async (lengths) => {
    const fake = fakePage(lengths);
    const base0 = real();
    Date.now = () => base0 + fake.clock();
    return { ...(await settleText(fake.page)), ran: fake.ran };
  };
  // The intro of www.abhishekworks.com: 66 characters for 4.5 s, then 32,700.
  const intro = await run([...Array(9).fill(66), 32700]);
  assert.equal(intro.grew, 32700 - 66);
  assert.ok(intro.ms >= 4500 + 2000 && intro.ms <= 7500, `read once the site is there and holds still (${intro.ms} ms)`);
  assert.ok(intro.ran.every((fn) => fn === scrollAndMeasure), "every sample scrolls and measures");
  const stays = await run([95]);
  assert.ok(stays.ms >= SETTLE_THIN_MAX_MS && stays.ms <= SETTLE_THIN_MAX_MS + 500, `a page that stays thin costs the thin limit (${stays.ms} ms)`);
  const rich = await run([3000]);
  assert.ok(rich.ms >= 2000 && rich.ms <= 2500, `a page with text costs the quiet time (${rich.ms} ms)`);
  const ticker = await run(Array.from({ length: 100 }, (_, n) => 1000 + 100 * n));
  assert.ok(ticker.ms >= 10000 && ticker.ms <= 10500, `a page with text that never stops growing gets the usual limit (${ticker.ms} ms)`);
  // lamine.cc: a loader, then the site with a typing line that changes it by a few characters each sample.
  const typing = await run([32, 32, 33, 2183, 2185, 2193, 2194, 2190, 2185, 2190, 2194, 2185, 2189, 2194]);
  assert.ok(typing.ms >= 3500 && typing.ms <= 4000, `a typing effect is the page holding still (${typing.ms} ms)`);
  // A section that arrives later is waited for.
  const section = await run([2183, 2185, 2190, 2700, 2702, 2700]);
  assert.ok(section.ms >= 3500, `real growth restarts the quiet time (${section.ms} ms)`);
  assert.equal(section.grew, 2700 - 2183);
  // An infinite feed (every scroll loads more) is scrolled at most once per sample to the limit: about 20 screens,
  // 30 on a page that was thin when the wait began.
  const feed = await run(Array.from({ length: 200 }, (_, n) => 1000 + 800 * n));
  assert.ok(feed.ran.length <= 22, `${feed.ran.length} screens on a page with text`);
  const thinFeed = await run([50, ...Array.from({ length: 200 }, (_, n) => 1000 + 800 * n)]);
  assert.ok(thinFeed.ran.length <= 32, `${thinFeed.ran.length} screens on a page that began thin`);
  // Known limit: typing slower than the tolerance (40 characters, or 2%, per 2 seconds) reads as holding still, so the
  // page is read mid-typing; one read of the page is the rule.
  const slowTyping = await run(Array.from({ length: 40 }, (_, n) => 3000 + 5 * n));
  assert.ok(slowTyping.ms <= 2500 && slowTyping.grew < 40, `read mid-typing after ${slowTyping.ms} ms`);
});

// --- 2. A size cap throws the content away -------------------------------------------------------

const SINGH_RENDERED = fixture("singhshailendra.rendered.html.gz");
const SINGH_PLAIN = fixture("singhshailendra.plain.html.gz");

/** readRenderedPage on a saved DOM. */
function readSaved(t, outerHTML) {
  const saved = globalThis.document;
  t.after(() => {
    globalThis.document = saved;
  });
  globalThis.document = { body: { innerText: "" }, documentElement: { outerHTML }, querySelectorAll: () => [] };
  return readRenderedPage().html;
}

test("singhshailendra.in: a rendered page over 400,000 characters keeps its menu and text; the cut takes only empty class-only elements", (t) => {
  assert.ok(SINGH_RENDERED.length > 600000, "the saved page is the real size");
  assert.ok(SINGH_RENDERED.indexOf(">About<") > 400000, "its menu sits past 400,000 characters");
  const html = readSaved(t, SINGH_RENDERED);
  assert.ok(html.length <= 400000);
  const s = portfolioSignals(html, "Shailendra Singh");
  assert.deepEqual(yes(s), ["projects", "about", "contact", "github", "name"]);
  // Everything the page says is still there.
  const before = scanPage(SINGH_RENDERED).text.replace(/\s+/g, " ").trim();
  const afterText = scanPage(html).text.replace(/\s+/g, " ").trim();
  assert.equal(afterText, before, "no text lost");
});

test("singhshailendra.in: its plain HTML (591,613 characters) is kept whole by the gate and read whole by the signals", async () => {
  assert.ok(SINGH_PLAIN.indexOf(">About<") > 500000);
  const gate = await httpGate("https://singhshailendra.in", {
    fetchImpl: async (url) => ({ status: 200, ok: true, url, text: async () => SINGH_PLAIN }),
  });
  assert.equal(gate.status, "live");
  assert.equal(gate.html.length, SINGH_PLAIN.length);
  assert.deepEqual(yes(portfolioSignals(gate.html, "Shailendra Singh")), ["projects", "about", "contact", "github", "name"]);
});

test("the cut keeps links, buttons, ids, labels and text; a low page padded with empty elements still reads low; the bound holds", (t) => {
  const keep = `<a class="x" href="https://github.com/jane"></a><button class="x"></button><div class="x" id="contact"></div><span class="x" aria-label="Resume"></span><div class="x">Projects</div>`;
  const grid = '<div class="bg-transparent border-neutral-700"><div class="h-12 w-12 bg-[rgba(14,165,233,0.3)]"></div></div>'.repeat(5000);
  const page = `<html><head><title>Sam Lee</title></head><body>${grid}${keep}</body></html>`;
  assert.ok(page.length > 400000);
  const html = readSaved(t, page);
  assert.ok(html.includes(keep), "what a reader reads stays");
  const starter = readSaved(t, `<html><head><title>Create Next App</title></head><body>${grid}<p>Get started by editing app/page.tsx.</p></body></html>`);
  assert.equal(portfolioSignals(starter, "Sam Lee").score, 0);
  // A page of nothing but text past the bound is cut at it.
  const wall = readSaved(t, `<html><body><p>${"word ".repeat(200000)}</p></body></html>`);
  assert.equal(wall.length, 400000);
  const huge = `<p>${"word ".repeat(SIGNALS_MAX_HTML / 5)}</p><a href="https://github.com/late">GitHub</a>`;
  const t0 = Date.now();
  assert.equal(portfolioSignals(huge, "Sam Lee").github, false, "past the signals' bound nothing is read");
  assert.ok(Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  assert.equal(PAGE_MAX_HTML, SIGNALS_MAX_HTML);
});

// --- 3. A parking page is called live ------------------------------------------------------------

const ABDUL = fixture("abdulmomin.dev.plain.html");

test("abdulmomin.dev: Sedo's lander is parked, by its images from img.sedoparking.com and by its title", async () => {
  assert.equal(parkedPage({ finalUrl: "https://abdulmomin.dev/", html: ABDUL }), "parking page: Sedo parking lander");
  const gate = await httpGate("https://abdulmomin.dev", { fetchImpl: async () => ({ status: 200, ok: true, url: "https://abdulmomin.dev/", text: async () => ABDUL }) });
  assert.deepEqual([gate.status, gate.reason], ["parked", "parking page: Sedo parking lander"]);
  // Either marker alone is enough.
  const noImages = ABDUL.replace(/<link[\s\S]*?\/>/, "").replace(/<img[^>]*>/, "");
  assert.doesNotMatch(noImages, /sedoparking/);
  assert.equal(parkedPage({ finalUrl: "https://abdulmomin.dev/", html: noImages }), "parking page: Sedo parking lander");
  assert.equal(parkingTitle("abdulmomin.dev - abdulmomin Resources and Information.", "https://www.abdulmomin.dev/"), "Sedo parking lander");
});

test("parked needs positive evidence: the words in a sentence, another site's name, or a long page are not parked", () => {
  const portfolio = (title, body) => `<html><head><title>${title}</title></head><body><h1>Jane Doe</h1><p>${body}</p><a href="https://github.com/janedoe">GitHub</a></body></html>`;
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: portfolio("Jane Doe | Developer", "Climate resources and information for city planners, built with React.") }), null);
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: portfolio("Climate Resources and Information.", "A data project.") }), null, "a title without the domain");
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: portfolio("climate.org - climate Resources and Information.", "My write-up of a parked page.") }), null, "another site's name");
  assert.equal(parkingTitle("jane.dev - Jane Doe | Resources and Information.", "https://jane.dev/"), undefined, "a title with parts");
  // A long article that shows Sedo's logo and quotes its title is a page with something to say.
  const article = `<html><head><title>jane.dev - jane Resources and Information.</title></head><body><img src="https://img.sedoparking.com/templates/logos/sedo_logo.png"><p>${"How parking pages work, and what I learned building a detector for them. ".repeat(30)}</p></body></html>`;
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: article }), null);
  // A Sedo image as a lazy data-src is not loaded from Sedo.
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: `<title>Jane</title><img data-src="https://img.sedoparking.com/x.png"><p>Jane Doe</p>` }), null);
});

// --- 4. Adjacent menu words ----------------------------------------------------------------------

// The signals read the HTML, where every element's text is its own piece, never the browser's innerText: this
// was already right before 2026-11-23 and is kept so (the menu was lost to the cut, fault 2, not to gluing).
test("singhshailendra.in: a menu the browser's text glues together ('AboutProjectsBlogsGithub') is read as separate words", () => {
  assert.match(fixture("singhshailendra.rendered.txt"), /^AboutProjectsBlogsGithub$/m, "the rendered text glues the menu");
  const html = SINGH_PLAIN;
  const nav = html.slice(html.lastIndexOf("<nav", html.indexOf(">About<")), html.indexOf("</nav>", html.indexOf(">About<")) + 6);
  assert.match(nav, />About<\/span><\/a><a /, "the items touch, with no space between them");
  assert.match(scanPage(nav).text.replace(/\s+/g, " "), /About Projects Blogs Github/);
  assert.deepEqual(yes(portfolioSignals(nav, "Nobody")), ["projects", "about", "github"]);
  // Words are still words: one word split by an element is not two signals' words, and a longer word is no signal.
  assert.equal(portfolioSignals(`<p>Projectsmanager and aboutness</p>`, "x").score, 0);
});

// --- 5. The role stated in the page's head --------------------------------------------------------

test("statedRole reads the role from the title, then the meta description, and nothing when none is stated", () => {
  assert.equal(statedRole("Abhishek Singh | Software Developer | MERN Stack & 3D Expert"), "Software Developer");
  assert.equal(statedRole("Elliot Négrel-Jerzy · Design engineer"), "Design engineer");
  assert.equal(statedRole("Vinay Kulkarni - Data &amp; AI Engineer in Sydney"), "Data & AI Engineer");
  assert.equal(statedRole("Debpriyo Ghosal | Web Designer &amp; Developer"), "Web Designer & Developer");
  assert.equal(statedRole("Shailendra Singh", "I'm Shailendra Singh, a web developer and cybersecurity enthusiast"), "web developer");
  assert.equal(statedRole("Jane", "I'm a driven software developer with a flair for creativity."), "software developer");
  assert.equal(statedRole("Vinay Kulkarni", "Vinay Kulkarni is a Sydney-based data and AI engineer focused on systems."), "Sydney-based data and AI engineer");
  // The current role, not a previous one.
  assert.equal(statedRole("Jane Doe | Previously Senior Engineer at Google, now Founder"), "Founder");
  assert.equal(statedRole("Jane Doe | Ex-Developer turned Designer"), "Designer");
  // The review of #291 (2026-11-23): none of these states the person's role. A description that only starts with a
  // role ("Full-stack developer passionate about...") has no subject, so it is left alone too.
  for (const [title, description] of [
    ["Jane Doe", "Jane Doe is a student of architecture and photography."],
    ["Jane Doe", "Jane Doe is not a developer; she writes about cities."],
    ["Hire a React Developer | Acme", ""],
    ["Tips for Developer Portfolios", ""],
    ["Jane Doe | Former Engineer", ""],
    ["Cian Goon", "Full-stack developer passionate about everything tech"],
    ["Soham Penshanwar \u2014 AI · Privacy · Innovation", ""],
    ["daedalOS", "Desktop environment in the browser"],
    ["Create Next App", "Generated by create next app"],
    ["Engineering Blog | Acme", ""],
    ["Lead generation experts | Acme", ""],
    ["Jane", "We build bridges. Our engineers love concrete."],
    ["Sachin Goyal", "Sachin Goyal \u2014 Gen AI, Agentic AI, and Machine Learning."],
  ])
    assert.equal(statedRole(title, description), null, title);
});

test("the stated role is stored with the site's signals and counts for none of them", async () => {
  assert.equal(metaDescription(ABHISHEK_INTRO).startsWith("Software Developer specializing"), true);
  const s = portfolioSignals(ABHISHEK_INTRO, "Abhishek Singh");
  assert.equal(s.role, "Software Developer");
  assert.deepEqual(yes(s), ["name"], "the intro alone is still one signal");
  assert.equal("role" in portfolioSignals(`<title>daedalOS</title><p>Desktop</p>`, "Dustin Brett"), false, "no role, no key");
  // The health check stores the signals as they come (pipeline/health.mjs): the role with them.
  const r = await checkSite(
    { name: "Michaell Alavedra", url: "https://www.michaellalavedra.com" },
    {
      fetchImpl: async (url) => ({ status: 200, ok: true, url, text: async () => MICHAELL }),
      render: async () => ({ status: 200, finalUrl: "https://www.michaellalavedra.com/", title: "Michaell Alavedra | Software Engineer", text: "Michaell Alavedra Software Engineer Welcome. Press the button to begin.", html: MICHAELL }),
    }
  );
  assert.equal(r.ok, true, "low signals never fail a site");
  assert.equal(r.signals.needsReview, true);
  assert.equal(r.signals.role, "Software Engineer");
});
