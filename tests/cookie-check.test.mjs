// The cookie check's pure parts (pipeline/cookie-check.mjs, lib/cookie-check.mjs):
// each state and display kind from fixtures of what the browser saw on arrival
// (tests/fixtures/cookie-check/readings.json); only the site's own evidence
// (a first-party tracking cookie, a main-frame beacon) makes tracking; a
// script or configuration fetch is never tracking; embeds and ads are kept
// apart and never make a fix; consent tools count from the page's own code
// only; cookieless analytics are a note; cookie values are never kept;
// readings are kept by region; and the owner's display mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PRIVACY_VERSION,
  TRACKERS,
  captureRegion,
  classifyCookies,
  classifyRequests,
  deniedConsentPing,
  isBeacon,
  makeReading,
  originOf,
  siteOf,
  trackingCookie,
  trackingCookieVendor,
  withReading,
} from "../pipeline/cookie-check.mjs";
import { TITLES, cookieCheckView, cookieReading } from "../lib/cookie-check.mjs";
import { hasCookieCheck } from "../scripts/remeasure-shard.mjs";

const fixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", "cookie-check", "readings.json"), "utf8"));
const cases = Object.entries(fixtures).filter(([k]) => !k.startsWith("_"));
const AT = new Date("2026-11-25T12:00:00Z");
const read = (name, extra = {}) => makeReading({ ...fixtures[name], at: AT, ...extra });
const factsWith = (...readings) => ({ v: 4, resume: true, privacy: withReading(null, ...readings) });
const view = (name) => cookieCheckView(factsWith(read(name)));

for (const [name, fx] of cases) {
  test(`fixture ${name}: state ${fx.expect}, shown as ${fx.shown}`, () => {
    const r = read(name);
    assert.equal(r.state, fx.expect, JSON.stringify(r));
    assert.equal(r.region, "US");
    assert.equal(r.v, PRIVACY_VERSION);
    assert.equal(view(name).kind, fx.shown);
  });
}

test("every state and every display kind is covered by a fixture", () => {
  const states = new Set(cases.map(([, fx]) => fx.expect));
  for (const s of ["none", "after-consent", "with-banner", "no-consent", "unknown"]) assert.ok(states.has(s), s);
  const kinds = new Set(cases.map(([, fx]) => fx.shown));
  for (const k of ["none", "asks", "tool-no-banner", "sets-cookies", "tracks-without", "before-choice", "notice", "region-only", "embed", "widget", "ad", "not-measured"]) assert.ok(kinds.has(k), k);
});

test("a script or a configuration fetch is never tracking: loaders are kept apart", () => {
  const r = read("none-loaders-only");
  assert.equal(r.state, "none");
  assert.deepEqual(r.beacons, []);
  assert.deepEqual(
    r.loaders.map((l) => l.vendor).sort(),
    ["Amplitude", "Amplitude", "Google Tag Manager", "Hotjar", "LinkedIn", "Meta Pixel", "Microsoft Clarity", "Microsoft Clarity", "PostHog", "Segment", "Segment"].sort()
  );
});

