// pipeline/capture-projects.mjs in a real (headless) browser against a local
// server: the site's own projects page is only ever a plain GET of a
// same-site <a href>. Loaded first; pressed on the home page only when the
// load answers an error status (an app that answers 404 to a direct load),
// and never under a service worker. While it runs, nothing but GET requests
// reach the server (no form or fetch POST, no beacon, no event stream, no web
// socket), a popup is closed at once, another host or a page that never
// finishes adds nothing, and the limit bounds the work.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { readProjectsPage, swapped } from "../pipeline/capture-projects.mjs";

const page = (body) => `<!doctype html><title>t</title><body>${body}</body>`;
// Everything a script on a page might do that is not a plain read.
const SIDE_EFFECTS = `
  fetch('/api/like', { method: 'POST', body: 'x' }).catch(() => {});
  navigator.sendBeacon('/beacon', 'x');
  setTimeout(() => window.open('/popup-target'), 50);
  try { new EventSource('/events'); } catch {}
  try { new WebSocket('ws://' + location.host + '/socket'); } catch {}`;
// An app whose projects show only through its router: loading /projects directly answers 404.
const SPA = page(`<nav><a href="/app-projects" id="p">PROJECTS</a></nav><main id="m"><p>WELCOME</p><p>Short intro line.</p></main>
  <script>document.getElementById("p").addEventListener("click", (e) => { e.preventDefault(); ${SIDE_EFFECTS}
    document.getElementById("m").innerHTML = Array.from({ length: 12 }, (_, i) => '<p>Project number ' + i + '</p><a href="https://demo' + i + '.example/">live</a>').join(""); });</script>`);
const PAGES = {
  "/": page(`<nav><a href="/projects">Projects</a></nav><h1>Ana</h1>`),
  // The projects page itself tries every side effect as it loads.
  "/projects": page(`<h1>All projects</h1><section id="projects"><a href="https://one.example/">One</a></section><script>${SIDE_EFFECTS}</script>`),
  "/spa": SPA,
  "/sw-home": page(`<nav><a href="/sw-projects">Projects</a></nav><p>home</p><script>navigator.serviceWorker.register('/sw.js')</script>`),
  "/sw.js": "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(clients.claim())); self.addEventListener('fetch', (e) => e.respondWith(fetch(e.request)));",
  "/elsewhere": page(`<h1>Elsewhere</h1>`),
};

let server;
let browser;
let base;
const hits = [];
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const html = { "content-type": req.url.endsWith(".js") ? "text/javascript" : "text/html" };
    if (req.url === "/slow") return; // never answers
    if (req.url === "/away") return res.writeHead(302, { location: `http://localhost:${server.address().port}/elsewhere` }).end();
    if (req.url === "/broken") return res.writeHead(500, html).end(page("<h1>Server error</h1>"));
    // The app's and the service-worker site's projects pages answer 404 to a direct load (pages served only by their router).
    if (req.url === "/app-projects" || req.url === "/sw-projects") return res.writeHead(404, html).end(page("<h1>404</h1>"));
    if (PAGES[req.url]) return res.writeHead(200, html).end(PAGES[req.url]);
    res.writeHead(404, html).end(page("<h1>404</h1>"));
  });
  server.on("upgrade", (req, socket) => {
    hits.push(`UPGRADE ${req.url}`);
    socket.destroy();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

const open = async (path) => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`${base}${path}`);
  return p;
};
/** The requests that are not a plain GET of a page, from `from` on. */
const effects = (from) => hits.slice(from).filter((h) => !h.startsWith("GET ") || /\/(events|socket|beacon|popup-target)/.test(h));

test("a projects page is loaded with a plain GET; its scripts' POST, beacon, popup, event stream and socket never reach the server", async () => {
  const p = await open("/");
  const from = hits.length;
  const got = await readProjectsPage(p, `${base}/projects`);
  await p.waitForTimeout(500);
  assert.equal(got?.via, "load");
  assert.equal(got.finalUrl, `${base}/projects`);
  assert.match(got.html, /one\.example/);
  assert.deepEqual(effects(from), [], JSON.stringify(hits.slice(from)));
  assert.equal(p.context().pages().length, 1, "the tab and the popup are closed");
  await p.context().close();
});

test("an app that answers 404 to a direct load: only its same-site link is pressed, and the press causes no request but GETs", async () => {
  const p = await open("/spa");
  const from = hits.length;
  const got = await readProjectsPage(p, `${base}/app-projects`);
  await p.waitForTimeout(500);
  assert.equal(got?.via, "press");
  assert.match(got.html, /demo11\.example/);
  assert.deepEqual(effects(from), [], JSON.stringify(hits.slice(from)));
  assert.equal(p.context().pages().length, 1, "the popup was closed at once");
  await p.context().close();
});

test("a page controlled by a service worker is never pressed: the load alone decides", async () => {
  const p = await open("/sw-home");
  await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 5000 }).catch(() => {});
  await p.reload();
  await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 5000 });
  const before = await p.evaluate(() => document.body.innerText);
  const got = await readProjectsPage(p, `${base}/sw-projects`);
  assert.equal(got, null, "the load answered 404 and no press was made");
  assert.equal(p.url(), `${base}/sw-home`);
  assert.equal(await p.evaluate(() => document.body.innerText), before);
  await p.context().close();
});

test("another host, an error status and a page that never finishes add nothing, held to the limit", async () => {
  const p = await open("/");
  assert.equal(await readProjectsPage(p, `${base}/away`), null, "redirected to another host name");
  assert.equal(await readProjectsPage(p, `${base}/broken`), null, "an error status, and no link to press");
  assert.equal(await readProjectsPage(p, "https://other.example/projects"), null, "another host");
  const t0 = Date.now();
  assert.equal(await readProjectsPage(p, `${base}/slow`, { limitMs: 2000 }), null, "too slow");
  assert.ok(Date.now() - t0 < 5000, `held to its limit (${Date.now() - t0} ms)`);
  assert.equal(p.context().pages().length, 1, "the tab that never finished is closed");
  await p.context().close();
});

test("a page whose text was replaced, not merely animated", () => {
  assert.equal(swapped("Home\nAbout me here\nContact me", "Home\nAbout me here\nContact me!"), false);
  assert.equal(swapped("ABOUT\nPROJECTS\nWelcome here", `ABOUT\nPROJECTS\n${Array.from({ length: 12 }, (_, i) => `Project ${i} line`).join("\n")}`), true);
  assert.equal(swapped("One line\nTwo line\nThree line", "Other page\nNew text\nMore text"), true);
  assert.equal(swapped("x", ""), false);
});
