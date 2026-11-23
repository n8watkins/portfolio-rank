// scripts/lib/robots.mjs: the smoke check reads robots.txt by group, so
// Cloudflare's managed block for AI training crawlers does not read as the
// site closing itself to everyone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closedToEveryone, openToEveryone, rulesForEveryone } from "../scripts/lib/robots.mjs";

const OURS = `User-Agent: *
Allow: /
Disallow: /api/
Disallow: /admin/

Sitemap: https://portfoliorank.dev/sitemap.xml
`;

const CLOSED = `User-agent: *
Disallow: /
`;

// The shape Cloudflare prepends with Training set to Disallow and Bot
// Preference Sync on (developers.cloudflare.com, "robots.txt setting").
const MANAGED = `# As a condition of accessing this website, you agree to abide by the
# following content signals:
# ai-train: training or fine-tuning AI models.

# BEGIN Cloudflare Managed content

User-Agent: *
Content-signal: search=yes, ai-train=no, use=reference
Allow: /

User-agent: Amazonbot
Disallow: /

User-agent: Bytespider
User-agent: CCBot
User-agent: GPTBot
Disallow: /

# END Cloudflare Managed Content
`;

test("our own robots.txt is open; one that disallows everything is closed", () => {
  assert.deepEqual(rulesForEveryone(OURS), { allow: ["/"], disallow: ["/api/", "/admin/"] });
  assert.ok(openToEveryone(OURS));
  assert.ok(!closedToEveryone(OURS));
  assert.ok(closedToEveryone(CLOSED));
  assert.ok(!openToEveryone(CLOSED));
});

test("a managed block that disallows named AI crawlers leaves production open to everyone else", () => {
  const text = MANAGED + OURS;
  assert.deepEqual(rulesForEveryone(text), { allow: ["/", "/"], disallow: ["/api/", "/admin/"] });
  assert.ok(openToEveryone(text), "the old line-by-line check failed here on GPTBot's Disallow: /");
  assert.ok(!closedToEveryone(text));
});

test("a closed robots.txt stays closed under the managed block", () => {
  assert.ok(closedToEveryone(MANAGED + CLOSED));
  assert.ok(!openToEveryone(MANAGED + CLOSED));
});

test("a group with several User-agent lines, comments and odd spacing", () => {
  const text = "user-agent: Googlebot\nUSER-AGENT:   *   # everyone\ndisallow:/\n\nUser-agent: Bingbot\nAllow: /\n";
  assert.deepEqual(rulesForEveryone(text), { allow: [], disallow: ["/"] });
  assert.ok(closedToEveryone(text));
  assert.ok(!openToEveryone(""), "an empty file allows nothing by name");
});
