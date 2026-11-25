// The cookie check's pure parts (pipeline/cookie-check.mjs, lib/cookie-check.mjs):
// each state from fixtures of what the browser saw on arrival
// (tests/fixtures/cookie-check/readings.json), cookieless analytics never
// counted as tracking, a banner whose tracker fires anyway, first and third
// party, cookie values never kept, readings kept by vantage, and the three
// display levels a profile will show.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  EU_SETTINGS,
  PRIVACY_VERSION,
  captureRegion,
  classifyCookies,
  classifyRequests,
  deniedConsentPing,
  makeReading,
  siteOf,
  trackingCookieVendor,
  vantageOf,
  wantsSecondVantage,
  withReading,
} from "../pipeline/cookie-check.mjs";
import { cookieCheckView, cookieReading } from "../lib/cookie-check.mjs";

const fixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cookie-check", "readings.json"), "utf8"));
const cases = Object.entries(fixtures).filter(([k]) => !k.startsWith("_"));
const AT = new Date("2026-11-25T12:00:00Z");
const read = (name, extra = {}) => makeReading({ ...fixtures[name], at: AT, ...extra });
const factsWith = (...readings) => ({ v: 4, resume: true, privacy: withReading(null, ...readings) });

for (const [name, fx] of cases) {
  test(`fixture ${name}: ${fx.expect}`, () => {
    const r = read(name);
    assert.equal(r.state, fx.expect, JSON.stringify(r));
    assert.equal(r.region, "US");
    assert.equal(r.vantage, "US");
    assert.equal(r.v, PRIVACY_VERSION);
  });
}

test("every state is covered by a fixture", () => {
  const states = new Set(cases.map(([, fx]) => fx.expect));
  for (const s of ["none", "after-consent", "with-banner", "no-consent", "unknown"]) assert.ok(states.has(s), s);
});

test("cookieless analytics are recorded apart and never count as tracking", () => {
  const r = read("none-cookieless");
  assert.equal(r.state, "none");
  assert.deepEqual([...new Set(r.cookieless.map((c) => c.vendor))].sort(), ["Cloudflare Web Analytics", "GoatCounter", "Plausible", "Vercel Analytics"]);
  assert.equal(r.trackers.length, 0);
  assert.equal(r.tracking_cookies, 0);
  // With a tracker beside them, the tracker decides.
  const both = makeReading({ ...fixtures["none-cookieless"], requests: [...fixtures["none-cookieless"].requests, "https://www.google-analytics.com/g/collect?v=2"] });
  assert.equal(both.state, "no-consent");
  assert.ok(both.cookieless.length > 0);
});

test("a self-hosted cookieless script is seen by its address on the page", () => {
  const r = makeReading({ pageUrl: "https://me.example.dev/", requests: ["https://me.example.dev/"], dom: { tools: [], banner: null, scripts: ["https://me.example.dev/umami.js"] } });
  assert.equal(r.state, "none");
  assert.deepEqual(r.cookieless.map((c) => c.vendor), ["Umami"]);
});

test("a banner whose tracker fires anyway is with-banner, named by its vendors", () => {
  const r = read("with-banner-tracker-fires-anyway");
  assert.equal(r.state, "with-banner");
  assert.equal(r.banner, true);
  assert.deepEqual(r.vendors, ["Google Analytics"]);
  assert.equal(r.tracking_cookies, 2);
  assert.deepEqual(r.trackers.map((t) => [t.host, t.requests]), [["www.google-analytics.com", 1]]);
  assert.deepEqual(r.loaders.map((t) => t.host), ["www.googletagmanager.com"]);
});

test("a tag loader alone, or consent mode's denied pings, are not tracking", () => {
  const r = read("after-consent-tool");
  assert.equal(r.state, "after-consent");
  assert.equal(r.tool, "Cookiebot");
  assert.equal(r.consent_mode_pings, 1);
  assert.equal(r.trackers.length, 0);
  assert.equal(read("none-loader-only").loaders[0].vendor, "Google Tag Manager");
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G100"), true);
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G1-0"), true);
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G101"), false, "analytics granted");
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G110"), false, "ads granted");
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect"), false, "no consent mode");
});

test("a consent tool that loaded but showed no banner is no-consent, with the reason", () => {
  const r = read("no-consent-tool-shows-no-banner");
  assert.equal(r.state, "no-consent");
  assert.equal(r.tool, "OneTrust");
  assert.equal(r.banner, false);
  assert.match(r.reason, /OneTrust loaded but showed no banner .*US/);
});

