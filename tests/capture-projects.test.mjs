// pipeline/capture-projects.mjs in a real (headless) browser against a local
// server: project buttons that open their project from a script handler (as
// nitishkr.fun's do), a button that only opens a dialog, and the site's own
// projects page, reached by its link (a single-page app that answers 404 when
// the page is loaded directly) or loaded, with its time limit, a failing
// page and another host adding nothing.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { readProjectButtons, readProjectsPage, swapped } from "../pipeline/capture-projects.mjs";

const HOME = `<!doctype html><title>Ana</title><body>
  <nav><a href="/projects">Projects</a><button id="menu">View menu</button></nav>
  <h1>Ana Ruiz</h1><p>Developer.</p>
  <section id="projects"><h2>Projects</h2>
    <div class="card"><h3>Focus</h3><button class="m">VS Code Marketplace</button></div>
    <div class="card"><h3>Dock</h3><button class="p">View on pub.dev</button></div>
    <div class="card"><h3>Same site</h3><button class="s">Visit Website</button></div>
    <div class="card"><h3>Story</h3><button class="d">View details</button><dialog id="dlg">Just a story, no link.</dialog></div>
  </section>
  <section><h2>About</h2><button class="a">Visit my blog</button></section>
  <script>
    document.querySelector(".m").addEventListener("click", () => window.open("https://marketplace.example/focus", "_blank"));
    document.querySelector(".p").addEventListener("click", () => window.open("https://pub.example/dock"));
    document.querySelector(".s").addEventListener("click", () => { location.href = "/projects/same"; });
    document.querySelector(".d").addEventListener("click", () => document.getElementById("dlg").showModal());
    document.querySelector(".a").addEventListener("click", () => window.open("https://blog.example/"));
    document.getElementById("menu").addEventListener("click", () => window.open("https://menu.example/"));
  </script></body>`;
// An app whose projects show only through its router: loading /projects directly answers 404.
const SPA = `<!doctype html><title>Eduard</title><body><nav><a href="/projects" id="p">PROJECTS</a></nav><main id="m"><p>WELCOME</p><p>Short intro line.</p></main>
  <script>document.getElementById("p").addEventListener("click", (e) => { e.preventDefault();
    document.getElementById("m").innerHTML = Array.from({ length: 12 }, (_, i) => '<p>Project number ' + i + '</p><a href="https://demo' + i + '.example/">live</a>').join(""); });</script></body>`;

let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => {
    const html = { "content-type": "text/html" };
    if (req.url === "/") return res.writeHead(200, html).end(HOME);
    if (req.url === "/projects") return res.writeHead(200, html).end(`<h1>All projects</h1><a href="https://one.example/">One</a>`);
    if (req.url === "/spa") return res.writeHead(200, html).end(SPA);
    if (req.url === "/slow") return; // never answers
    if (req.url === "/broken") return res.writeHead(500, html).end("<h1>Server error</h1>");
    res.writeHead(404, html).end("<h1>404</h1>");
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
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${base}${path}`);
  return page;
};

test("project buttons: the URLs their handlers open, never obeyed; dialogs, buttons outside the projects and the menu add nothing", async () => {
  const page = await open("/");
  const urls = await readProjectButtons(page);
  assert.deepEqual(urls.sort(), ["https://marketplace.example/focus", "https://pub.example/dock", `${base}/projects/same`].sort());
  assert.equal(page.url(), `${base}/`, "the page stayed where it was");
  assert.equal(page.context().pages().length, 1, "no window was opened");
  await page.context().close();
});

test("the projects page: loaded, read, and an app's router reached by pressing its link", async () => {
  const page = await open("/");
  const got = await readProjectsPage(page, `${base}/projects`);
  assert.equal(got.finalUrl, `${base}/projects`);
  assert.match(got.html, /one\.example/);
  await page.context().close();
  const app = await open("/spa");
  const spa = await readProjectsPage(app, `${base}/projects`);
  assert.ok(spa, "the app's projects were read");
  assert.match(spa.html, /demo11\.example/);
  await app.context().close();
});

test("the projects page adds nothing when it fails, is too slow or is on another host", async () => {
  const page = await open("/");
  assert.equal(await readProjectsPage(page, `${base}/broken`), null, "an error status");
  assert.equal(await readProjectsPage(page, "https://other.example/projects"), null, "another host");
  const t0 = Date.now();
  assert.equal(await readProjectsPage(page, `${base}/slow`, { limitMs: 2000 }), null, "too slow");
  assert.ok(Date.now() - t0 < 4000, "held to its limit");
  await page.context().close();
});

test("a page whose text was replaced, not merely animated", () => {
  assert.equal(swapped("Home\nAbout me here\nContact me", "Home\nAbout me here\nContact me!"), false);
  assert.equal(swapped("ABOUT\nPROJECTS\nWelcome here", `ABOUT\nPROJECTS\n${Array.from({ length: 12 }, (_, i) => `Project ${i} line`).join("\n")}`), true);
  assert.equal(swapped("One line\nTwo line\nThree line", "Other page\nNew text\nMore text"), true);
  assert.equal(swapped("x", ""), false);
});
