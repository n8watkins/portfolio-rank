// A parked domain whose home page is only a redirect made in the page
// (nic-nguyen.com, 2026-11-23: HTTP 200, 114 bytes, a script sending the
// browser to /lander, GoDaddy's parking lander) is parked for the health check
// and the capture alike, while real sites that redirect in the page (a
// language, a hash route, a home path, another domain of the same person) or
// serve a nearly empty app shell are not.
//
// Fixtures in tests/fixtures/parked/ are the live answers of 2026-11-23:
// godaddy-root.html (the home page, verbatim), godaddy-lander.html (/lander as
// served, verbatim) and godaddy-lander-rendered.txt (/lander's text after the
// browser drew it, the domain replaced). No network: every request goes to a
// fake fetch that records it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { clientRedirect, httpGate, parkedPage, parkingPhrase } from "../pipeline/gate.mjs";
import { checkSite } from "../pipeline/health.mjs";
import { plainReason } from "../lib/capture-problems.mjs";

const fixture = (f) => fs.readFileSync(new URL(`./fixtures/parked/${f}`, import.meta.url), "utf8");
const ROOT = fixture("godaddy-root.html");
const LANDER = fixture("godaddy-lander.html");
const LANDER_TEXT = fixture("godaddy-lander-rendered.txt");

const PORTFOLIO = (name = "Jane Doe") =>
  `<!doctype html><html><head><title>${name}</title></head><body><h1>${name}</h1><h2>Software engineer</h2>` +
  `<p>${"I build payment systems and developer tools that stay up at three in the morning. ".repeat(4)}</p>` +
  `<a href="https://github.com/janedoe">GitHub</a> <a href="mailto:jane@example.com">Email</a></body></html>`;
const APP_SHELL =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Jane Doe</title>' +
  '<script type="module" crossorigin src="/assets/index-4f1c2a.js"></script><link rel="stylesheet" href="/assets/index-9b0e.css"></head>' +
  '<body><div id="root"></div></body></html>';