test("unknown: tracking with a page that could not be read, and a reading that failed", () => {
  assert.match(read("unknown-dom-unreadable").reason, /could not be read/);
  const failed = makeReading({ error: "the cookies could not be read (Target closed)", at: AT });
  assert.equal(failed.state, "unknown");
  assert.match(failed.reason, /Target closed/);
});

test("cookie values are never kept, and cookies are first or third party by site", () => {
  const r = read("no-consent");
  assert.ok(!JSON.stringify(r).includes("GA1") && !JSON.stringify(r).includes("eyJ"), "no value");
  for (const c of r.cookies) assert.deepEqual(Object.keys(c).sort(), ["domain", "name", "party", "tracking"]);
  assert.deepEqual(r.cookies.map((c) => [c.name, c.party, c.tracking]), [
    ["_ga", "first", "Google Analytics"],
    ["_hjSessionUser_6380611", "first", "Hotjar"],
    ["session", "first", null],
  ]);
  const third = classifyCookies([{ name: "MUID", domain: ".clarity.ms" }, { name: "_ga", domain: ".other.github.io" }], "https://aj.github.io/");
  assert.deepEqual(third.map((c) => c.party), ["third", "third"], "another github.io site is a third party");
  assert.equal(siteOf("www.ana.dev"), "ana.dev");
  assert.equal(siteOf("ana.github.io"), "ana.github.io");
  assert.equal(siteOf("x.ana.vercel.app"), "ana.vercel.app");
  assert.equal(siteOf("www.shop.co.uk"), "shop.co.uk");
});

test("tracking cookies by name and by the network's own domain", () => {
  assert.equal(trackingCookieVendor({ name: "_gcl_au", domain: ".a.dev" }), "Google Ads");
  assert.equal(trackingCookieVendor({ name: "_fbp", domain: ".a.dev" }), "Meta Pixel");
  assert.equal(trackingCookieVendor({ name: "_clck", domain: ".a.dev" }), "Microsoft Clarity");
  assert.equal(trackingCookieVendor({ name: "li_sugr", domain: ".linkedin.com" }), "LinkedIn");
  assert.equal(trackingCookieVendor({ name: "_ttp", domain: ".a.dev" }), "TikTok");
  assert.equal(trackingCookieVendor({ name: "IDE", domain: ".doubleclick.net" }), "Google Ads");
  assert.equal(trackingCookieVendor({ name: "anything", domain: ".doubleclick.net" }), "Google Ads");
  assert.equal(trackingCookieVendor({ name: "VISITOR_INFO1_LIVE", domain: ".youtube.com" }), "YouTube");
  // Not tracking: a bot check's, a session's, a consent tool's own record, a page's own preference.
  for (const name of ["__cf_bm", "cf_clearance", "session", "CookieConsent", "OptanonConsent", "theme", "_GRECAPTCHA"]) {
    assert.equal(trackingCookieVendor({ name, domain: ".a.dev" }), null, name);
  }
});

test("requests: tracker hosts by host and count, subdomains included, loaders apart", () => {
  const r = classifyRequests([
    "https://www.google-analytics.com/g/collect?v=2",
    "https://region1.google-analytics.com/g/collect?v=2",
    "https://region1.google-analytics.com/g/collect?v=2",
    "https://www.googletagmanager.com/gtag/js?id=G-1",
    "https://snap.licdn.com/li.lms-analytics/insight.min.js",
    "https://px.ads.linkedin.com/collect?pid=1",
    "https://cdn.cookielaw.org/scripttemplates/otSDKStub.js",
    "https://notgoogle-analytics.com/x",
    "not a url",
  ]);
  assert.deepEqual(r.trackers.map((t) => [t.host, t.requests]), [["region1.google-analytics.com", 2], ["px.ads.linkedin.com", 1], ["www.google-analytics.com", 1]]);
  assert.deepEqual(r.loaders.map((t) => t.vendor).sort(), ["Google Tag Manager", "LinkedIn"]);
  assert.deepEqual(r.consentHosts, ["OneTrust"]);
});

test("readings are kept by vantage: a new reading replaces its own, the others stay", () => {
  const us = read("no-consent");
  const eu = makeReading({ ...fixtures["with-banner-tracker-fires-anyway"], vantage: EU_SETTINGS, at: AT });
  assert.equal(eu.vantage, "US+eu-browser");
  assert.match(eu.label, /^address in US, European browser settings/);
  assert.doesNotMatch(eu.label, /seen from Europe/i);
  const later = { ...makeReading({ ...fixtures["none-plain"], region: "EU", at: AT }) };
  const stored = withReading(withReading(null, us, eu), later);
  assert.deepEqual(Object.keys(stored.readings).sort(), ["EU", "US", "US+eu-browser"]);
  const again = withReading(stored, read("none-plain"));
  assert.equal(again.readings.US.state, "none");
  assert.equal(again.readings.EU.state, "none");
  assert.equal(again.readings["US+eu-browser"].state, "with-banner");
  // A stored part of another version is not read.
  assert.deepEqual(Object.keys(withReading({ v: 99, readings: { EU: later } }, us).readings), ["US"]);
  assert.equal(vantageOf("US").key, "US");
});

