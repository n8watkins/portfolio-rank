// Owner policy (2026-11-13): a capture stores and grades only what a visitor
// sees after the default click (a splash gate, a dialog on top). The screen
// before the click is never written; meta.action says what was clicked.
// When the click doesn't get through, the stored screenshot is the blocked
// screen and the note says "(still blocked)". The real grader capture
// (pipeline/grade-capture.mjs capturePage) runs through the filtering proxy
// against local pages; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createFilteringProxy } from "../pipeline/net-guard-node.mjs";
import { capturePage } from "../pipeline/grade-capture.mjs";
import { actionNote } from "../pipeline/splash.mjs";

// The page under the click is green; the gate and the dialog are red.
const SITE = `<main style="background:#0a0;min-height:100vh;margin:0;color:#fff"><h1>Jane Park</h1><p>${"Backend engineer building payment systems for small shops. ".repeat(10)}</p><a href="https://github.com/jane">GitHub</a></main>`;
const RED = "position:fixed;inset:0;background:#d00;color:#fff;display:grid;place-items:center";
const pages = {
  "/dialog": `<body style="margin:0">${SITE}<div id=m role=dialog aria-modal=true style="${RED}"><div><h2>Choose a Theme</h2><button>Terminal</button><button onclick="m.remove()">Continue</button></div></div></body>`,
  "/gate": `<body style="margin:0"><div id=g style="${RED}"><button onclick="document.body.innerHTML=${JSON.stringify(SITE).replace(/"/g, "&quot;")}">CLICK TO CONTINUE</button></div></body>`,
  "/stuck": `<body style="margin:0"><div style="${RED}"><button>CLICK TO CONTINUE</button></div></body>`,
};
let site;
let port;
let proxy;
let browser;
before(async () => {
  site = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(pages[req.url] ?? "<p>other</p>"));
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  port = site.address().port;
  // The local "site" stands in for a public one, as in tests/grader-capture.test.mjs.
  proxy = await createFilteringProxy({ lookup: async () => [{ address: "93.184.216.34", family: 4 }], allow: () => true, ports: new Set([port]) });
  browser = await chromium.launch({ proxy: { server: proxy.url }, args: ["--proxy-bypass-list=<-loopback>"] });
});
after(async () => {
  await browser?.close();
  await proxy?.close();
  site?.close();
});

/** The colour at the centre of a stored JPEG: "green", "red" or "other". */
async function centre(file) {
  const page = await browser.newPage();
  try {
    const data = `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`;
    const [r, g] = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return [...ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height * 0.9), 1, 1).data];
    }, data);
    return g > 120 && r < 80 ? "green" : r > 150 && g < 80 ? "red" : "other";
  } finally {
    await page.close();
  }
}

async function capture(p) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-action-"));
  const r = await capturePage(browser, `http://127.0.0.1:${port}${p}`, { dir, linkFetch: async () => new Response("ok"), settlePolls: 1, pollMs: 100 });
  return { r, dir };
}

test("a dialog on top: only the screen after Continue is stored, and the click is noted", async () => {
  const { r, dir } = await capture("/dialog");
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["hero.jpg", "mobile.jpg"], "no screenshot of the dialog is kept");
  assert.equal(await centre(r.files.hero), "green");
  assert.equal(await centre(r.files.mobile), "green");
  assert.equal(r.meta.action, 'clicked "Continue"');
});

test("a splash gate: only the screen after the click is stored, and the click is noted", async () => {
  const { r, dir } = await capture("/gate");
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["hero.jpg", "mobile.jpg"]);
  assert.equal(await centre(r.files.hero), "green");
  assert.equal(r.meta.action, 'clicked "click to continue"');
});

test("a gate that never lets go is never graded, and no screenshot of it is stored", async () => {
  const { r, dir } = await capture("/stuck");
  assert.equal(r.ok, false);
  assert.match(r.reason, /blank/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("actionNote: one line per pass, in order", () => {
  assert.equal(actionNote({}), null);
  assert.equal(actionNote({ modal: { kind: "dialog", button: "Continue with ChatGPT", how: ["button"], passed: true } }), 'clicked "Continue with ChatGPT"');
  assert.equal(actionNote({ modal: { kind: "dialog", button: null, how: ["escape"], passed: true } }), "pressed Escape on a dialog");
  assert.equal(
    actionNote({ splash: { phrase: "press any key", how: ["centre", "key"], passed: true }, mode: { picked: "GUI", passed: true } }),
    'clicked "press any key" and pressed Enter, then picked "GUI"'
  );
  assert.equal(actionNote({ splash: { phrase: null, how: ["centre"], passed: false } }), "clicked the centre of a loader screen (still blocked)");
});