/** A fetch that answers from `pages` (url -> { status, body, url }) and records every request. */
function fakeFetch(pages) {
  const seen = [];
  const impl = async (url, init = {}) => {
    seen.push(String(url));
    const p = pages[url];
    if (!p) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    if (p.throws) throw p.throws;
    assert.ok(init.signal, "every request carries the gate's deadline");
    assert.match(String(init.headers?.["User-Agent"] ?? ""), /Chrome\//, "with the gate's own headers");
    return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": "text/html" } });
  };
  // Response.url is read-only; a redirected answer reports where it landed.
  const withUrl = async (url, init) => {
    const res = await impl(url, init);
    const landed = pages[url]?.url;
    if (landed) Object.defineProperty(res, "url", { value: landed });
    else Object.defineProperty(res, "url", { value: String(url) });
    return res;
  };
  return { fetchImpl: withUrl, seen };
}

test("the nic-nguyen home page (a script to /lander, GoDaddy's lander) is parked at the plain request", async () => {
  const { fetchImpl, seen } = fakeFetch({
    "https://www.parked-person.example/": { body: ROOT },
    "https://www.parked-person.example/lander": { body: LANDER },
  });
  const g = await httpGate("https://www.parked-person.example/", { fetchImpl });
  assert.deepEqual([g.status, g.reason, g.finalUrl], ["parked", "parking page: GoDaddy parking lander", "https://www.parked-person.example/lander"]);
  assert.deepEqual(seen, ["https://www.parked-person.example/", "https://www.parked-person.example/lander"], "one hop, on the same host");
});

test("only positive evidence says parked: a page there that cannot be read, answers an error, or is merely short leaves it to the browser", async () => {
  const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const short = `<html><head><title>Jane Doe</title></head><body><h1>Jane Doe</h1><p>${"Product designer in Lisbon. ".repeat(40)}</p></body></html>`;
  const shellNoscript = APP_SHELL.replace("</body>", "<noscript>You need to enable JavaScript to run this app.</noscript></body>");
  const cases = [
    ["/lander drops the connection", "/lander", { throws: reset }],
    ["/lander times out", "/lander", { throws: timeout }],
    ["/parking answers 403 (a bot wall)", "/parking", { status: 403, body: "Forbidden" }],
    ["/parking answers 404 (a single-page app route)", "/parking", { status: 404, body: "Not found" }],
    ["/parking answers 503", "/parking", { status: 503, body: "busy" }],
    ["/lander is an app shell", "/lander", { body: shellNoscript }],
    ["/lander is a short real page", "/lander", { body: short }],
  ];
  for (const [label, at, answer] of cases) {
    const { fetchImpl, seen } = fakeFetch({ "https://jane.dev/": { body: `<script>location.href="${at}"</script>` }, [`https://jane.dev${at}`]: answer });
    const g = await httpGate("https://jane.dev/", { fetchImpl });
    assert.equal(g.status, "live", `${label}: ${g.reason}`);
    assert.equal(seen.length, 2, `${label}: followed once`);
  }
  // An HTTP redirect to /lander or /for-sale that serves an app shell: the browser decides, as before.
  for (const landed of ["https://jane.dev/lander", "https://jane.dev/for-sale"]) {
    const { fetchImpl } = fakeFetch({ "https://jane.dev/": { body: shellNoscript, url: landed } });
    assert.equal((await httpGate("https://jane.dev/", { fetchImpl })).status, "live", landed);
  }
});

test("a redirect in the page to a parking host is parked without asking that host", async () => {
  const meta = '<html><head><meta http-equiv="refresh" content="0; url=https://sedoparking.com/jane.dev"></head><body></body></html>';
  const script = '<html><head><script>window.location.replace("https://www.afternic.com/forsale/jane.dev?utm=x")</script></head></html>';
  for (const [body, host] of [[meta, "sedoparking.com"], [script, "afternic.com"]]) {
    const { fetchImpl, seen } = fakeFetch({ "https://jane.dev/": { body } });
    const g = await httpGate("https://jane.dev/", { fetchImpl });
    assert.deepEqual([g.status, g.reason], ["parked", `redirects to ${host}`]);
    assert.deepEqual(seen, ["https://jane.dev/"]);
  }
});

test("a same-host redirect whose page is a parking page (phrase or lander) is parked, whatever its path", async () => {
  const { fetchImpl } = fakeFetch({
    "https://b.example/": { body: '<script>location.href = "/welcome"</script>' },
    "https://b.example/welcome": { body: "<title>b.example</title><p>This domain is for sale. Make an offer.</p>" },
  });
  const g = await httpGate("https://b.example/", { fetchImpl });
  assert.deepEqual([g.status, g.reason], ["parked", 'parking phrase: "this domain is for sale"']);
});

test("real sites that redirect in the page or serve an app shell stay live", async () => {
  const cases = [
    // A single-page app whose first HTML is nearly empty: no redirect to follow, nothing else asked.
    ["app shell", { "https://jane.dev/": { body: APP_SHELL } }, ["https://jane.dev/"]],
    // A language redirect by script, and a meta refresh to /en/.
    ["language script", { "https://jane.dev/": { body: '<script>location.replace("/en")</script>' }, "https://jane.dev/en": { body: PORTFOLIO() } }, ["https://jane.dev/", "https://jane.dev/en"]],
    ["meta refresh to /en/", { "https://jane.dev/": { body: '<meta http-equiv="refresh" content="0;URL=\'/en/\'">' }, "https://jane.dev/en/": { body: PORTFOLIO() } }, ["https://jane.dev/", "https://jane.dev/en/"]],
    // A home path that is itself an app shell: small is not parked.
    ["home path, app shell", { "https://jane.dev/": { body: '<script>window.location.href="/home"</script>' }, "https://jane.dev/home": { body: APP_SHELL } }, ["https://jane.dev/", "https://jane.dev/home"]],
    // A hash route: the same page, not followed.
    ["hash route", { "https://jane.dev/": { body: '<script>window.location.href = "#/home";</script><div id=app></div>' } }, ["https://jane.dev/"]],
    // Another domain of the same person: never followed by the gate (the health check judges moves).
    ["other domain", { "https://jane.dev/": { body: '<script>window.location.href="https://janedoe.design/"</script>' } }, ["https://jane.dev/"]],
    // A real page at a parking-like path: the path alone never decides.
    ["real page at /parking", { "https://jane.dev/": { body: '<script>location.href="/parking"</script>' }, "https://jane.dev/parking": { body: PORTFOLIO().replace("</body>", `<p>${"A city parking app I built with a team of four. ".repeat(30)}</p></body>`) } }, ["https://jane.dev/", "https://jane.dev/parking"]],
  ];
  for (const [label, pages, requests] of cases) {
    const { fetchImpl, seen } = fakeFetch(pages);
    const g = await httpGate("https://jane.dev/", { fetchImpl });
    assert.equal(g.status, "live", `${label}: ${g.reason}`);
    assert.equal(g.finalUrl, "https://jane.dev/", `${label}: the gate reports the page it was asked for`);
    assert.deepEqual(seen, requests, label);
  }
});

test("clientRedirect reads only small pages with no text of their own", () => {
  assert.equal(clientRedirect(ROOT, "https://x.example/"), "https://x.example/lander");
  assert.equal(clientRedirect('<meta content="3;url=https://x.example/en/" http-equiv="refresh">', "https://x.example/"), "https://x.example/en/");
  assert.equal(clientRedirect('<meta http-equiv="refresh" content="30">', "https://x.example/"), null, "a refresh without a URL reloads the page");
  assert.equal(clientRedirect(APP_SHELL, "https://x.example/"), null);
  assert.equal(clientRedirect(`<p>${"words ".repeat(20)}</p><script>location.href="/lander"</script>`, "https://x.example/"), null, "a page with text of its own");
  assert.equal(clientRedirect(`<script>${"/* bundle */ ".repeat(1000)}location.href="/lander"</script>`, "https://x.example/"), null, "a big inline bundle");
  assert.equal(clientRedirect('<script src="/x.js">location.href="/lander"</script>', "https://x.example/"), null, "a script loaded from a file");
  assert.equal(clientRedirect('<script>location.href="javascript:void(0)"</script>', "https://x.example/"), null);
  // Only a redirect that always runs on load.
  assert.equal(clientRedirect('<script>document.addEventListener("DOMContentLoaded", () => { location.replace("/lander"); });</script>', "https://x.example/"), "https://x.example/lander");
  assert.equal(clientRedirect('<div id=a></div><script>document.getElementById("a").onclick=()=>{location.href="/parking"}</script>', "https://x.example/"), null, "a click handler");
  assert.equal(clientRedirect('<script>if(!localStorage.t)location.href="/login"</script>', "https://x.example/"), null, "a condition");
  assert.equal(clientRedirect('<script>if(location.pathname==="/")location.href="/lander"</script>', "https://x.example/"), null, "a condition on the path");
  assert.equal(clientRedirect('<script>const location = "/parking";</script>', "https://x.example/"), null, "a variable named location");
  assert.equal(clientRedirect('<script>data.location = "/parking"</script>', "https://x.example/"), null, "a property named location");
  assert.equal(clientRedirect('<meta http-equiv="refresh" content="600;url=/parked"><div id=root></div>', "https://x.example/"), null, "a session timeout");
  assert.equal(clientRedirect('<div id=root></div><noscript>You need to enable JavaScript to run this app.</noscript><script>location.href="/lander"</script>', "https://x.example/"), null, "<noscript> text is text");
});

test("parkedPage judges where the browser ended: the rendered lander is parked, a real page there is not", () => {
  assert.equal(parkedPage({ finalUrl: "https://www.parked-person.example/lander", text: LANDER_TEXT, title: "" }), 'parking phrase: "has expired and is parked"');
  assert.equal(parkedPage({ finalUrl: "https://www.parked-person.example/lander", html: LANDER }), "parking page: GoDaddy parking lander");
  assert.equal(parkedPage({ finalUrl: "https://x.example/lander", html: "<div id=root></div>", text: "" }), null, "a path and an empty page are no evidence");
  // Markers: a script loaded from a parking host, never a data-src or a lookalike host or GoDaddy's other tags.
  const marker = (html) => parkedPage({ finalUrl: "https://jane.dev/", html, text: "Jane Doe portfolio" });
  assert.equal(marker('<script src="//www.dan.com/widget.js"></script>'), "parking page: a script from a parking service");
  assert.equal(marker('<img data-src="//cdn.bodis.com/x"><script data-src="//cdn.bodis.com/x.js"></script>'), null);
  assert.equal(marker('<script src="https://jordan.com/x.js"></script>'), null);
  assert.equal(marker('<script src="https://img1.wsimg.com/signals/js/clients/scc-c2/scc-c2.min.js"></script>'), null);
  assert.equal(marker('<script>window._trfd.push({"tccl.baseHost":"secureserver.net"},{"ap":"cpsh-oh"})</script>'), null);
  assert.equal(parkedPage({ finalUrl: "https://bodis.com/x" }), "redirects to bodis.com");
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/en/", html: PORTFOLIO() }), null);
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/", html: APP_SHELL, text: "" }), null, "an empty app shell is not parked");
  assert.equal(parkedPage({ finalUrl: "https://jane.dev/#/home", text: "Jane Doe Software engineer" }), null);
});

test("checkSite: the parked redirect fails as 'answers with the wrong thing'; real redirects and app shells pass", async () => {
  const site = { name: "Jane Doe", url: "https://www.parked-person.example" };
  const parked = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://www.parked-person.example": { body: ROOT }, "https://www.parked-person.example/lander": { body: LANDER } }).fetchImpl,
    render: async () => assert.fail("decided by the plain request, no browser needed"),
  });
  assert.deepEqual([parked.ok, parked.reason], [false, "parking page: GoDaddy parking lander"]);

  // A redirect the plain request cannot read (built at run time) is judged on the browser's page.
  const built = await checkSite(site, {
    fetchImpl: fakeFetch({ "https://www.parked-person.example": { body: '<script>location.href = "/" + "lander"</script>' } }).fetchImpl,
    render: async () => ({ status: 200, finalUrl: "https://www.parked-person.example/lander", title: "", text: LANDER_TEXT, html: LANDER, media: false }),
  });
  assert.deepEqual([built.ok, built.reason], [false, 'parking phrase: "has expired and is parked"']);

  const jane = { name: "Jane Doe", url: "https://jane.dev" };
  const shell = await checkSite(jane, {
    fetchImpl: fakeFetch({ "https://jane.dev": { body: APP_SHELL } }).fetchImpl,
    render: async () => ({ status: 200, finalUrl: "https://jane.dev/", title: "Jane Doe", text: "Jane Doe Software engineer. I build payment systems and developer tools.", html: PORTFOLIO(), media: false }),
  });
  assert.equal(shell.ok, true, shell.reason);
  const lang = await checkSite(jane, {
    fetchImpl: fakeFetch({ "https://jane.dev": { body: '<meta http-equiv="refresh" content="0;url=/en/">' }, "https://jane.dev/en/": { body: PORTFOLIO() } }).fetchImpl,
    render: async () => ({ status: 200, finalUrl: "https://jane.dev/en/", title: "Jane Doe", text: "Jane Doe Software engineer. I build payment systems and developer tools.", html: PORTFOLIO(), media: false }),
  });
  assert.equal(lang.ok, true, lang.reason);
  // Another live site of the same person: a move, not a failure.
  const moved = await checkSite(jane, {
    fetchImpl: fakeFetch({ "https://jane.dev": { body: '<script>window.location.href="https://janedoe.design/"</script>' } }).fetchImpl,
    render: async () => ({ status: 200, finalUrl: "https://janedoe.design/", title: "Jane Doe", text: "Jane Doe Software engineer. I build payment systems and developer tools.", html: PORTFOLIO(), media: false }),
  });
  assert.deepEqual([moved.ok, moved.moved, moved.hijack], [true, true, false]);
});

test("the Capture problems page says the new reason in plain words", () => {
  const p = plainReason("parked: parking page: GoDaddy parking lander");
  assert.deepEqual([p.kind, p.text], ["noanswer", "The page is a parked domain (GoDaddy parking lander)."]);
});

test("phrases: the GoDaddy lander's words count, a car 'parked free of charge' does not; phrases read across line breaks", () => {
  assert.equal(parkingPhrase({ text: LANDER_TEXT, title: "" }), "has expired and is parked");
  assert.equal(parkingPhrase({ text: "ParkSpot - find out if your car is parked free of charge in your city. Jane Doe, mobile developer.", title: "Jane" }), undefined);
  assert.equal(parkingPhrase({ text: "jane.dev\nis for sale.\nDomain\nfor sale", title: "" }), "domain for sale");
});