test("beacons: the known beacon paths count, the same host's scripts do not", () => {
  const t = (host, p) => isBeacon(TRACKERS.filter((x) => host.endsWith(x.host) && (!x.path || x.path.test(p))).sort((a, b) => b.host.length - a.host.length)[0], p);
  // Verified against live sites on 2026-11-25 (pipeline/cookie-check.mjs TRACKERS).
  assert.equal(t("www.google-analytics.com", "/g/collect"), true);
  assert.equal(t("analytics.google.com", "/g/collect"), true);
  assert.equal(t("stats.g.doubleclick.net", "/g/collect"), true);
  assert.equal(t("b.clarity.ms", "/collect"), true);
  assert.equal(t("api.segment.io", "/v1/p"), true);
  assert.equal(t("www.facebook.com", "/tr/"), true);
  assert.equal(t("metrics.hotjar.io", "/v2/client/ping"), true);
  // Not verified live, by the vendors' documented paths.
  assert.equal(t("us.i.posthog.com", "/e/"), true);
  assert.equal(t("api2.amplitude.com", "/2/httpapi"), true);
  assert.equal(t("px.ads.linkedin.com", "/collect"), true);
  // Scripts and configuration.
  assert.equal(t("www.google-analytics.com", "/analytics.js"), false);
  assert.equal(t("www.googletagmanager.com", "/gtag/js"), false);
  assert.equal(t("scripts.clarity.ms", "/0.8.80/clarity.js"), false);
  assert.equal(t("www.clarity.ms", "/tag/abc"), false);
  assert.equal(t("cdn.segment.io", "/analytics.js/v1/abc/analytics.min.js"), false);
  assert.equal(t("cdn.segment.com", "/v1/projects/abc/settings"), false);
  assert.equal(t("connect.facebook.net", "/en_US/sdk.js"), false);
  assert.equal(t("sr-client-cfg.amplitude.com", "/config"), false);
  assert.equal(t("eu-assets.i.posthog.com", "/static/array.js"), false);
  assert.equal(t("eu-assets.i.posthog.com", "/array/phc_abc/config"), false);
});

test("cookieless analytics are recorded apart and never count as tracking", () => {
  const r = read("none-cookieless");
  assert.equal(r.state, "none");
  assert.deepEqual([...new Set(r.cookieless.map((c) => c.vendor))].sort(), ["Cloudflare Web Analytics", "GoatCounter", "Plausible", "Vercel Analytics"]);
  assert.equal(r.beacons.length, 0);
  assert.equal(r.own_cookies.length, 0);
  const v = view("none-cookieless");
  assert.equal(v.level, "pass");
  assert.equal(
    v.sentence,
    "On our visit on 25 Nov 2026 from the United States, no known tracker ran and no tracking cookie was set. Visits are counted with Plausible, Vercel Analytics, GoatCounter and Cloudflare Web Analytics, which set no cookies."
  );
});

test("a self-hosted cookieless script is seen by its address on the page", () => {
  const r = makeReading({ pageUrl: "https://me.example.dev/", requests: ["https://me.example.dev/"], dom: { tools: [], banner: null, scripts: ["https://me.example.dev/umami.js"] } });
  assert.equal(r.state, "none");
  assert.deepEqual(r.cookieless.map((c) => c.vendor), ["Umami"]);
});

test("frames: main, same-site, a blank frame a script made, and a third-party embed", () => {
  const site = "ana.dev";
  assert.deepEqual(originOf({ url: "x", frame: null }, site), { origin: "main", embed: null });
  assert.deepEqual(originOf({ url: "x", frame: "https://blog.ana.dev/" }, site), { origin: "same-site", embed: null });
  assert.deepEqual(originOf({ url: "x", frame: "" }, site), { origin: "same-site", embed: null });
  assert.deepEqual(originOf({ url: "x", frame: "https://www.youtube.com/embed/1" }, site), { origin: "embed", embed: "www.youtube.com" });
});

test("a page with only a Calendly inline frame reads no consent tool and no fix", () => {
  const r = read("calendly-embed-only");
  assert.equal(r.state, "none");
  assert.equal(r.tool, null, "OneTrust inside Calendly's frame is Calendly's, not the page's");
  assert.deepEqual(r.beacons, []);
  assert.equal(view("calendly-embed-only").level, "pass");
  // Calendly's own beacon is kept, with the embed named.
  assert.deepEqual(r.embeds.map((e) => [e.name, e.trackers]), [["Calendly", ["www.google-analytics.com x1"]]]);
});

