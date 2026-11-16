// Mode pickers (pipeline/splash.mjs passModePicker): a first screen that
// asks how to see the site ("Terminal / GUI", "Dark / Light", "Recruiter /
// Developer") gets its first sensible option clicked, on the desktop and the
// phone view; an ordinary short page with a few links never does. Ported
// from the recheck-543 experiment. Pages are served locally to headless
// Chromium; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { MODE_MAX_WORDS, actionNote, detectModePicker, passModePicker } from "../pipeline/splash.mjs";

test("detectModePicker: picks the plain, graphical option; ignores ordinary links", () => {
  assert.equal(detectModePicker("Choose your experience Terminal GUI", ["Terminal", "GUI"]).pick, 1);
  assert.equal(detectModePicker("Pick a mode Dark Light", ["Dark", "Light"]).pick, 1);
  assert.equal(detectModePicker("Who are you? Developer Designer", ["Developer", "Designer"]).pick, 0);
  assert.equal(detectModePicker("Who are you? Developer Recruiter", ["Developer", "Recruiter"]).pick, 1, "the recruiter view is the plain one");
  assert.equal(detectModePicker("Enter in 2D or 3D", ["3D", "2D"]).pick, 1);
  assert.equal(detectModePicker("Play the game or Terminal", ["Game", "Terminal"]).pick, 0, "only avoided options: the first");
  assert.equal(detectModePicker("Jane Doe Projects About Contact", ["Projects", "About", "Contact"]).picker, false);
  assert.equal(detectModePicker("Jane Doe Resume Dark", ["Resume", "Dark"]).picker, false, "one mode word is not a picker");
  const long = Array.from({ length: MODE_MAX_WORDS + 10 }, (_, i) => `w${i}`).join(" ");
  assert.equal(detectModePicker(long, ["Dark", "Light"]).picker, false, "a page with real text is not a picker");
  assert.equal(detectModePicker("Dark Light", ["Dark", "Light", "a", "b", "c", "d"]).picker, false, "too many options");
  assert.equal(detectModePicker("", ["Dark", "Light"]).picker, false, "no text yet is not a picker");
});

test("actionNote records the picked mode after the gate and the dialog", () => {
  assert.equal(actionNote({ mode: { picked: "GUI", passed: true } }), 'picked "GUI"');
  assert.equal(actionNote({ splash: { phrase: "click to enter", how: ["element"], passed: true }, mode: { picked: "Light", passed: false } }), 'clicked "click to enter", then picked "Light" (still blocked)');
  assert.equal(actionNote({ mode: { picked: "Recruiter", passed: false, left: true } }), 'picked "Recruiter" (it left the site, so it was undone)');
});

const SITE = `<h1>Jane Doe</h1><p>${"Backend engineer building payment systems. ".repeat(12)}</p>`;
const pages = {
  "/terminal": `<body><p>How would you like to explore?</p><button id=t>Terminal</button><button id=g>GUI</button><main id=m></main>
    <script>t.onclick=()=>{document.body.innerHTML="<pre>$ _</pre>"};g.onclick=()=>{document.body.innerHTML=${JSON.stringify(SITE)}}</script></body>`,
  "/theme": `<body><p>Pick a theme</p><a href="#" id=d>Dark</a> <a href="#" id=l>Light</a>
    <script>for(const a of [d,l])a.onclick=(e)=>{e.preventDefault();document.body.innerHTML=${JSON.stringify(SITE)}}</script></body>`,
  // A picker whose buttons do nothing: still a picker after the click.
  "/stuck": `<body><p>Choose your view</p><button>Recruiter</button><button>Developer</button></body>`,
  // A picker whose plain option is a link to another site: undone.
  "/away": `<body><p>Choose your view</p><a href="https://example.invalid/">Recruiter</a> <a href="/dev">Developer</a></body>`,
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

async function open(path, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport });
  await page.goto(base + path, { waitUntil: "load" });
  return page;
}

test("Terminal / GUI: GUI is clicked and the capture sees the site", async () => {
  const page = await open("/terminal");
  const r = await passModePicker(page, { waitMs: 1500 });
  assert.equal(r.passed, true);
  assert.equal(r.picked, "GUI");
  assert.deepEqual(r.options, ["Terminal", "GUI"]);
  assert.ok(r.words.after > r.words.before);
  assert.match(await page.textContent("h1"), /Jane Doe/);
  assert.equal(await page.locator("[data-pr-mode]").count(), 0, "no marker is left in the page");
  await page.close();
});

test("the phone view passes the picker too", async () => {
  const page = await open("/terminal", { width: 390, height: 844 });
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

test("a picker that does not let go is reported as still blocked", async () => {
  const page = await open("/stuck");
  const r = await passModePicker(page, { waitMs: 500 });
  assert.equal(r.picked, "Recruiter");
  assert.equal(r.passed, false);
  await page.close();
});

test("a choice that leaves the site is undone", async () => {
  const page = await open("/away");
  const r = await passModePicker(page, { waitMs: 1500 });
  assert.equal(r.picked, "Recruiter");
  assert.equal(r.passed, false);
  assert.equal(r.left, true);
  assert.equal(new URL(page.url()).pathname, "/away");
  await page.close();
});

test("an ordinary short page is left alone", async () => {
  const page = await open("/real");
  assert.equal(await passModePicker(page), null);
  assert.equal(new URL(page.url()).pathname, "/real");
  assert.equal(await page.locator("[data-pr-mode]").count(), 0);
  await page.close();
});
