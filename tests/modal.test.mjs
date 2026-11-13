// Dialogs on load (pipeline/splash.mjs passModal): a dialog on top of a page
// that is already there is closed the way a visitor would, with its primary
// button or Escape, so the capture shows the site's default view. A cookie
// bar and an ordinary page are left alone. Pages are served locally to
// headless Chromium; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { passModal } from "../pipeline/splash.mjs";

const PAGE = `<main><h1>Ashutosh Pandey</h1><p>${"AI and automation lead shipping internal tools for operations teams. ".repeat(12)}</p></main>`;
const close = "document.getElementById('m').remove()";
const pages = {
  // about.ashutoshcodes.in's kind: "Choose a Theme", a download link, and the primary "Continue with ChatGPT".
  "/theme": `<body>${PAGE}<div id=m role=dialog aria-modal=true style="position:fixed;inset:0;background:#111;display:grid;place-items:center">
    <div><h2>Choose a Theme</h2><button>ChatGPT Interface</button><button>Terminal</button><button>Model Card Resume</button>
    <a href="https://example.invalid/resume.pdf">Download Résumé</a><button onclick="${close}">Continue with ChatGPT</button></div></div></body>`,
  // No button to press: Escape closes it.
  "/escape": `<body>${PAGE}<div id=m role=dialog style="position:fixed;inset:10%;background:#fff;border:1px solid">Welcome! Press Esc to start.</div>
    <script>addEventListener("keydown",(e)=>{if(e.key==="Escape")${close}})</script></body>`,
  // A fixed overlay with no dialog role, closed by its Close button.
  "/overlay": `<body>${PAGE}<div id=m style="position:fixed;inset:0;background:#000;color:#fff;z-index:9">Our new look is here<button onclick="${close}">Close</button></div></body>`,
  // A cookie bar: too small to count.
  "/cookies": `<body>${PAGE}<div role=dialog style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#eee">We use cookies <button>Accept</button></div></body>`,
  "/plain": `<body>${PAGE}</body>`,
};
let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(pages[req.url] ?? "<p>other</p>"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

async function open(path) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("https://example.invalid/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<p>elsewhere</p>" }));
  await page.goto(base + path, { waitUntil: "load" });
  return page;
}

test("Choose a Theme: the primary Continue is clicked, never the download link", async () => {
  const page = await open("/theme");
  const r = await passModal(page, { waitMs: 300 });
  assert.equal(r.kind, "dialog");
  assert.equal(r.button, "Continue with ChatGPT");
  assert.deepEqual(r.how, ["button"]);
  assert.equal(r.passed, true);
  assert.equal(new URL(page.url()).pathname, "/theme");
  assert.equal(await page.locator("#m").count(), 0);
  await page.close();
});

test("a dialog with no button is closed with Escape", async () => {
  const page = await open("/escape");
  const r = await passModal(page, { waitMs: 300 });
  assert.deepEqual([r.button, r.how, r.passed], [null, ["escape"], true]);
  await page.close();
});

test("a full-screen fixed overlay without a dialog role counts, and its Close button closes it", async () => {
  const page = await open("/overlay");
  const r = await passModal(page, { waitMs: 300 });
  assert.deepEqual([r.kind, r.button, r.passed], ["overlay", "Close", true]);
  await page.close();
});

test("a cookie bar and an ordinary page are left alone", async () => {
  for (const p of ["/cookies", "/plain"]) {
    const page = await open(p);
    assert.equal(await passModal(page), null, p);
    await page.close();
  }
});