test("a plain youtube.com embed is information, never a fix; youtube-nocookie stays clean", () => {
  const yt = read("youtube-embed");
  assert.equal(yt.state, "none");
  assert.deepEqual(yt.embeds.map((e) => [e.host, e.name, e.cookies.sort()]), [["www.youtube.com", "YouTube", ["VISITOR_INFO1_LIVE", "YSC", "test_cookie"]]]);
  assert.deepEqual(yt.ads, [], "doubleclick inside the player is YouTube's");
  const v = view("youtube-embed");
  assert.deepEqual([v.level, v.title], ["information", "Embeds YouTube, which sets its own cookies"]);
  assert.match(v.sentence, /youtube-nocookie\.com, YouTube's privacy-enhanced mode, or load it only when the visitor clicks it\./);
  assert.doesNotMatch(v.sentence, /cookieless|no cookies \(such as/);
  const nc = read("youtube-nocookie-embed");
  assert.equal(nc.state, "none");
  assert.deepEqual(nc.embeds, []);
  assert.equal(view("youtube-nocookie-embed").level, "pass");
});

test("only an ad network's cookie or request from the main frame is information, not a fix", () => {
  const r = read("ad-creative-only");
  assert.equal(r.state, "none");
  assert.deepEqual([...new Set(r.ads.map((a) => a.vendor))], ["Google Ads"]);
  assert.deepEqual(r.cookieless.map((c) => c.vendor), ["OpenPanel"]);
  const v = view("ad-creative-only");
  assert.deepEqual([v.level, v.title, v.recommendation], ["information", "Tracking seen from an ad on the page", null]);
});

test("consent mode's denied pings are not tracking", () => {
  const r = read("after-consent-tool");
  assert.equal(r.consent_mode_pings, 1);
  assert.deepEqual(r.beacons, []);
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G100"), true);
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G1-0"), true);
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G101"), false, "analytics granted");
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect?gcs=G110"), false, "ads granted");
  assert.equal(deniedConsentPing("https://www.google-analytics.com/g/collect"), false, "no consent mode");
});

test("unknown: the site's own tracking with a page that could not be read, and a reading that failed", () => {
  assert.match(read("unknown-dom-unreadable").reason, /could not be read/);
  const failed = makeReading({ error: "the cookies could not be read (Target closed)", at: AT });
  assert.equal(failed.state, "unknown");
  assert.match(failed.reason, /Target closed/);
});

test("cookie values are never kept, and cookies are first or third party by site", () => {
  const r = read("no-consent-cookies");
  assert.ok(!JSON.stringify(r).includes("GA1") && !JSON.stringify(r).includes("eyJ"), "no value");
  for (const c of r.cookies) assert.deepEqual(Object.keys(c).sort(), ["ad", "domain", "embed", "name", "party", "tracking"]);
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

test("a third-party cookie belongs to the embed on its site, or to the one embed that asked for its site", () => {
  const req = classifyRequests(
    [
      "https://a.dev/",
      "https://www.youtube.com/iframe_api",
      { url: "https://www.youtube.com/embed/1", frame: "https://www.youtube.com/embed/1" },
      { url: "https://googleads.g.doubleclick.net/pagead/id", frame: "https://www.youtube.com/embed/1" },
    ],
    "https://a.dev/"
  );
  const jar = classifyCookies(
    [
      { name: "YSC", domain: ".youtube.com" },
      { name: "test_cookie", domain: ".doubleclick.net" },
      { name: "MUID", domain: ".clarity.ms" },
    ],
    "https://a.dev/",
    req
  );
  assert.deepEqual(Object.fromEntries(jar.map((c) => [c.name, c.embed])), { YSC: "www.youtube.com", test_cookie: "www.youtube.com", MUID: null });
});

test("tracking cookies by name and by the network's own domain", () => {
  assert.equal(trackingCookieVendor({ name: "_gcl_au", domain: ".a.dev" }), "Google Ads");
  assert.equal(trackingCookieVendor({ name: "_fbp", domain: ".a.dev" }), "Meta Pixel");
  assert.equal(trackingCookieVendor({ name: "_clck", domain: ".a.dev" }), "Microsoft Clarity");
  assert.equal(trackingCookieVendor({ name: "li_sugr", domain: ".linkedin.com" }), "LinkedIn");
  assert.equal(trackingCookieVendor({ name: "_ttp", domain: ".a.dev" }), "TikTok");
  assert.equal(trackingCookieVendor({ name: "ajs_anonymous_id", domain: ".a.dev" }), "Segment");
  assert.equal(trackingCookieVendor({ name: "anything", domain: ".doubleclick.net" }), "Google Ads");
  assert.equal(trackingCookieVendor({ name: "VISITOR_INFO1_LIVE", domain: ".youtube.com" }), "YouTube");
  for (const name of ["__cf_bm", "cf_clearance", "session", "CookieConsent", "OptanonConsent", "theme", "_GRECAPTCHA"]) {
    assert.equal(trackingCookieVendor({ name, domain: ".a.dev" }), null, name);
  }
  // Server-side Google Tag Manager's first-party identifiers are the site's own analytics.
  assert.deepEqual(trackingCookie({ name: "FPID", domain: ".a.dev" }), { vendor: "Google Analytics", ads: false });
  assert.deepEqual(trackingCookie({ name: "FPLC", domain: ".a.dev" }), { vendor: "Google Analytics", ads: false });
  assert.equal(trackingCookieVendor({ name: "_hp5_meta.1", domain: ".a.dev" }), "Heap");
});

test("infrastructure cookies are never tracking, on any domain, a tracker's own included", () => {
  for (const domain of [".a.dev", ".linkedin.com", ".x.com", ".twitter.com", ".facebook.com", ".bing.com", ".clarity.ms", ".doubleclick.net"]) {
    for (const name of ["__cf_bm", "_cfuvid", "cf_clearance", "__cflb", "AWSALB", "AWSALBCORS", "JSESSIONID", "li_gc", "lang"]) {
      assert.equal(trackingCookie({ name, domain }), null, `${name} on ${domain}`);
    }
  }
});

test("the advertising list: an ad script's cookies are an ad's, on the site's own domain too; the analytics list stays the site's own", () => {
  for (const name of ["__gads", "__gpi", "__eoi", "_gcl_au", "_gcl_aw", "_uetsid", "_uetvid", "IDE", "test_cookie"]) {
    assert.equal(trackingCookie({ name, domain: ".a.dev" }).ads, true, name);
  }
  assert.equal(trackingCookie({ name: "MUID", domain: ".bing.com" }).ads, true);
  for (const name of ["_ga", "_gid", "_hjSessionUser_1", "_clck", "ajs_anonymous_id", "_fbp", "ph_phc_x_posthog", "FPID"]) {
    assert.equal(trackingCookie({ name, domain: ".a.dev" }).ads, false, name);
  }
  const r = read("adsense-first-party-cookies");
  assert.equal(r.state, "none");
  assert.deepEqual(r.own_cookies, []);
  assert.deepEqual(r.ads.filter((a) => a.cookie).map((a) => a.cookie).sort(), ["__eoi", "__gads", "__gpi", "_gcl_au"]);
  const v = view("adsense-first-party-cookies");
  assert.deepEqual([v.level, v.title], ["information", "Tracking seen from an ad on the page"]);
});

test("a LinkedIn badge's and an X timeline's tracking cookies are a widget's, and their bot-check cookies are not counted", () => {
  const lk = read("linkedin-badge");
  assert.deepEqual(lk.widgets.map((w) => w.cookie).sort(), ["bcookie", "lidc"]);
  assert.deepEqual(lk.ads, []);
  const lkv = view("linkedin-badge");
  assert.deepEqual([lkv.level, lkv.title], ["information", "Tracking cookies from a third-party widget (LinkedIn)"]);
  assert.doesNotMatch(lkv.sentence, /an ad/);
  const xt = read("x-timeline");
  assert.deepEqual(xt.widgets.map((w) => w.cookie).sort(), ["guest_id_marketing", "personalization_id"]);
  assert.equal(view("x-timeline").title, "Tracking cookies from a third-party widget (X (Twitter))");
});

test("loose banner: a decision button keeps tracking from 'without asking'; an OK alone is a notice; neither earns praise", () => {
  assert.equal(view("loose-banner-with-decision").title, "Tracks before you answer the banner");
  assert.deepEqual([view("loose-notice-ok-only").level, view("loose-notice-ok-only").title], ["information", "Tracks, and shows a cookie notice"]);
  assert.match(view("loose-notice-ok-only").sentence, /^On our visit on 25 Nov 2026 from the United States, Google Analytics tracked the visit, and a cookie notice \("Cookie notice: see our cookie policy\. OK"\) was shown without a choice to accept or decline\.$/);
  assert.equal(view("loose-notice-nothing-tracked").title, "No tracking cookies", "a loose notice never earns 'Asks before tracking'");
});

test("readings are kept by region: a new reading replaces its own, the others stay", () => {
  const us = read("no-consent-cookies");
  const eu = makeReading({ ...fixtures["none-plain"], region: "EU", at: AT });
  const stored = withReading(withReading(null, us), eu);
  assert.deepEqual(Object.keys(stored.readings).sort(), ["EU", "US"]);
  const again = withReading(stored, read("none-plain"));
  assert.equal(again.readings.US.state, "none");
  assert.equal(again.readings.EU.state, "none");
  assert.deepEqual(Object.keys(withReading({ v: 99, readings: { EU: eu } }, us).readings), ["US"], "a stored part of another version is not read");
  assert.equal(hasCookieCheck(JSON.stringify({ v: 4, privacy: again })), true);
  assert.equal(hasCookieCheck({ v: 4 }), false);
  assert.equal(hasCookieCheck(JSON.stringify({ v: 4, privacy: { v: 99, readings: { US: {} } } })), false);
  assert.equal(hasCookieCheck("not json"), false);
});

test("the region is the runner's, US unless CAPTURE_REGION says otherwise", () => {
  assert.equal(captureRegion({}), "US");
  assert.equal(captureRegion({ CAPTURE_REGION: "eu" }), "EU");
});

// The display mapping (owner, 2026-11-25, as revised after the review of #305): titles, levels and sentences.
const shown = (v) => ({ level: v.level, title: v.title, recommendation: v.recommendation });

test("display: pass, no tracking cookies, hedged", () => {
  assert.deepEqual(shown(view("none-plain")), { level: "pass", title: "No tracking cookies", recommendation: null });
  assert.equal(view("none-plain").sentence, "On our visit on 25 Nov 2026 from the United States, no known tracker ran and no tracking cookie was set.");
});

test("display: a banner shown and nothing tracked before a choice is information, 'Asks before tracking'", () => {
  assert.deepEqual(shown(view("after-consent-tool")), { level: "information", title: "Asks before tracking", recommendation: null });
  assert.equal(
    view("after-consent-tool").sentence,
    "On our visit on 25 Nov 2026 from the United States, a cookie banner (Cookiebot) was shown and no known tracker of the site's own ran before a choice."
  );
});

test("display: a consent tool, no banner, nothing tracked is information, never a fix", () => {
  assert.deepEqual(shown(view("tool-no-banner-nothing-tracked")), { level: "information", title: "Has a consent tool; banner not shown to a United States visitor", recommendation: null });
});

test("display: a first-party tracking cookie with no tool and no banner is a fix, 'Sets tracking cookies without asking'", () => {
  const v = view("no-consent-cookies");
  assert.deepEqual(shown(v), {
    level: "fix",
    title: "Sets tracking cookies without asking",
    recommendation: "Ask visitors before loading Google Analytics and Hotjar, or count visits with analytics that set no cookies (such as Plausible or Cloudflare Web Analytics).",
  });
  assert.equal(
    v.sentence,
    "On our visit on 25 Nov 2026 from the United States, Google Analytics and Hotjar set tracking cookies on the site's own domain, and no cookie banner or consent tool was found."
  );
});

test("display: a main-frame beacon without a tracking cookie is a fix, 'Tracks visitors without asking', its advice fitting a pixel", () => {
  const v = view("no-consent-beacon-only");
  assert.deepEqual(shown(v), { level: "fix", title: "Tracks visitors without asking", recommendation: "Ask visitors before loading Meta Pixel." });
  assert.match(v.sentence, /Meta Pixel tracked the visit from the page itself/);
});

test("display: a banner shown and the site's own tracking before a choice is a fix, 'Tracks before you answer the banner'", () => {
  for (const name of ["with-banner-tracker-fires-anyway", "with-banner-beacon-only"]) {
    assert.equal(view(name).title, "Tracks before you answer the banner", name);
    assert.equal(view(name).level, "fix", name);
  }
  assert.equal(view("with-banner-tracker-fires-anyway").recommendation, "Load Google Analytics only after the visitor accepts the cookie banner, not before they answer it.");
  assert.equal(
    view("with-banner-tracker-fires-anyway").sentence,
    "On our visit on 25 Nov 2026 from the United States, a cookie banner was shown, and Google Analytics started tracking before any choice was made."
  );
});

test("display: a consent tool with no banner shown and tracking is information, 'Tracks without asking visitors from the United States'", () => {
  const v = view("region-only-tool-tracks");
  assert.deepEqual(shown(v), { level: "information", title: "Tracks without asking visitors from the United States", recommendation: null });
  assert.match(v.sentence, /OneTrust is in the page's code and may ask visitors from other regions\.$/);
});

test("display: an embed's or an ad's tracking beside a fix comes back as notes", () => {
  const r = makeReading({
    ...fixtures["youtube-embed"],
    cookies: [...fixtures["youtube-embed"].cookies, { name: "_ga", domain: ".yt.example.me" }],
    requests: [...fixtures["youtube-embed"].requests, "https://www.google-analytics.com/g/collect?v=2"],
    at: AT,
  });
  const v = cookieCheckView(factsWith(r));
  assert.equal(v.title, TITLES.setsCookies);
  assert.deepEqual(v.notes.map((n) => n.title), ["Embeds YouTube, which sets its own cookies"]);
});

test("display: old captures and failed readings are not measured, never 'no tracking'", () => {
  const notMeasured = (v) => [v.level, v.title, v.recommendation];
  const expected = ["not-measured", "Not measured", null];
  assert.deepEqual(notMeasured(cookieCheckView({ v: 4, resume: true })), expected, "facts from before the cookie check");
  assert.deepEqual(notMeasured(cookieCheckView(null)), expected);
  assert.deepEqual(notMeasured(cookieCheckView("not json")), expected);
  assert.deepEqual(notMeasured(cookieCheckView(JSON.stringify({ v: 4, privacy: { v: 99, readings: { US: { state: "none" } } } }))), expected, "another version");
  assert.deepEqual(notMeasured(cookieCheckView(factsWith(read("none-plain")), "EU")), expected, "no reading from that region");
  assert.deepEqual(notMeasured(view("unknown-dom-unreadable")), expected, "a reading that could not tell");
  assert.deepEqual(notMeasured(cookieCheckView(factsWith(makeReading({ error: "the cookies could not be read (Target closed)", at: AT })))), expected, "a failed reading");
  assert.equal(cookieReading(JSON.stringify(factsWith(read("none-plain")))).state, "none");
});

test("display: a recommendation exactly for a fix, and a fix only from the site's own evidence", () => {
  for (const [name] of cases) {
    const v = view(name);
    assert.equal(v.level === "fix", v.recommendation != null, `${name}: a recommendation exactly for a fix`);
    if (v.level === "fix") {
      const r = read(name);
      assert.ok(r.own_cookies.length > 0 || r.beacons.length > 0, `${name}: a fix needs the site's own evidence`);
    }
    assert.ok(v.level === "not-measured" || v.sentence.startsWith("On our visit on 25 Nov 2026 from the United States"), `${name}: stated as an observation`);
  }
});
