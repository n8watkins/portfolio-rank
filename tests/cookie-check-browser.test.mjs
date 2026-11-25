// The cookie check in headless Chromium against local pages (pipeline/cookie-check.mjs):
// the banner detector and its false-positive guard, a tracker that fires
// before a banner is answered, a tracker request answered locally (nothing
// leaves the machine), and the second vantage's European browser settings,
// which catch a banner a page shows only by the browser's time zone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { consentArgs, findConsent, readCookieCheck, readSecondVantage, watchRequests } from "../pipeline/cookie-check.mjs";

const BANNER = `<div style="position:fixed;bottom:0;left:0;right:0;padding:16px;background:#222;color:#fff">
  <p>This website uses cookies to measure traffic.</p><button>Reject all</button> <button>Accept all</button></div>`;
const SITE = `<main><h1>Jane Doe</h1><p>${"I build payment systems and developer tools. ".repeat(10)}</p></main>`;

const pages = {
  "/generic": `<!doctype html><body>${SITE}${BANNER}</body>`,
  // A tool's banner element, shown.
  "/cookiebot": `<!doctype html><body>${SITE}<div id="CybotCookiebotDialog" style="position:fixed;bottom:0;padding:20px;background:#fff">We use cookies <button>Allow all</button></div></body>`,
  // A tool's markup on the page, hidden (shown only to some regions).
  "/onetrust-hidden": `<!doctype html><body>${SITE}<div id="onetrust-banner-sdk" style="display:none">We use cookies <button>Accept</button></div></body>`,
  // Not banners: a project card named Cookie Clicker with a button, a blog post about cookies, a cookie policy link in a footer.
  "/not-banners": `<!doctype html><body>${SITE}
    <section><h2>Projects</h2><article><h3>Cookie Clicker clone</h3><p>A game about cookies and consent screens.</p><button>Play</button> <a href="/accept">Accept the challenge</a></article></section>
    <article><h2>How cookies work</h2><p>${"Cookies store state in the browser. Consent banners ask before tracking. ".repeat(4)}</p><button>OK</button></article>
    <footer style="position:sticky;bottom:0;background:#eee">© 2026 Jane Doe · <a href="/cookies">Cookie policy</a> · <a href="/privacy">Privacy</a></footer></body>`,
  // A fixed navigation bar that names a cookie project: no choice button.
  "/fixed-nav": `<!doctype html><body><nav style="position:fixed;top:0">Home · <a href="/cookie">Cookie consent library</a> · <button>Menu</button></nav>${SITE}</body>`,
  // A banner, and Google Analytics firing before any choice: a first-party _ga written by the page and a collect request.
  "/fires-anyway": `<!doctype html><body>${SITE}${BANNER}<script>document.cookie="_ga=GA1.1.1.1; path=/"; fetch("https://www.google-analytics.com/g/collect?v=2&tid=G-T").catch(()=>{})</script></body>`,
  // A banner only for a browser in a European time zone (a tool that decides in the browser); tracking either way.
  "/eu-only": `<!doctype html><body>${SITE}<script>document.cookie="_ga=GA1.1.2.2; path=/";
    if (Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith("Europe/")) document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(BANNER)});</script></body>`,
};

let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const body = pages[req.url];
    if (!body) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/** A page of its own; tracker requests are answered here (204), never sent out. */
async function open(path) {
  const ctx = await browser.newContext();
  await ctx.route(/google-analytics\.com/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await ctx.newPage();
  const watch = watchRequests(page);
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  await page.waitForLoadState("networkidle").catch(() => {});
  return { ctx, page, watch };
}

const consentOn = async (path) => {
  const { ctx, page } = await open(path);
  try {
    return await page.evaluate(findConsent, consentArgs());
  } finally {
    await ctx.close();
  }
};

test("a fixed bar with cookie wording and a choice button is a banner", async () => {
  const r = await consentOn("/generic");
  assert.equal(r.banner, "generic");
  assert.match(r.sample, /This website uses cookies/);
});

test("a known consent tool's banner is recognised by its element; hidden, it is the tool without a banner", async () => {
  const shown = await consentOn("/cookiebot");
  assert.equal(shown.banner, "tool");
  assert.deepEqual(shown.tools, [{ name: "Cookiebot", shown: true }]);
  const hidden = await consentOn("/onetrust-hidden");
  assert.equal(hidden.banner, null);
  assert.deepEqual(hidden.tools, [{ name: "OneTrust", shown: false }]);
});

test("false-positive guard: a project card, a blog post, a footer link and a fixed nav are not banners", async () => {
  assert.equal((await consentOn("/not-banners")).banner, null);
  assert.equal((await consentOn("/fixed-nav")).banner, null);
});

test("a banner whose tracker fires anyway reads with-banner, from the real page", async () => {
  const { ctx, page, watch } = await open("/fires-anyway");
  try {
    const r = await readCookieCheck(page, watch, { region: "US", lateMs: 0 });
    assert.equal(r.state, "with-banner", JSON.stringify(r));
    assert.deepEqual(r.cookies.map((c) => [c.name, c.party, c.tracking]), [["_ga", "first", "Google Analytics"]]);
    assert.deepEqual(r.trackers.map((t) => t.host), ["www.google-analytics.com"]);
  } finally {
    await ctx.close();
  }
});

test("the second vantage: European browser settings show a banner the default settings do not", async () => {
  const { ctx, page, watch } = await open("/eu-only");
  let first;
  try {
    first = await readCookieCheck(page, watch, { region: "US", lateMs: 0 });
  } finally {
    await ctx.close();
  }
  assert.equal(first.state, "no-consent");
  const second = await readSecondVantage(browser, `${base}/eu-only`, { region: "US", lateMs: 0 });
  assert.equal(second.state, "with-banner", JSON.stringify(second));
  assert.equal(second.vantage, "US+eu-browser");
  assert.match(second.label, /European browser settings/);
  assert.equal(typeof second.ms, "number");
  // Its own context is closed again: only the test's browser is left, with no contexts.
  assert.equal(browser.contexts().length, 0);
});

test("the second vantage never throws: an error page or an unreachable address is unknown, with the reason", async () => {
  const missing = await readSecondVantage(browser, `${base}/nothing-here`, { region: "US", lateMs: 0 });
  assert.equal(missing.state, "unknown");
  assert.match(missing.reason, /answered 404/);
  const down = await readSecondVantage(browser, "http://127.0.0.1:9/", { region: "US", lateMs: 0, limitMs: 10000 });
  assert.equal(down.state, "unknown");
  assert.match(down.reason, /second visit failed/);
  assert.equal(browser.contexts().length, 0);
});
