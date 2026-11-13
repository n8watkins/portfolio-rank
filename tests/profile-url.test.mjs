// lib/profile-url.mjs and worker/profile-redirect.ts: a profile's readable
// address, and the one 301 every old form of it gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legacyAddress, profileImagePath, profilePath, profileSlug, requestedSlug, slugKey } from "../lib/profile-url.mjs";
import { siteKeyOf } from "../lib/grader/url.mjs";
import { legacyProfileRedirect } from "../worker/profile-redirect.ts";

test("the readable address drops the scheme, www, the query, the fragment and a trailing slash; the path keeps its case", () => {
  assert.equal(profilePath("https://janedoe.dev"), "/p/janedoe.dev");
  assert.equal(profilePath("https://www.JaneDoe.dev/"), "/p/janedoe.dev");
  assert.equal(profilePath("http://jane.github.io/Portfolio/"), "/p/jane.github.io/Portfolio");
  assert.equal(profilePath("https://aravinthvr.github.io/portfolio/?utm_source=github#about"), "/p/aravinthvr.github.io/portfolio");
  assert.equal(profilePath("https://awrs.me/en"), "/p/awrs.me/en");
  assert.equal(profileImagePath("https://jane.github.io/Portfolio"), "/og/p/jane.github.io/Portfolio");
  // A path the URL parser percent-encodes stays encoded in the link.
  assert.equal(profilePath("https://example.com/café"), "/p/example.com/caf%C3%A9");
  // Not a URL: the old encoded form, so a link is never broken.
  assert.equal(profilePath("not a url"), "/p/not%20a%20url");
});

test("a readable slug looks the site up by its site key, whatever the case", () => {
  for (const url of ["https://janedoe.dev", "https://www.jane.github.io/Portfolio/", "http://example.com/café"]) {
    assert.equal(slugKey(requestedSlug(profileSlug(url))), siteKeyOf(url), url);
  }
  assert.equal(slugKey("Jane.GitHub.io/Portfolio"), "jane.github.io/portfolio");
  // Old forms and junk are never looked up as a slug.
  for (const slug of ["https://janedoe.dev", "https:/janedoe.dev", "mailto:x@y.z", "", null]) assert.equal(slugKey(slug), null, String(slug));
});

test("the route's segments decode one by one, and a broken escape is not a slug", () => {
  assert.equal(requestedSlug(["https%3A%2F%2Fjanedoe.dev"]), "https://janedoe.dev");
  assert.equal(requestedSlug(["jane.github.io", "Portfolio"]), "jane.github.io/Portfolio");
  assert.equal(requestedSlug("example.com/caf%C3%A9"), "example.com/café");
  assert.equal(requestedSlug(["%E0%A4%A"]), null);
});

test("an old address is recognized in all three forms, and nothing else is", () => {
  for (const slug of ["https://janedoe.dev", "https:/janedoe.dev", "HTTPS://janedoe.dev"]) assert.equal(legacyAddress(slug), "https://janedoe.dev/", slug);
  assert.equal(legacyAddress("http://jane.github.io/Portfolio/"), "http://jane.github.io/Portfolio/");
  for (const slug of ["janedoe.dev", "httpsjanedoe.dev", "https:", "ftp://x.dev", null]) assert.equal(legacyAddress(slug), null, String(slug));
});

const req = (path, init) => new Request(`https://portfoliorank.dev${path}`, init);

test("the Worker answers every old form with one 301 to the readable address, keeping the query", () => {
  const cases = {
    "/p/https%3A%2F%2Faadarshrai.vercel.app": "/p/aadarshrai.vercel.app",
    "/p/https://aadarshrai.vercel.app": "/p/aadarshrai.vercel.app",
    "/p/https:/aadarshrai.vercel.app": "/p/aadarshrai.vercel.app",
    "/p/https%3A%2F%2Fwww.Example.com%2FPortfolio%2F": "/p/example.com/Portfolio",
    "/p/https:/vasudev7891.github.io/Portfolio": "/p/vasudev7891.github.io/Portfolio",
    "/p/http%3A%2F%2Fexample.com?ref=x": "/p/example.com?ref=x",
  };
  for (const [from, to] of Object.entries(cases)) {
    const r = legacyProfileRedirect(req(from));
    assert.equal(r?.status, 301, from);
    assert.equal(r.headers.get("Location"), to, from);
  }
  assert.equal(legacyProfileRedirect(req("/p/https%3A%2F%2Fexample.com", { method: "HEAD" }))?.status, 301);
});

test("the Worker leaves readable addresses, other pages and writes alone", () => {
  for (const path of ["/p/janedoe.dev", "/p/httpbin.org", "/p/jane.github.io/Portfolio", "/", "/top", "/og/p/janedoe.dev", "/p/%E0%A4%A"]) {
    assert.equal(legacyProfileRedirect(req(path)), null, path);
  }
  assert.equal(legacyProfileRedirect(req("/p/https%3A%2F%2Fexample.com", { method: "POST" })), null);
});
