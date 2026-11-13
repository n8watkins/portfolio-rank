// The site's one address setting (lib/site.ts, wrangler.jsonc SITE_URL) and
// the redirect from the old address and www (worker/canonical-host.ts), offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parseJsonc } from "../scripts/check-worker-exports.mjs";
import { OLD_SITE_HOSTS, PRODUCTION_SITE_URL, SITE_URL, STAGING_SITE_URL, sitePath, siteUrl } from "../lib/site.ts";
import { canonicalRedirect } from "../worker/canonical-host.ts";
import { SITE_URL as CONTENT_SITE_URL } from "../pipeline/content/facts.mjs";
import { SITE_ORIGIN as LINKS_SITE_URL } from "../lib/content/portfolio-links.mjs";

const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
const staging = config.env.staging;

test("each Worker's SITE_URL is the address its build uses, and AUTH_URL is gone", () => {
  assert.equal(PRODUCTION_SITE_URL, "https://portfoliorank.dev");
  assert.equal(config.vars.SITE_URL, PRODUCTION_SITE_URL);
  assert.equal(staging.vars.SITE_URL, STAGING_SITE_URL);
  assert.equal(SITE_URL, PRODUCTION_SITE_URL, "a build without NEXT_PUBLIC_SITE_ENV is production's");
  assert.equal(CONTENT_SITE_URL, PRODUCTION_SITE_URL, "the content engine links the production site");
  assert.equal(LINKS_SITE_URL, PRODUCTION_SITE_URL, "post links to our portfolio pages use the production site");
  assert.equal("AUTH_URL" in config.vars, false, "auth.ts gives SITE_URL to Auth.js");
  assert.equal("AUTH_URL" in staging.vars, false);
});

test("production answers at portfoliorank.dev, www and the old address; the rest only redirect", () => {
  const hosts = config.routes.map((r) => (assert.equal(r.custom_domain, true), r.pattern));
  assert.deepEqual(hosts.sort(), ["portfoliorank.dev", "portfoliorank.n8builds.dev", "www.portfoliorank.dev"]);
  for (const host of hosts) {
    if (host !== new URL(PRODUCTION_SITE_URL).hostname) assert.ok(OLD_SITE_HOSTS.includes(host), `${host} redirects`);
  }
  const stagingHosts = staging.routes.map((r) => r.pattern);
  assert.deepEqual(stagingHosts, ["staging.portfoliorank.dev", "staging.portfoliorank.n8builds.dev"]);
  assert.equal(OLD_SITE_HOSTS.includes(new URL(STAGING_SITE_URL).hostname), false, "staging's own host never redirects");
  assert.ok(OLD_SITE_HOSTS.includes("staging.portfoliorank.n8builds.dev"), "staging's old host does");
});

test("siteUrl reads the Worker's variable, without a trailing slash", () => {
  assert.equal(siteUrl({ SITE_URL: "https://staging.portfoliorank.dev/" }), STAGING_SITE_URL);
  assert.equal(siteUrl({}), PRODUCTION_SITE_URL);
});

test("the old address and www redirect to the same path and query on SITE_URL", () => {
  for (const host of OLD_SITE_HOSTS.filter((h) => !h.startsWith("staging."))) {
    const moved = canonicalRedirect(new Request(`https://${host}/p/https%3A%2F%2Fa.dev?view=ai#x`), PRODUCTION_SITE_URL, OLD_SITE_HOSTS);
    assert.equal(moved?.status, 301, host);
    assert.equal(moved?.headers.get("Location"), "https://portfoliorank.dev/p/https%3A%2F%2Fa.dev?view=ai");
  }
  const root = canonicalRedirect(new Request("https://portfoliorank.n8builds.dev/"), PRODUCTION_SITE_URL, OLD_SITE_HOSTS);
  assert.equal(root?.headers.get("Location"), "https://portfoliorank.dev/");
  const stagingMoved = canonicalRedirect(new Request("https://staging.portfoliorank.n8builds.dev/__gate?key=k"), STAGING_SITE_URL, OLD_SITE_HOSTS);
  assert.equal(stagingMoved?.status, 301);
  assert.equal(stagingMoved?.headers.get("Location"), "https://staging.portfoliorank.dev/__gate?key=k");
  const head = canonicalRedirect(new Request("https://portfoliorank.n8builds.dev/healthz", { method: "HEAD" }), PRODUCTION_SITE_URL, OLD_SITE_HOSTS);
  assert.equal(head?.status, 301);
});

test("other methods get a 308, which keeps the method and body", () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const moved = canonicalRedirect(new Request("https://portfoliorank.n8builds.dev/api/polls/1/vote", { method }), PRODUCTION_SITE_URL, OLD_SITE_HOSTS);
    assert.equal(moved?.status, 308, method);
    assert.equal(moved?.headers.get("Location"), "https://portfoliorank.dev/api/polls/1/vote");
  }
});

test("the site's own host, staging and local runs are answered as usual", () => {
  for (const url of ["https://portfoliorank.dev/top", "https://staging.portfoliorank.dev/", "http://localhost:7678/", "http://127.0.0.1:7691/api/polls"]) {
    assert.equal(canonicalRedirect(new Request(url), PRODUCTION_SITE_URL, OLD_SITE_HOSTS), null, url);
  }
  assert.equal(canonicalRedirect(new Request("https://staging.portfoliorank.dev/"), STAGING_SITE_URL, OLD_SITE_HOSTS), null);
  assert.equal(canonicalRedirect(new Request("https://portfoliorank.n8builds.dev/"), undefined, OLD_SITE_HOSTS), null, "no SITE_URL, no redirect");
  assert.equal(canonicalRedirect(new Request("https://portfoliorank.n8builds.dev/"), "not a url", OLD_SITE_HOSTS), null);
});

test("links to the site, on its address or an old one, become paths", () => {
  assert.equal(sitePath("https://portfoliorank.dev/top"), "/top");
  assert.equal(sitePath("https://portfoliorank.n8builds.dev/top?view=ai"), "/top?view=ai");
  assert.equal(sitePath("https://www.portfoliorank.dev/blog/x#y"), "/blog/x#y");
  assert.equal(sitePath("https://portfoliorank.dev"), "/");
  assert.equal(sitePath("https://example.com/top"), "https://example.com/top");
  assert.equal(sitePath("https://portfoliorank.dev.evil.example/top"), "https://portfoliorank.dev.evil.example/top");
  assert.equal(sitePath("/already/a/path"), "/already/a/path");
});

test("no code names an old address except the redirect list and the smoke check's usage line", () => {
  const allowed = [path.join("lib", "site.ts"), path.join("scripts", "smoke.mjs")];
  const roots = ["app", "components", "lib", "worker", "pipeline", "scripts", "auth.ts", "next.config.ts"];
  const files = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p)) walk(path.join(p, f));
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(p)) files.push(p);
  };
  roots.forEach(walk);
  const offenders = files.filter(
    (f) => !allowed.includes(f) && /portfoliorank\.n8builds\.dev/.test(readFileSync(f, "utf8"))
  );
  assert.deepEqual(offenders, []);
});