test("the second vantage is made only when the first saw a consent tool or a tracker", () => {
  assert.equal(wantsSecondVantage(read("none-plain")), false);
  assert.equal(wantsSecondVantage(read("none-cookieless")), false, "cookieless analytics alone");
  assert.equal(wantsSecondVantage(read("none-loader-only")), true, "a tag loader a banner could be holding");
  assert.equal(wantsSecondVantage(read("no-consent")), true);
  assert.equal(wantsSecondVantage(read("after-consent-tool")), true);
  assert.equal(wantsSecondVantage(read("unknown-dom-unreadable")), false);
});

test("the region is the runner's, US unless CAPTURE_REGION says otherwise", () => {
  assert.equal(captureRegion({}), "US");
  assert.equal(captureRegion({ CAPTURE_REGION: "eu" }), "EU");
});

test("display: pass, information and fix, each with its plain sentence", () => {
  const view = (name) => cookieCheckView(factsWith(read(name)));
  assert.deepEqual(
    Object.fromEntries(cases.map(([name]) => [name, view(name).level])),
    {
      "none-cookieless": "pass",
      "none-plain": "pass",
      "after-consent-tool": "pass",
      "after-consent-generic": "pass",
      "with-banner-tracker-fires-anyway": "fix",
      "with-banner-third-party-only": "fix",
      "no-consent": "fix",
      "no-consent-tool-shows-no-banner": "fix",
      "no-consent-requests-only": "fix",
      "none-loader-only": "pass",
      "unknown-dom-unreadable": "information",
      "none-dom-unreadable": "pass",
    }
  );
  assert.equal(view("none-plain").sentence, "No tracking cookies or trackers. Checked from the US.");
  assert.equal(
    view("none-cookieless").sentence,
    "No tracking cookies or trackers; visits are counted with Plausible, Vercel Analytics, GoatCounter and Cloudflare Web Analytics, which set no cookies. Checked from the US."
  );
  assert.equal(view("after-consent-tool").sentence, "Asks before tracking: a cookie banner (Cookiebot) is shown and nothing tracks the visit before a choice. Checked from the US.");
  assert.equal(
    view("with-banner-tracker-fires-anyway").sentence,
    "Tracking (Google Analytics) starts before the visitor answers the cookie banner. Start it only after the visitor accepts. Checked from the US."
  );
  assert.equal(
    view("no-consent").sentence,
    "Tracks visitors without asking (Google Analytics and Hotjar): no cookie banner was shown. Ask first, or use analytics that set no cookies. Checked from the US."
  );
  assert.match(view("no-consent-tool-shows-no-banner").sentence, /OneTrust loaded but showed none/);
  assert.match(view("unknown-dom-unreadable").sentence, /^Could not tell whether the site asks before tracking: tracking started, but/);
});

test("display: a banner shown only to European browser settings is said, the US verdict stands", () => {
  const us = read("no-consent");
  const eu = makeReading({ ...fixtures["with-banner-tracker-fires-anyway"], vantage: EU_SETTINGS, at: AT });
  const v = cookieCheckView(factsWith(us, eu));
  assert.equal(v.level, "fix");
  assert.match(v.sentence, /A banner does appear for a browser set to European settings\./);
  const second = cookieCheckView(factsWith(us, eu), "US+eu-browser");
  assert.equal(second.level, "fix");
  assert.match(second.sentence, /Checked from the US with European browser settings\.$/);
});

test("display: facts from before the cookie check are not measured, never 'no tracking'", () => {
  assert.equal(cookieCheckView({ v: 4, resume: true }), null);
  assert.equal(cookieCheckView(null), null);
  assert.equal(cookieCheckView("not json"), null);
  assert.equal(cookieCheckView(JSON.stringify({ v: 4, privacy: { v: 99, readings: { US: { state: "none" } } } })), null);
  assert.equal(cookieCheckView(factsWith(read("none-plain")), "EU"), null, "no reading from that vantage");
  assert.equal(cookieReading(JSON.stringify(factsWith(read("none-plain")))).state, "none");
});
