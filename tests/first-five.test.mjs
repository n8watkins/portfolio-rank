// The first five seconds (pipeline/first-five.mjs): the reading of the first
// screen five seconds after the page starts loading, on fixture pages in
// headless Chromium, and the pure rules that turn readings into the stored
// facts.first_five (name, a way to reach the person or see the work, still on
// an intro). Every outbound link points at .invalid hosts.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import {
  FIRST_FIVE_VERSION,
  MOBILE_APPLIED,
  firstFiveOf,
  introAt5,
  nameOnScreen,
  readAtFive,
  readMobileFirstFive,
  readNow,
  screenReading,
  wayOnScreen,
  withFirstFive,
} from "../pipeline/first-five.mjs";
import { checksScore, codeChecks, factLines } from "../pipeline/rubric.mjs";
import { checkShares } from "../lib/check-points.mjs";
import { checksReading } from "../lib/fresh-facts.mjs";

const PROSE = `<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(3)}</p>`;
const SITE = `<header style="display:flex;gap:16px;font-size:14px"><a href="/">JD</a><a href="#projects">Projects</a><a href="#about">About</a></header>
<h1 style="font-size:56px;margin:24px 0 8px">Jane Doe</h1><h2 style="font-size:22px">Backend engineer</h2>${PROSE}`;

const pages = {
  // The name in a big heading, a contact link below the fold only; a "visually hidden" skip link in a bigger font,
  // and a slide outside its carousel's frame, neither of which a visitor sees.
  "/named": `<!doctype html><title>Jane Doe</title><body style="font:16px system-ui;margin:0;padding:16px">
    <a href="#main" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;font-size:72px">Skip to main content</a>
    <div style="position:absolute;right:0;top:300px;width:300px;height:100px;overflow:hidden"><div style="transform:translateX(320px);font-size:80px">Contact me</div></div>${SITE}
    <div style="height:3000px"></div><a href="mailto:jane@mail.invalid">Email me</a></body>`,
  // An intro that holds the screen for 8 seconds, then the site.
  "/intro8": `<!doctype html><title>Jane Doe</title><body style="font:16px system-ui;margin:0;padding:16px"><div id=intro style="font-size:40px">Loading 0%</div><div id=site hidden>${SITE}</div><script>
    let p = 0; const t = setInterval(() => { p = Math.min(99, p + 7); intro.textContent = "Loading " + p + "%"; }, 400);
    setTimeout(() => { clearInterval(t); intro.remove(); site.hidden = false; }, 8000);</script></body>`,
  // Nothing readable: a spinner, and the text drawn transparent until a reveal that never runs.
  "/nothing": `<!doctype html><title>Jane Doe</title><body style="margin:0"><div style="width:60px;height:60px;border-radius:50%;border:6px solid #888;margin:40vh auto"></div>
    <h1 style="color:rgba(0,0,0,0);font-size:48px">Jane Doe</h1></body>`,
  // A contact link on the first screen.
  "/contact": `<!doctype html><title>Jane Doe</title><body style="font:16px system-ui;margin:0;padding:16px"><h1 style="font-size:48px">Hi, I'm Jane</h1>
    <p>Backend engineer.</p><p><a href="https://social.invalid/in/jane" style="font-size:14px">Get in touch</a></p></body>`,
  // A site that loads slowly: the document answers after 6 seconds.
  "/slow": "slow",
  // A site whose protection answers every visit but the first with a bot check.
  "/challenge": "challenge",
};

let server;
let browser;
let base;
const visits = {};

before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    const p = req.url;
    visits[p] = (visits[p] ?? 0) + 1;
    if (p === "/slow") return void setTimeout(() => res.writeHead(200, html).end(`<!doctype html><body>${SITE}</body>`), 6000);
    if (p === "/challenge" && visits[p] > 1)
      return res.writeHead(403, { ...html, "cf-mitigated": "challenge" }).end("<!doctype html><title>Just a moment...</title><h1>Verifying you are human</h1>");
    if (p === "/challenge") return res.writeHead(200, html).end(`<!doctype html><body>${SITE}</body>`);
    res.writeHead(pages[p] ? 200 : 404, html).end(pages[p] ?? "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
}, { timeout: 60000 });

after(async () => {
  await browser?.close();
  server?.close();
});

