// The grader's capture on GitHub Actions, offline: the filtering proxy and
// guarded fetch keep a visitor-chosen page away from private addresses
// (SSRF through the browser, redirects and DNS), and a real Chromium capture
// works through the proxy (pipeline/grade-capture.mjs) against a local page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createFilteringProxy, guardedFetch, resolvePublic } from "../pipeline/net-guard-node.mjs";
import { capturePage } from "../pipeline/grade-capture.mjs";

// Fake DNS: public.test is public, evil.test resolves to the metadata
// service, mixed.test to one public and one private address.
const lookup = async (host) => {
  const table = { "public.test": ["93.184.216.34"], "evil.test": ["169.254.169.254"], "wire.test": ["168.63.129.16"], "mixed.test": ["93.184.216.34", "10.0.0.7"], "v6.test": ["::1"] };
  if (!table[host]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return table[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

let site;
let sitePort;
let hits = 0;
before(async () => {
  site = http.createServer((req, res) => {
    hits++;
    if (req.url === "/secret") {
      res.writeHead(200, { "content-type": "text/plain" }).end("internal secret");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html><head><title>Jane Doe - Developer</title></head>
<body style="font-family:sans-serif;padding:40px"><h1>Jane Doe</h1><p>Frontend developer building fast, accessible web apps.</p>
<nav><a href="#projects">Projects</a> <a href="#about">About</a> <a href="mailto:jane@example.com">Contact</a></nav>
<section id="projects"><h2>Projects</h2><p>Shop: cut checkout time by 30%.</p><a href="https://github.com/jane/shop">Code</a></section>
<section id="about"><h2>About</h2><p>I like tidy interfaces.</p></section><footer>© 2026 Jane Doe</footer>
<img src="http://127.0.0.1:${sitePort}/secret" alt=""></body></html>`);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  sitePort = site.address().port;
});
after(() => site.close());

test("DNS check: a name is public only when every address it resolves to is", async () => {
  assert.deepEqual(await resolvePublic("public.test", { lookup }), { ok: true, address: "93.184.216.34" });
  assert.equal((await resolvePublic("evil.test", { lookup })).ok, false);
  // Azure's WireServer: public-range, but it reaches the runner's host.
  assert.equal((await resolvePublic("wire.test", { lookup })).ok, false);
  assert.equal((await resolvePublic("168.63.129.16", { lookup })).ok, false);
  assert.equal((await resolvePublic("::ffff:168.63.129.16", { lookup })).ok, false);
  assert.equal((await resolvePublic("168.63.129.17", { lookup })).ok, true, "only the WireServer, not its neighbours");
  assert.equal((await resolvePublic("mixed.test", { lookup })).ok, false);
  assert.equal((await resolvePublic("v6.test", { lookup })).ok, false);
  assert.equal((await resolvePublic("nowhere.test", { lookup })).ok, false);
  assert.equal((await resolvePublic("localhost", { lookup })).ok, false);
  assert.equal((await resolvePublic("127.0.0.1", { lookup })).ok, false);
  assert.equal((await resolvePublic("[::ffff:127.0.0.1]", { lookup })).ok, false);
});

test("guarded fetch: private hops, odd ports and redirects into the private network are refused", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    assert.equal(init.redirect, "manual");
    if (url === "https://public.test/r") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    if (url === "https://public.test/r2") return new Response(null, { status: 301, headers: { location: "https://evil.test/" } });
    return new Response("ok", { status: 200 });
  };
  const f = guardedFetch({ lookup, fetchImpl });
  assert.equal((await f("https://public.test/ok")).status, 200);
  await assert.rejects(f("https://public.test/r"), /blocked/);
  await assert.rejects(f("https://public.test/r2"), /blocked: resolves to a private address/);
  await assert.rejects(f("https://evil.test/"), /blocked/);
  await assert.rejects(f("https://public.test:8443/"), /blocked: port 8443/);
  await assert.rejects(f("http://127.0.0.1/"), /blocked/);
  await assert.rejects(f("file:///etc/passwd"), /blocked/);
  assert.deepEqual(seen, ["https://public.test/ok", "https://public.test/r", "https://public.test/r2"], "nothing private was ever requested");
});

test("guarded fetch: connects only to the address it checked, so DNS rebinding can't reach the runner", async () => {
  // Local stand-ins: the site on 127.0.0.1 plays a public host; any other address is "private".
  const allow = (a) => a === "127.0.0.1";
  const ports = new Set([sitePort]);
  const pinned = guardedFetch({ lookup: async () => [{ address: "127.0.0.1", family: 4 }], allow, ports });
  const ok = await pinned(`http://pinned.test:${sitePort}/`);
  assert.equal(ok.status, 200, "the connection used the checked address, not the system's DNS");
  await ok.text();

  // A rebinding name: the check sees the allowed address, the next answer is another.
  let answers = 0;
  const rebinding = async () => [{ address: answers++ === 0 ? "127.0.0.1" : "127.0.0.2", family: 4 }];
  const before = hits;
  await assert.rejects(guardedFetch({ lookup: rebinding, allow, ports })(`http://rebind.test:${sitePort}/secret`), /blocked: resolves to a private address/);
  assert.equal(hits, before, "nothing was requested");
  assert.ok(answers >= 2, "the connection resolved the name through the guard");
});

function connect(proxyPort, target) {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once("data", (d) => {
      resolve(String(d).split("\r\n")[0]);
      s.destroy();
    });
    s.on("error", () => resolve("error"));
  });
}
function plainGet(proxyPort, url) {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", () => resolve({ status: 0, body: "" }));
  });
}

test("filtering proxy: tunnels and plain requests to private addresses, local names and odd ports are refused", async () => {
  const proxy = await createFilteringProxy({ lookup });
  try {
    assert.match(await connect(proxy.port, `127.0.0.1:${sitePort}`), /403/);
    assert.match(await connect(proxy.port, "evil.test:443"), /403/);
    assert.match(await connect(proxy.port, "mixed.test:443"), /403/);
    assert.match(await connect(proxy.port, "localhost:443"), /403/);
    assert.match(await connect(proxy.port, "[::1]:443"), /403/);
    assert.match(await connect(proxy.port, "public.test:22"), /403/);
    const before = hits;
    const r = await plainGet(proxy.port, `http://127.0.0.1:${sitePort}/secret`);
    assert.equal(r.status, 403);
    assert.equal((await plainGet(proxy.port, "http://evil.test/latest/meta-data/")).status, 403);
    assert.equal(hits, before, "the private server was never reached");
    assert.ok(proxy.stats.blocked >= 8);
  } finally {
    await proxy.close();
  }
});

test("capture: a page that lives on a private address can't be captured through the proxy", async () => {
  const proxy = await createFilteringProxy({ lookup });
  const browser = await chromium.launch({ proxy: { server: proxy.url }, args: ["--proxy-bypass-list=<-loopback>"] });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-cap-"));
    const before = hits;
    const r = await capturePage(browser, `http://127.0.0.1:${sitePort}/`, { dir, linkFetch: guardedFetch({ lookup }), settlePolls: 1, pollMs: 100 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /somewhere we don't visit|couldn't be opened/);
    assert.equal(hits, before, "loopback was not reached through the browser");
  } finally {
    await browser.close();
    await proxy.close();
  }
});

test("capture: through the proxy, a page yields hero and mobile screenshots, page text, facts and a fingerprint", async () => {
  // This test's local "site" stands in for a public one: the proxy is told every address is public.
  const proxy = await createFilteringProxy({ lookup, allow: () => true, ports: new Set([sitePort]) });
  const browser = await chromium.launch({ proxy: { server: proxy.url }, args: ["--proxy-bypass-list=<-loopback>"] });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grade-cap-"));
    const linkFetch = async () => new Response("ok", { status: 200 });
    const r = await capturePage(browser, `http://127.0.0.1:${sitePort}/`, { dir, linkFetch, settlePolls: 2, pollMs: 200 });
    assert.equal(r.ok, true, r.reason);
    assert.ok(fs.statSync(r.files.hero).size > 1000);
    assert.ok(fs.statSync(r.files.mobile).size > 500);
    assert.match(r.pageText, /Frontend developer/);
    assert.equal(r.facts.contact, true);
    assert.equal(r.facts.footer_year, 2026);
    assert.equal(r.facts.project_links.checked, 1);
    assert.match(r.meta.domHash, /^[0-9a-f]{40}$/);
    assert.equal(typeof r.meta.motion, "boolean");
    assert.ok(proxy.stats.requests > 0, "the browser's traffic went through the proxy");
  } finally {
    await browser.close();
    await proxy.close();
  }
});
