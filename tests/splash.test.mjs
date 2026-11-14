// Splash gates (pipeline/splash.mjs): a first screen with very little text
// that asks for a click is clicked through, at most twice, before the
// capture; a real page, even a short one, is left alone. Pages are served
// locally to headless Chromium; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { GATE_MAX_WORDS, MAX_GATE_CLICKS, actionNote, detectGate, passSplashGate } from "../pipeline/splash.mjs";

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
  // Lock screens and doors.
  assert.deepEqual(
    [detectGate("Friday 17:08 Press Enter or Click to continue"), detectGate("LOCKED 17:08 TAP TO UNLOCK"), detectGate("Knock knock. COME IN and I'll say hello back")].map((g) => [g.gate, g.phrase]),
    [
      [true, "click to continue"],
      [true, "tap to unlock"],
      [true, "come in"],
    ]
  );
  assert.equal(detectGate("Come in for a chat about the role, I'm happy to talk about design systems and teams any day").gate, false, "a plain phrase in a sentence is not a gate");
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
  // macos-kuldeeprajput.vercel.app's kind: two seconds of black with no text, then a lock screen
  // that opens on Enter only (its label takes no clicks).
  "/lock": `<body style="margin:0;background:#000"><script>setTimeout(()=>{document.body.innerHTML='<div style="height:100vh;display:grid;place-items:center;color:#fff"><div>Friday 17:08</div><div>Press Enter or Click to continue</div></div>';
    addEventListener("keydown",(e)=>{if(e.key==="Enter")document.body.innerHTML=${JSON.stringify(PORTFOLIO)}})},2000)</script></body>`,
  // The same site's phone view: "Tap to unlock".
  "/unlock": `<body><div style="height:100vh;display:grid;place-items:center">LOCKED 17:08 <button id=u>TAP TO UNLOCK</button></div>
    <script>u.onclick=()=>{document.body.innerHTML=${JSON.stringify(PORTFOLIO)}}</script></body>`,
  // A door: "Knock knock." and a "COME IN" control (a div with a pointer), on a nearly empty screen.
  "/door": `<body><h1>Knock knock.</h1><div id=c style="cursor:pointer;width:120px">COME IN</div><p>and I'll say hello back</p>
    <script>c.onclick=()=>{document.body.innerHTML=${JSON.stringify(PORTFOLIO)}}</script></body>`,
  // A gate that leads to a password prompt: the click is undone, nothing is typed.
  "/password": `<body><button id=go>CLICK TO CONTINUE</button>
    <script>go.onclick=()=>{document.body.innerHTML='<h2>Jane Doe</h2><input type=password placeholder="Enter Password"><p>Password is the current year</p>'}</script></body>`,
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

const portfolioShown = (page) => page.evaluate(() => document.body.innerText.includes("Abbas Raza"));

test("a lock screen that appears after a black boot and opens on Enter: waited for, clicked, and Enter pressed", async () => {
  const page = await open("/lock");
  const r = await passSplashGate(page, { waitMs: 500 });
  assert.deepEqual([r.passed, r.phrase], [true, "click to continue"]);
  assert.ok(r.how.includes("key"), "the screen asked for Enter, so Enter was pressed");
  assert.equal(await portfolioShown(page), true);
  await page.close();
});

test("Tap to unlock and COME IN controls are clicked", async () => {
  for (const [path, phrase] of [["/unlock", "tap to unlock"], ["/door", "come in"]]) {
    const page = await open(path);
    const r = await passSplashGate(page, { waitMs: 500 });
    assert.deepEqual([r.passed, r.phrase, r.how[0]], [true, phrase, "element"], path);
    assert.equal(await portfolioShown(page), true, path);
    await page.close();
  }
});

test("a gate that leads to a password prompt is undone: nothing is typed, the gate screen stays", async () => {
  const page = await open("/password");
  const r = await passSplashGate(page, { waitMs: 300 });
  assert.deepEqual([r.passed, r.password], [false, true]);
  assert.equal(await page.locator("input[type=password]").count(), 0, "reloaded back to the gate");
  assert.match(actionNote({ splash: r }), /password prompt, so it was undone/);
  await page.close();
});

test("a screen that never shows text is given the boot wait, then left alone", async () => {
  const page = await browser.newPage();
  await page.setContent("<body style='margin:0;background:#000'><canvas width=300 height=300></canvas></body>");
  const t = Date.now();
  assert.equal(await passSplashGate(page, { bootWaitMs: 800 }), null);
  assert.ok(Date.now() - t >= 700 && Date.now() - t < 3000, "bounded by the boot wait");
  await page.close();
});
