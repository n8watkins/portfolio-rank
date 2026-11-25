// The cookie check in headless Chromium against local pages (pipeline/cookie-check.mjs):
// the banner detector in English, French and German and its false-positive
// guard, a tracker that fires before a banner is answered, a third-party
// embed's frame (its consent tool and its tracker are the embed's, not the
// page's), the reading's time bound and the listener stopping. Tracker and
// consent-tool hosts are answered locally (nothing leaves the machine).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { consentArgs, findConsent, readCookieCheck, watchRequests } from "../pipeline/cookie-check.mjs";

const bar = (inner) => `<div style="position:fixed;bottom:0;left:0;right:0;padding:16px;background:#222;color:#fff">${inner}</div>`;
const BANNER = bar(`<p>This website uses cookies to measure traffic.</p><button>Reject all</button> <button>Accept all</button>`);
const SITE = `<main><h1>Jane Doe</h1><p>${"I build payment systems and developer tools. ".repeat(10)}</p></main>`;

let base;
let embedBase;
const pages = () => ({
  "/generic": `<!doctype html><body>${SITE}${BANNER}</body>`,
  "/french": `<!doctype html><html lang="fr"><body>${SITE}${bar(`<p>Ce site utilise des cookies pour mesurer l'audience.</p><button>Tout refuser</button> <button>Personnaliser</button> <button>Tout accepter</button>`)}</body></html>`,
  "/german": `<!doctype html><html lang="de"><body>${SITE}${bar(`<p>Wir verwenden Cookies, um unsere Website zu verbessern.</p><button>Ablehnen</button> <button>Alle akzeptieren</button>`)}</body></html>`,
  // A footer that is about not tracking: no use of cookies, so not a banner, even with an OK.
  "/no-cookies-footer": `<!doctype html><body>${SITE}${bar(`<p>No cookies, no tracking. This site respects your privacy.</p><button>OK</button>`)}</body>`,
  "/cookiebot": `<!doctype html><body>${SITE}<div id="CybotCookiebotDialog" style="position:fixed;bottom:0;padding:20px;background:#fff">We use cookies <button>Allow all</button></div></body>`,
  "/onetrust-hidden": `<!doctype html><body>${SITE}<div id="onetrust-banner-sdk" style="display:none">We use cookies <button>Accept</button></div></body>`,
  "/not-banners": `<!doctype html><body>${SITE}
    <section><h2>Projects</h2><article><h3>Cookie Clicker clone</h3><p>A game about cookies and consent screens. We use cookies in the game.</p><button>Play</button> <a href="/accept">Accept the challenge</a></article></section>
    <article><h2>How cookies work</h2><p>${"Cookies store state in the browser. Consent banners ask before tracking. ".repeat(4)}</p><button>OK</button></article>
    <footer style="position:sticky;bottom:0;background:#eee">© 2026 Jane Doe · <a href="/cookies">Cookie policy</a> · <a href="/privacy">Privacy</a></footer></body>`,
  "/fixed-nav": `<!doctype html><body><nav style="position:fixed;top:0">Home · <a href="/cookie">Cookie consent library</a> · <button>Menu</button></nav>${SITE}</body>`,
  // A banner, and Google Analytics firing before any choice: a first-party _ga written by the page and a collect beacon.
  "/fires-anyway": `<!doctype html><body>${SITE}${BANNER}<script>document.cookie="_ga=GA1.1.1.1; path=/"; fetch("https://www.google-analytics.com/g/collect?v=2&tid=G-T").catch(()=>{})</script></body>`,
  // Only a scheduling widget from another site, which loads its own consent tool and its own analytics.
  "/calendly-only": `<!doctype html><body>${SITE}<iframe src="${embedBase}/widget" style="width:600px;height:400px;border:0"></iframe></body>`,
  "/widget": `<!doctype html><body><p>Pick a time</p><script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js"></script>
    <script>fetch("https://www.google-analytics.com/g/collect?v=2&tid=G-WIDGET").catch(()=>{})</script></body>`,
  // The page's own script, which a test watches after the reading is done.
  "/late-request": `<!doctype html><body>${SITE}<script>setTimeout(()=>fetch("https://www.google-analytics.com/g/collect?late=1").catch(()=>{}), 800)</script></body>`,
});

