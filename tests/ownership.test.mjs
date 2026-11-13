// Proving ownership with code the owner deploys (lib/ownership/verify.mjs)
// and the existence check of "Add your portfolio" (lib/tools/exists.mjs),
// offline: `hop` stands in for the network, one Response per request.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REDIRECTS,
  VERIFICATION_META,
  checkProof,
  fetchSameSite,
  fileHasToken,
  verificationFileUrl,
  verificationPath,
  verificationTag,
  verificationTokens,
} from "../lib/ownership/verify.mjs";
import { looksParked, siteExists } from "../lib/tools/exists.mjs";
import { CONTROL_PROOFS } from "../lib/games/claims.mjs";

// A made-up verification code in the real format (lib/ownership/verify.mjs TOKEN_RE), not a secret.
const TOKEN = "test-verification-code-1";

/** A `hop` that answers from a map of URL -> [status, body, headers], recording each request. */
function sites(map) {
  const asked = [];
  const hop = async (url) => {
    asked.push(url);
    const hit = map[url];
    if (!hit) throw new TypeError("fetch failed");
    if (hit === "timeout") throw Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    const [status, body = "", headers = {}] = hit;
    return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
  };
  return { hop, asked };
}

test("the file lives at the site root, whatever path the portfolio is listed under", () => {
  assert.equal(verificationPath(TOKEN), `/portfoliorank-${TOKEN}.txt`);
  assert.equal(verificationFileUrl("https://jane.github.io/portfolio/", TOKEN), `https://jane.github.io/portfoliorank-${TOKEN}.txt`);
  assert.equal(verificationTag(TOKEN), `<meta name="${VERIFICATION_META}" content="${TOKEN}">`);
  for (const bad of ["short", "has space here!", "../../etc/passwd", ""]) assert.throws(() => verificationPath(bad), /token/);
});

test("the file must hold exactly the token, the tag exactly the token, under the new name", () => {
  assert.equal(fileHasToken(`${TOKEN}\n`, TOKEN), true);
  assert.equal(fileHasToken(`  ${TOKEN}  `, TOKEN), true);
  assert.equal(fileHasToken(`token: ${TOKEN}`, TOKEN), false);
  assert.equal(fileHasToken("", TOKEN), false);
  assert.deepEqual(verificationTokens(`<head><meta content="${TOKEN}" name="portfoliorank-verification"><meta name=portfoliorank-verification content=x></head>`), [TOKEN, "x"]);
  assert.deepEqual(verificationTokens(`<meta name="portfoliorank-verify" content="${TOKEN}">`), [], "the old tag name is the old flow's");
});

test("a file proof is checked with one fetch, and a different token or a 404 isn't proof", async () => {
  const file = `https://jane.dev/portfoliorank-${TOKEN}.txt`;
  const ok = sites({ [file]: [200, TOKEN, { "content-type": "text/plain" }] });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "file", hop: ok.hop }), { ok: true });
  assert.deepEqual(ok.asked, [file], "one request");
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "file", hop: sites({ [file]: [200, "someone-elses-token-123"] }).hop }), { ok: false, reason: "not_found" });
  // An SPA that answers every path with its index page is not the file.
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "file", hop: sites({ [file]: [200, "<!doctype html><div id=root></div>"] }).hop }), { ok: false, reason: "not_found" });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "file", hop: sites({ [file]: [404, "nope"] }).hop }), { ok: false, reason: "not_found" });
});

test("a meta proof reads the home page; the token must be the claim's", async () => {
  const home = { "https://jane.dev/": [200, `<html><head>${verificationTag(TOKEN)}</head><body>Jane</body></html>`] };
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "meta", hop: sites(home).hop }), { ok: true });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: "Zz9_other-token-1234", method: "meta", hop: sites(home).hop }), { ok: false, reason: "not_found" });
});

test("redirects: at most 3, all on the same site (www or not); anything else isn't checked", async () => {
  const chain = sites({
    "https://jane.dev/": [301, "", { location: "https://www.jane.dev/" }],
    "https://www.jane.dev/": [302, "", { location: "/home" }],
    "https://www.jane.dev/home": [200, verificationTag(TOKEN)],
  });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "meta", hop: chain.hop }), { ok: true });
  assert.equal(chain.asked.length, 3);

  const away = sites({ "https://jane.dev/": [302, "", { location: "https://attacker.example/" }], "https://attacker.example/": [200, verificationTag(TOKEN)] });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "meta", hop: away.hop }), { ok: false, reason: "off_site" });
  assert.deepEqual(away.asked, ["https://jane.dev/"], "the other site is never fetched");

  const loop = {};
  for (let i = 0; i <= MAX_REDIRECTS + 1; i++) loop[`https://jane.dev/${i}`] = [302, "", { location: `/${i + 1}` }];
  const r = await fetchSameSite("https://jane.dev/0", { hop: sites(loop).hop });
  assert.deepEqual(r, { ok: false, error: "too_many_redirects" });

  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "meta", hop: sites({ "https://jane.dev/": "timeout" }).hop }), { ok: false, reason: "timeout" });
  assert.deepEqual(await checkProof({ url: "https://jane.dev/", token: TOKEN, method: "meta", hop: sites({}).hop }), { ok: false, reason: "unreachable" });
});

test("the file proof unlocks what others see, like the meta tag and GitHub Pages", () => {
  assert.deepEqual([...CONTROL_PROOFS].sort(), ["file", "github_pages", "meta"]);
});

test("parked, for-sale and default pages are told apart from real portfolios", () => {
  for (const html of [
    "<title>jane.dev is for sale</title><h1>This domain is for sale</h1>",
    "<p>Buy this domain. Make an offer on this domain today.</p>",
    "<h1>This domain has expired</h1>",
    "<p>Parked free, courtesy of GoDaddy</p>",
    "<a href='https://www.hugedomains.com/'>HugeDomains</a>",
    "<h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed.</p>",
    "<h1>Coming soon</h1>",
  ]) {
    assert.equal(looksParked(html), true, html);
  }
  const real = "<h1>Jane Doe</h1><p>I build things. My last project shipped a for-sale-by-owner listings app; more features are coming soon to it.</p>" + "<p>Projects and writing.</p>".repeat(30);
  assert.equal(looksParked(real), false);
});

test("a site exists when it answers 200 with HTML that isn't parked", async () => {
  const ok = await siteExists({ url: "https://jane.dev/", hop: sites({ "https://jane.dev/": [200, "<h1>Jane</h1>"] }).hop });
  assert.equal(ok.ok, true);
  // A single-page app's shell has no text yet, but it is a page.
  assert.equal((await siteExists({ url: "https://spa.dev/", hop: sites({ "https://spa.dev/": [200, "<!doctype html><div id=root></div><script src=/app.js></script>"] }).hop })).ok, true);
  const cases = [
    [{ "https://x.dev/": [404, "gone"] }, "not_ok"],
    [{ "https://x.dev/": [200, "{}", { "content-type": "application/json" }] }, "not_html"],
    [{ "https://x.dev/": [200, "<h1>This domain is for sale</h1>"] }, "parked"],
    [{ "https://x.dev/": [301, "", { location: "https://linktr.ee/x" }] }, "redirects_away"],
    [{}, "unreachable"],
  ];
  for (const [map, reason] of cases) {
    const r = await siteExists({ url: "https://x.dev/", hop: sites(map).hop });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, reason);
    assert.ok(r.message);
  }
});
