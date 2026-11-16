// The capture steps that keep a working site from being marked failed
// (pipeline/capture-steps.mjs): a bot-blocked or TLS-failed pre-check is left
// to the browser, a slow page gets time to render, and a screenshot that
// fails is retried through the DevTools protocol. Pages are served locally to
// headless Chromium; nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chromium } from "playwright";
import { inconclusiveGate, shot, waitForContent } from "../pipeline/capture-steps.mjs";

test("pre-check: 401, 403, 429, 503 and TLS errors go to the browser; DNS, 404, parked and live stay as they are", () => {
  for (const s of [401, 403, 429, 503]) assert.equal(inconclusiveGate({ status: "error", reason: `HTTP ${s}`, httpStatus: s }), true, String(s));
  assert.equal(inconclusiveGate({ status: "error", reason: "TLS error" }), true);
  assert.equal(inconclusiveGate({ status: "error", reason: "HTTP 500", httpStatus: 500 }), false);
  assert.equal(inconclusiveGate({ status: "error", reason: "timeout" }), false);
  assert.equal(inconclusiveGate({ status: "dead", reason: "DNS resolution failed" }), false);
  assert.equal(inconclusiveGate({ status: "dead", reason: "HTTP 404", httpStatus: 404 }), false);
  assert.equal(inconclusiveGate({ status: "parked", reason: "parking phrase" }), false);
  assert.equal(inconclusiveGate({ status: "live" }), false);
});

const pages = {
  // adityathakur.me's kind: nothing for a few seconds, then the portfolio.
  "/slow": `<body><div id=m></div><script>setTimeout(()=>{m.innerHTML="<h1>Aditya Thakur</h1><p>${"Backend engineer building payment systems. ".repeat(4)}</p>"},4000)</script></body>`,
  "/blank": `<body style="background:#fff"></body>`,
  "/ok": `<body><h1>Jane Park</h1><p>${"Designer and developer. ".repeat(4)}</p></body>`,
};
let server;
let browser;
let base;
before(async () => {
  server = http.createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(pages[req.url] ?? "<p>x</p>"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test("a slow page gets time to render; a blank one is still blank after the wait", async () => {
  const page = await browser.newPage();
  await page.goto(`${base}/slow`);
  const slow = await waitForContent(page, 15000);
  assert.equal(slow.content, true);
  assert.ok(slow.ms >= 3000, `waited ${slow.ms} ms`);
  await page.goto(`${base}/blank`);
  const blank = await waitForContent(page, 1500);
  assert.deepEqual([blank.content, blank.ms >= 1500], [false, true]);
  await page.close();
});

test("a screenshot that fails is taken again through the DevTools protocol; other errors are not hidden", async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(`${base}/ok`);
  const real = page.screenshot.bind(page);
  let calls = 0;
  page.screenshot = async () => {
    calls++;
    throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
  };
  const png = await shot(page, { type: "png" });
  assert.equal(calls, 1);
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "a PNG");
  const jpg = await shot(page, { type: "jpeg", quality: 75 });
  assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  page.screenshot = async () => {
    throw new Error("Target page, context or browser has been closed");
  };
  await assert.rejects(() => shot(page), /closed/);
  page.screenshot = real;
  await page.close();
});
