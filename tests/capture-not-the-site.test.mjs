// The capture judges where the browser ended with the same rule as the
// health check (pipeline/gate.mjs parkedPage), and a "parked" capture of a
// new site is not stored: so a short real portfolio that kept a web server's
// default <title> must be captured as live, while the server's own default
// page is not stored as the site. End to end through pipeline/capture.mjs
// captureSite in headless Chromium against local pages; the nginx page is the
// one http://gianlucafiore.it served on 2026-11-23. Nothing leaves the machine.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { captureSite, keyOf } from "../pipeline/capture.mjs";
import { ensureRosterSchema } from "../pipeline/roster.mjs";
import { ensureFreshnessSchema } from "../lib/freshness.mjs";

const pages = {
  "/kept-title": `<!doctype html><title>Welcome to nginx!</title><body style="font:20px system-ui;padding:40px"><h1>Sam Lee</h1><p>Backend developer in Lisbon. I build reliable systems.</p>
    <nav><a href="/projects">Projects</a> <a href="/about">About</a> <a href="https://code.invalid/sam">GitHub</a> <a href="mailto:sam@example.invalid">Email me</a></nav></body>`,
  "/nginx": fs.readFileSync(path.join(import.meta.dirname, "fixtures", "reading", "gianlucafiore.it.plain.html"), "utf8"),
};

let server;
let browser;
let base;
let db;
let root;
const results = {};
const url = (p) => `${base}${p}`;

before(async () => {
  server = http.createServer((req, res) => res.writeHead(pages[req.url] ? 200 : 404, { "content-type": "text/html" }).end(pages[req.url] ?? "not found"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "capture-not-site-"));
  db = createClient({ url: `file:${path.join(root, "db.sqlite")}` });
  await ensureRosterSchema(db);
  await ensureFreshnessSchema(db);
  browser = await chromium.launch();
  for (const p of Object.keys(pages)) results[p] = await captureSite(browser, { url: url(p), name: "Sam Lee" }, { db, s3: null, root });
}, { timeout: 300000 });

after(async () => {
  await browser?.close();
  server?.close();
  db?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const rowOf = async (p) => (await db.execute({ sql: "SELECT * FROM portfolios WHERE url = ?", args: [url(p)] })).rows[0];
const stored = (p) => fs.existsSync(path.join(root, "captures", keyOf(url(p)), "hero.jpg"));

test("a first capture of a short real portfolio that kept nginx's default title is stored as live", async () => {
  assert.match(results["/kept-title"], /^live/, results["/kept-title"]);
  const row = await rowOf("/kept-title");
  assert.deepEqual([row.status, row.reason], ["live", ""]);
  assert.ok(stored("/kept-title"), "hero.jpg written");
});

test("nginx's own default page is not stored as the site", async () => {
  assert.doesNotMatch(results["/nginx"], /^live/, results["/nginx"]);
  const row = await rowOf("/nginx");
  assert.equal(row.status, "parked");
  assert.equal(row.reason, "not the site: nginx's default page");
  assert.equal(stored("/nginx"), false);
});
