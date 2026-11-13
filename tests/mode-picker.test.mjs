// Mode pickers (pipeline/splash.mjs passModePicker): a first screen that
// asks how to see the site ("Terminal / GUI", "Dark / Light") gets its first
// sensible option clicked; an ordinary short page with a few links never
// does. Pages are served locally to headless Chromium; nothing leaves the
// machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { detectModePicker, passModePicker } from "../pipeline/splash.mjs";

test("detectModePicker: picks the plain, graphical option; ignores ordinary links", () => {
  assert.deepEqual(detectModePicker("Choose your experience Terminal GUI", ["Terminal", "GUI"]).pick, 1);
  assert.deepEqual(detectModePicker("Pick a mode Dark Light", ["Dark", "Light"]).pick, 1);
  assert.deepEqual(detectModePicker("Who are you? Developer Designer", ["Developer", "Designer"]).pick, 0);
  assert.deepEqual(detectModePicker("Play the game or Terminal", ["Game", "Terminal"]).pick, 0, "only avoided options: the first");
  assert.equal(detectModePicker("Jane Doe Projects About Contact", ["Projects", "About", "Contact"]).picker, false);
  assert.equal(detectModePicker("Jane Doe Resume Dark", ["Resume", "Dark"]).picker, false, "one mode word is not a picker");
  const long = Array.from({ length: 70 }, (_, i) => `w${i}`).join(" ");
  assert.equal(detectModePicker(long, ["Dark", "Light"]).picker, false, "a page with real text is not a picker");
  assert.equal(detectModePicker("Dark Light", ["Dark", "Light", "a", "b", "c", "d"]).picker, false, "too many options");
});

const SITE = `<h1>Jane Doe</h1><p>${"Backend engineer building payment systems. ".repeat(12)}</p>`;
const pages = {
  "/terminal": `<body><p>How would you like to explore?</p><button id=t>Terminal</button><button id=g>GUI</button><main id=m></main>
    <script>t.onclick=()=>{document.body.innerHTML="<pre>$ _</pre>"};g.onclick=()=>{document.body.innerHTML=${JSON.stringify(SITE)}}</script></body>`,
  "/theme": `<body><p>Pick a theme</p><a href="#" id=d>Dark</a> <a href="#" id=l>Light</a>
    <script>for(const a of [d,l])a.onclick=(e)=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(SITE)}}</script></body>`,
  "/real": `<body><h1>Jane Doe</h1><a href="/p">Projects</a> <a href="/a">About</a> <a href="/c">Contact</a></body>`,
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
  await page.goto(base + path, { waitUntil: "load" });
  return page;
}

test("Terminal / GUI: GUI is clicked and the capture sees the site", async () => {
  const page = await open("/terminal");
  const r = await passModePicker(page, { waitMs: 1500 });
  assert.equal(r.passed, true);
  assert.equal(r.picked, "GUI");
  assert.match(await page.textContent("h1"), /Jane Doe/);
  await page.close();
});

test("Dark / Light links: Light is clicked", async () => {
  const page = await open("/theme");
  const r = await passModePicker(page, { waitMs: 1500 });
  assert.equal(r.picked, "Light");
  assert.equal(r.passed, true);
  await page.close();
});

test("an ordinary short page is left alone", async () => {
  const page = await open("/real");
  assert.equal(await passModePicker(page), null);
  assert.equal(new URL(page.url()).pathname, "/real");
  await page.close();
});