/** The desktop reading of one page, as the capture makes it: at five seconds, then settled (`laterMs`). */
async function desktopReading(p, { laterMs = 0 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const startedAt = Date.now();
  const at5 = readAtFive(page, startedAt).then((r) => ({ ...r, status: 200, cfMitigated: "" }));
  await page.goto(`${base}${p}`, { waitUntil: "load" }).catch(() => {});
  const five = await at5;
  if (laterMs) await page.waitForTimeout(Math.max(0, startedAt + laterMs - Date.now()));
  const later = await readNow(page, startedAt);
  await ctx.close();
  return { five, later };
}

test("a name in a big heading is the biggest text, and the name is seen", { timeout: 30000 }, async () => {
  const { five, later } = await desktopReading("/named");
  assert.ok(five.atMs >= 5000 && five.atMs < 7000, `read at ${five.atMs} ms`);
  const r = screenReading(five.raw, { name: "Jane Doe", atMs: five.atMs });
  assert.equal(r.biggest, "Jane Doe");
  assert.equal(r.nameHit, "jane");
  assert.ok(r.words >= 20, `words ${r.words}`);
  // The projects link is on the first screen; the email link is far below it, and the logo goes to the page itself.
  assert.deepEqual([r.way, r.wayKind], ["Projects", "work"]);
  const ff = firstFiveOf({ desktopAt5: five, desktopLater: later, mobile: { error: "not made in this test" }, name: "Jane Doe", viewport: { width: 1440, height: 900 } });
  assert.equal(ff.desktop.state, "measured");
  assert.equal(ff.desktop.intro, false);
  assert.equal(ff.desktop.applied, "1440x900 at 1x; no throttling");
});

test("an intro that holds the screen for 8 seconds is still an intro at five seconds", { timeout: 30000 }, async () => {
  const { five, later } = await desktopReading("/intro8", { laterMs: 9000 });
  const r = screenReading(five.raw, { name: "Jane Doe", atMs: five.atMs });
  assert.match(String(r.biggest), /^Loading \d+%$/);
  assert.equal(r.nameHit, null);
  assert.equal(r.way, null);
  const ff = firstFiveOf({ desktopAt5: five, desktopLater: later, mobile: { error: "x" }, name: "Jane Doe", viewport: { width: 1440, height: 900 } });
  assert.equal(ff.desktop.later.biggest, "Jane Doe");
  assert.equal(ff.desktop.intro, true);
});

test("a page with nothing readable reads as nothing, and is still loading", { timeout: 30000 }, async () => {
  const { five } = await desktopReading("/nothing");
  const r = screenReading(five.raw, { name: "Jane Doe", atMs: five.atMs });
  assert.deepEqual([r.biggest, r.nameHit, r.way, r.words], [null, null, null, 0], JSON.stringify(five.raw));
  // The site has words once settled (here: the capture's other view), so a blank screen at five seconds is still loading.
  assert.equal(introAt5(r, null, 40), true);
  // A page that never shows a word in any view (a canvas site) is not called an intro.
  assert.equal(introAt5(r, { words: 0, biggest: null }, 0), false);
});

test("a contact link on the first screen is a way to reach the person", { timeout: 30000 }, async () => {
  const { five } = await desktopReading("/contact");
  const r = screenReading(five.raw, { name: "Jane Doe" });
  assert.deepEqual([r.way, r.wayKind], ["Get in touch", "contact"]);
  assert.equal(r.biggest, "Hi, I'm Jane");
  assert.equal(r.nameHit, "jane");
});

test("the phone's reading is a throttled visit of its own, read at five seconds", { timeout: 30000 }, async () => {
  const m = await readMobileFirstFive(browser, `${base}/contact`, { name: "Jane Doe", userAgent: "Mozilla/5.0 Chrome/141.0.0.0" });
  assert.equal(m.error, undefined, m.error);
  assert.ok(m.at5.atMs >= 5000, `read at ${m.at5.atMs}`);
  assert.equal(m.at5.biggest, "Hi, I'm Jane");
  assert.deepEqual([m.at5.way, m.at5.wayKind], ["Get in touch", "contact"]);
});

test("a site that has not answered by five seconds is a blank screen, not a failure", { timeout: 30000 }, async () => {
  const m = await readMobileFirstFive(browser, `${base}/slow`, { name: "Jane Doe" });
  assert.equal(m.error, undefined, m.error);
  assert.deepEqual([m.at5.biggest, m.at5.words], [null, 0]);
});

test("a second visit answered with a bot check is not measured, with the reason", { timeout: 30000 }, async () => {
  await (await fetch(`${base}/challenge`)).text();
  const m = await readMobileFirstFive(browser, `${base}/challenge`, { name: "Jane Doe" });
  assert.match(String(m.error), /HTTP 403 \(challenge\)/);
  const ff = firstFiveOf({ desktopAt5: { error: "x" }, mobile: m, name: "Jane Doe", viewport: { width: 1440, height: 900 } });
  assert.deepEqual([ff.mobile.state, ff.mobile.applied], ["not-measured", MOBILE_APPLIED]);
  assert.match(ff.mobile.reason, /HTTP 403/);
});

// ---------------------------------------------------------------- pure rules

test("a name is found by its parts, as whole words, without accents, never by a particle", () => {
  assert.equal(nameOnScreen("Prarit Sidana", "PS PORTFOLIO Prarit Sidana"), "prarit");
  assert.equal(nameOnScreen("José Álvarez", "Hola, soy Jose"), "jose");
  assert.equal(nameOnScreen("Delba de Oliveira", "Portfolio by de facto"), null);
  assert.equal(nameOnScreen("Ann Lee", "Annual report"), null);
  assert.equal(nameOnScreen("Ann Lee", "Hi, I am Ann."), "ann");
  assert.equal(nameOnScreen("山田 太郎", "こんにちは 山田です"), "山田");
  assert.equal(nameOnScreen("", "anything"), null);
});

test("a way is a contact or a work link; a logo back to the page is neither", () => {
  const here = "https://jane.invalid/";
  assert.equal(wayOnScreen([{ text: "JD Jane Doe Portfolio", href: "https://jane.invalid/" }], here), null);
  assert.deepEqual(wayOnScreen([{ text: "", href: "mailto:jane@mail.invalid" }], here), { text: "jane@mail.invalid", kind: "contact" });
  assert.deepEqual(wayOnScreen([{ text: "Let's talk", href: "https://jane.invalid/#talk" }], here), { text: "Let's talk", kind: "contact" });
  assert.deepEqual(wayOnScreen([{ text: "Explore my work", href: "https://jane.invalid/#x" }], here), { text: "Explore my work", kind: "work" });
  assert.deepEqual(wayOnScreen([{ text: "", href: "https://github.invalid/jane" }, { text: "Blog", href: "/blog" }], here), null);
  assert.deepEqual(wayOnScreen([{ text: "Code", href: "https://github.com/jane" }], here), { text: "Code", kind: "work" });
  assert.equal(wayOnScreen([{ text: "Home", href: "/" }, { text: "Blog", href: "/blog" }], here), null);
});

test("intro: under half of the settled screen and under 20 words, or nothing at all on a site with words", () => {
  assert.equal(introAt5({ words: 5, biggest: "Home About Projects Resume Contact" }, { words: 21, biggest: "Hey, I'm Abhishek" }), true);
  assert.equal(introAt5({ words: 52, biggest: "Prarit Sidana" }, { words: 52, biggest: "Prarit Sidana" }), false);
  // A sparse page that looks the same later is not an intro.
  assert.equal(introAt5({ words: 8, biggest: "Jane Doe" }, { words: 9, biggest: "Jane Doe" }), false);
  assert.equal(introAt5({ words: 0, biggest: null }, { words: 31, biggest: "Abhishek" }), true);
  assert.equal(introAt5(null, null), null);
});

test("a new capture's reading replaces a stored one; a view it could not measure keeps the stored measured one", () => {
  const measured = (w) => ({ state: "measured", at: "2026-11-20T00:00:00.000Z", applied: "x", at5: { words: w }, later: null, intro: false });
  const failed = { state: "not-measured", reason: "the second visit was answered with HTTP 403", at: "2026-11-27T00:00:00.000Z", applied: "x" };
  const prev = { v: FIRST_FIVE_VERSION, mobile: measured(10), desktop: measured(20) };
  const merged = withFirstFive(prev, { v: FIRST_FIVE_VERSION, mobile: failed, desktop: measured(30) });
  assert.deepEqual(merged.mobile, measured(10));
  assert.deepEqual(merged.desktop, measured(30));
  assert.deepEqual(withFirstFive(null, { v: FIRST_FIVE_VERSION, mobile: failed, desktop: failed }).mobile, failed);
  // A stored reading of another version is not kept.
  assert.deepEqual(withFirstFive({ v: 99, mobile: measured(1) }, { mobile: failed, desktop: failed }).mobile, failed);
});

test("the reading moves nothing that grades or ranks: the code checks, the prompt's fact lines and the points are the same with it", () => {
  const now = new Date("2026-11-27T00:00:00Z");
  const base = { v: 4, resume: true, github: false, contact: true, own_domain: true, footer_year: 2026, template: false, motion: false, internal_pages: 3, sections: 2, signals: { score: 5 }, project_links: { checked: 4, ok: 3, broken: 1, blocked: 0 } };
  const intro = { state: "measured", at: now.toISOString(), applied: "x", at5: { biggest: null, nameHit: null, way: null, words: 0 }, later: null, intro: true };
  const withIt = { ...base, first_five: { v: FIRST_FIVE_VERSION, mobile: intro, desktop: intro } };
  assert.deepEqual(codeChecks(withIt, now), codeChecks(base, now));
  assert.equal(checksScore(codeChecks(withIt, now)), checksScore(codeChecks(base, now)));
  assert.deepEqual(factLines(withIt, now), factLines(base, now));
  const grade = (facts) => ({ facts, checks: codeChecks(facts, now) });
  assert.deepEqual(checkShares({ grade: grade(withIt), year: 2026 }), checkShares({ grade: grade(base), year: 2026 }));
  const a = checksReading(null, JSON.stringify(withIt), { now });
  const b = checksReading(null, JSON.stringify(base), { now });
  assert.deepEqual([a.checks, a.checks_score], [b.checks, b.checks_score]);
});

test("a desktop reading made while a bot check or an error page showed is not measured", () => {
  const ff = firstFiveOf({
    desktopAt5: { raw: { words: 9, biggest: "Verifying you are human", text: "Verifying you are human", controls: [] }, atMs: 5001, status: 403, cfMitigated: "challenge" },
    mobile: { error: "x" },
    viewport: { width: 1440, height: 900 },
  });
  assert.equal(ff.desktop.state, "not-measured");
  assert.match(ff.desktop.reason, /HTTP 403/);
});