let server;
let browser;
before(async () => {
  server = http.createServer((req, res) => {
    const body = pages()[req.url];
    if (!body) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": "text/html" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  // The same server under another name: a different site to the browser, as an embed's host is.
  embedBase = `http://localhost:${port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/** A page of its own; tracker and consent-tool requests are answered here, never sent out. */
async function open(path) {
  const ctx = await browser.newContext();
  await ctx.route(/google-analytics\.com|cookielaw\.org/, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
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

test("a fixed bar that says it uses cookies, with a choice button, is a banner", async () => {
  const r = await consentOn("/generic");
  assert.equal(r.banner, "generic");
  assert.match(r.sample, /This website uses cookies/);
});

test("a French and a German banner are banners", async () => {
  assert.equal((await consentOn("/french")).banner, "generic");
  assert.equal((await consentOn("/german")).banner, "generic");
});

test("false-positive guard: 'No cookies, no tracking. OK', a project card, a blog post, a footer link and a fixed nav are not banners", async () => {
  assert.equal((await consentOn("/no-cookies-footer")).banner, null);
  assert.equal((await consentOn("/not-banners")).banner, null);
  assert.equal((await consentOn("/fixed-nav")).banner, null);
});

test("a known consent tool's banner is recognised by its element; hidden, it is the tool without a banner", async () => {
  const shown = await consentOn("/cookiebot");
  assert.equal(shown.banner, "tool");
  assert.deepEqual(shown.tools, [{ name: "Cookiebot", shown: true }]);
  const hidden = await consentOn("/onetrust-hidden");
  assert.equal(hidden.banner, null);
  assert.deepEqual(hidden.tools, [{ name: "OneTrust", shown: false }]);
});

test("a banner whose tracker fires anyway reads with-banner, from the real page", async () => {
  const { ctx, page, watch } = await open("/fires-anyway");
  try {
    const r = await readCookieCheck(page, watch, { region: "US", lateMs: 0 });
    assert.equal(r.state, "with-banner", JSON.stringify(r));
    assert.deepEqual(r.own_cookies, [{ name: "_ga", vendor: "Google Analytics" }]);
    assert.deepEqual(r.beacons.map((t) => t.host), ["www.google-analytics.com"]);
  } finally {
    await ctx.close();
  }
});

test("a page with only a third-party widget frame reads no consent tool and no tracking of its own", async () => {
  const { ctx, page, watch } = await open("/calendly-only");
  try {
    // The frame's own requests are recorded with the frame's address.
    await page.waitForTimeout(300);
    const fromFrame = watch.records.filter((r) => r.frame && r.frame.startsWith(embedBase));
    assert.ok(fromFrame.some((r) => r.url.includes("cookielaw.org")), JSON.stringify(watch.records));
    const r = await readCookieCheck(page, watch, { region: "US", lateMs: 0 });
    assert.equal(r.state, "none", JSON.stringify(r));
    assert.equal(r.tool, null);
    assert.deepEqual(r.beacons, []);
    assert.deepEqual(r.embeds.map((e) => [e.host, e.trackers]), [["localhost", ["www.google-analytics.com x1"]]]);
  } finally {
    await ctx.close();
  }
});

test("the reading is bounded: with no time left in the capture it is unknown at once, and it never throws", async () => {
  const { ctx, page, watch } = await open("/generic");
  try {
    const t = Date.now();
    const r = await readCookieCheck(page, watch, { region: "US", deadline: Date.now() + 5000 });
    assert.equal(r.state, "unknown");
    assert.match(r.reason, /no time left/);
    assert.ok(Date.now() - t < 500);
    const short = await readCookieCheck(page, watch, { region: "US", limitMs: 1, deadline: Infinity });
    assert.equal(short.state, "unknown");
  } finally {
    await ctx.close();
  }
  // A closed page: an unknown reading with the reason, not a throw.
  const gone = await readCookieCheck(page, watch, { region: "US", lateMs: 0 });
  assert.equal(gone.state, "unknown");
  assert.match(gone.reason, /could not be read/);
});

test("the listener stops when the reading is done", async () => {
  const ctx = await browser.newContext();
  await ctx.route(/google-analytics\.com/, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await ctx.newPage();
  const watch = watchRequests(page);
  try {
    await page.goto(`${base}/late-request`, { waitUntil: "load" });
    const before = watch.records.length;
    watch.stop();
    await page.waitForTimeout(1200);
    assert.equal(watch.records.length, before, "the late beacon is not recorded after stop()");
  } finally {
    await ctx.close();
  }
});
