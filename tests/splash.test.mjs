// Splash gates (pipeline/splash.mjs): a first screen with very little text
// that asks for a click is clicked through, at most twice, before the
// capture; a real page, even a short one, is left alone. Pages are served
// locally to headless Chromium; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { GATE_MAX_WORDS, MAX_GATE_CLICKS, detectGate, passSplashGate } from "../pipeline/splash.mjs";

test("detectGate: gate wording on a nearly empty screen; never on a page with real text", () => {
  assert.deepEqual(
    [detectGate("CLICK TO CONTINUE"), detectGate("Press any key"), detectGate("Skip intro"), detectGate("Loading 100%"), detectGate("Enter")].map((g) => [g.gate, g.phrase]),
    [
      [true, "click to continue"],
      [true, "press any key"],
      [true, "skip intro"],
      [true, null],
      [true, "enter"],
    ]
  );
  const words = Array.from({ length: GATE_MAX_WORDS }, (_, i) => `word${i}`).join(" ");
  assert.equal(detectGate(`${words} click to continue`).gate, false, "a page with real text is not a gate");
  // "Start" on a short real page: too many words for a plain word.
  assert.equal(detectGate("Hi, I'm Jane, a designer in Lisbon. Start a project with me today please").gate, false);
  assert.equal(detectGate("").gate, false);
  assert.equal(detectGate("Restart the entertainment").gate, false, "whole words only");
});

const PORTFOLIO = `<h1>Abbas Raza</h1><p>${"Full-stack developer building fast web apps. ".repeat(10)}</p>`;
const pages = {
  // abbasraza.dev's kind: a button, then the portfolio.
  "/button": `<body><button id=go style="width:200px;height:60px">CLICK TO CONTINUE</button><main id=m></main>
    <script>go.onclick=()=>{go.remove();m.innerHTML=${JSON.stringify(PORTFOLIO)}}</script></body>`,
  // No element to click: the whole screen listens.
  "/anywhere": `<body style="margin:0"><div style="height:100vh;display:grid;place-items:center">Press any key</div>
    <script>const go=()=>{document.body.innerHTML=${JSON.stringify(PORTFOLIO)}};addEventListener("click",go);addEventListener("keydown",go)</script></body>`,
  // A loader stuck at 100% with nothing to click: the page centre is.
  "/loader": `<body style="margin:0"><div style="height:100vh;display:grid;place-items:center">100%</div>
    <script>addEventListener("click",()=>{document.body.innerHTML=${JSON.stringify(PORTFOLIO)}})</script></body>`,
  // A gate that never lets go: two clicks, then the capture goes on.
  "/stuck": `<body><button onclick="this.textContent='CLICK TO CONTINUE'">CLICK TO CONTINUE</button></body>`,
  // A real, short page: left alone.
  "/real": `<body>${PORTFOLIO}<a href="/contact">Start a project</a></body>`,
  // A plain word that would leave the site: the click is undone.
  "/away": `<body><a href="https://example.invalid/">Enter</a></body>`,
};
let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(pages[req.url] ?? "<p>contact</p>"));
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

test("a CLICK TO CONTINUE button is clicked, and the capture sees the portfolio", async () => {
  const page = await open("/button");
  const r = await passSplashGate(page, { waitMs: 1500 });
  assert.equal(r.passed, true);
  assert.equal(r.clicks, 1);
  assert.equal(r.phrase, "click to continue");
  assert.deepEqual(r.how, ["element"]);
  assert.ok(r.words.after > GATE_MAX_WORDS);
  assert.match(await page.textContent("h1"), /Abbas Raza/);
  await page.close();
});

test("a loader stuck at 100% with nothing to click: the page centre is clicked", async () => {
  const page = await open("/loader");
  const r = await passSplashGate(page, { waitMs: 1500 });
  assert.equal(r.passed, true);
  assert.deepEqual(r.how, ["centre"]);
  await page.close();
});

test("Press any key: a key is pressed too", async () => {
  const page = await open("/anywhere");
  const r = await passSplashGate(page, { waitMs: 1500 });
  assert.equal(r.passed, true);
  assert.ok(r.how.includes("key"));
  await page.close();
});

test("never loops: at most two clicks, then the capture goes on", async () => {
  const page = await open("/stuck");
  const r = await passSplashGate(page, { waitMs: 300 });
  assert.equal(r.clicks, MAX_GATE_CLICKS);
  assert.equal(r.passed, false);
  await page.close();
});

test("a real page is left alone, and a click that leaves the site is undone", async () => {
  const real = await open("/real");
  assert.equal(await passSplashGate(real), null);
  assert.equal(new URL(real.url()).pathname, "/real");
  await real.close();
  const away = await open("/away");
  const r = await passSplashGate(away, { waitMs: 500 });
  assert.equal(r.passed, false);
  assert.equal(r.left, true);
  assert.equal(new URL(away.url()).pathname, "/away", "back on the portfolio");
  await away.close();
});
