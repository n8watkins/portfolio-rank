// The cookie check (owner, 2026-11-25): whether a site sets tracking cookies,
// and whether it asks permission first. In his words: "tracking cookies itself
// is not something to fix, tracking cookies and not asking for permission to
// track cookies is something to fix." Plain observed facts, measured by code
// during the capture's own visit (pipeline/capture.mjs), before the capture
// clicks or dismisses anything: no score, no AI, no legal verdict.
//
// What is read, once the page has loaded and settled (and once more, 2
// seconds later, when tracking was seen and no banner yet: a banner that
// slides in late):
//   - the cookies in the browser (name, domain, first or third party, and
//     whether each is a known tracking cookie: TRACKING_COOKIES, or any cookie
//     an advertising or tracking network sets from its own domain,
//     TRACKER_HOSTS). Cookie values are never read into the result.
//   - the requests made so far to known tracker hosts (TRACKER_HOSTS), by host
//     and count. A tag manager's or pixel's script alone (its `loader` paths:
//     gtm.js, gtag/js, fbevents.js) is recorded apart as `loaders` and does not
//     count as tracking: a consent tool can hold the tags it loads, and what
//     they do shows as a cookie or a beacon. Google's consent-mode pings sent
//     with both storages denied (gcs=G100) are counted apart too.
//   - cookieless analytics (COOKIELESS_ANALYTICS: Plausible, Fathom, Simple
//     Analytics, Umami, Cloudflare Web Analytics, Vercel Analytics,
//     GoatCounter, Pirsch, Tinylytics): recorded as `cookieless`, never as
//     tracking. They set no cookies and keep no identifier on the device.
//   - a consent banner: a known consent tool (CONSENT_TOOLS) from its script
//     hosts and its page markers, and a generic banner (findConsent): a
//     visible element that is fixed, sticky, a dialog, or named cookie or
//     consent, holds under 1,500 characters, says cookies, consent, GDPR or
//     privacy choices, and has a short choice button (Accept, Agree, Allow,
//     Reject, Decline, OK, Got it, Manage, Preferences). The false-positive
//     guard: the wording and a choice button must both be in that one small
//     element, so a blog post about cookies, a "Cookie Clicker" project card or
//     a cookie policy link in a footer is not a banner.
//
// The state (stateOf):
//   none           no tracking cookie and no tracking request;
//   after-consent  a banner is shown and nothing tracked the visit before a choice;
//   with-banner    a banner is shown but tracking started before any choice (a fix);
//   no-consent     tracking started and no banner was shown (a fix);
//   unknown        the capture could not tell, with the reason.
//
// Each reading records where it was made from: `region`, the capture
// runner's network address (CAPTURE_REGION, "US" by default: GitHub's
// runners), and `vantage`, its key in facts.privacy.readings with a plain
// `label`. The plain reading's vantage is the region ("US"). When it saw a
// consent tool or a tracker, the capture makes a second reading in a fresh
// browser context of its own with European browser settings (EU_SETTINGS:
// Europe/Paris time zone, fr-FR, a Paris location) from the same address,
// vantage "US+eu-browser", labelled "address in US, European browser
// settings": most consent tools decide by network address and are not fooled
// by it, so it only catches the minority that decide in the browser, and it
// is never called a reading from Europe. A capture keeps the readings of
// other vantages it finds (withReading), so a reading from a runner in Europe
// ("EU") can sit beside them later with no change to the shape. Many consent
// tools show their banner only to visitors in some regions, so a US reading
// of a site that asks Europeans can be no-consent: that is what a US visitor met.
//
// The lists are fixed and written out here, so a reading is repeatable and a
// reviewer can see why a cookie or host counted. They hold the well-known
// analytics, advertising, session-recording and social pixels; a tracker not
// on them is not seen (a false negative, never a false positive).

/** The shape of facts.privacy; a reader of another version treats it as not measured. */
export const PRIVACY_VERSION = 1;
/** Where the capture runs, unless CAPTURE_REGION says otherwise. */
export const DEFAULT_REGION = "US";
export const STATES = ["none", "after-consent", "with-banner", "no-consent", "unknown"];
/** At most this many cookies and hosts are stored per reading (the counts are kept whole). */
export const MAX_LISTED = 40;
/** How long a reading waits once more for a late banner, when it saw tracking and no banner. */
export const LATE_BANNER_MS = 2000;

/** The region a reading is made from: CAPTURE_REGION, else DEFAULT_REGION. */
export const captureRegion = (env = process.env) => String(env.CAPTURE_REGION ?? "").trim().toUpperCase() || DEFAULT_REGION;

/**
 * Known tracking cookies by name: [pattern, vendor]. A cookie is a tracking
 * cookie when its name matches one of these, wherever it is set (Google
 * Analytics' _ga is a first-party cookie the site's own page writes).
 */
export const TRACKING_COOKIES = [
  [/^_ga(_[A-Z0-9]+)?$/, "Google Analytics"],
  [/^_gid$/, "Google Analytics"],
  [/^_gat(_.+)?$/, "Google Analytics"],
  [/^__utm[abcztv]$/, "Google Analytics"],
  [/^_gcl_/, "Google Ads"],
  [/^(IDE|DSID|test_cookie|__gads|__gpi|__eoi)$/, "Google Ads"],
  [/^_fb[pc]$/, "Meta Pixel"],
  [/^_hj/, "Hotjar"],
  [/^_cl(ck|sk)$/, "Microsoft Clarity"],
  [/^_uet(sid|vid)$/, "Microsoft Advertising"],
  [/^(li_fat_id|li_sugr|bcookie|lidc|UserMatchHistory|AnalyticsSyncHistory|ln_or|_li_ss)$/, "LinkedIn"],
  [/^(_ttp|_tt_enable_cookie|ttcsid(_.+)?)$/, "TikTok"],
  [/^(_pin_unauth|_pinterest_ct_ua|_epik)$/, "Pinterest"],
  [/^(_scid|_sctr|_scid_r)$/, "Snapchat"],
  [/^(personalization_id|muc_ads|guest_id_ads|guest_id_marketing)$/, "X (Twitter)"],
  [/^(__hstc|hubspotutk|__hssc|__hssrc)$/, "HubSpot"],
  [/^mp_.+_mixpanel$/, "Mixpanel"],
  [/^(AMP_.+|amp_.+)$/, "Amplitude"],
  [/^ajs_(anonymous|user)_id$/, "Segment"],
  [/^ph_.+_posthog$/, "PostHog"],
  [/^(_ym_uid|_ym_d|_ym_isad|yandexuid)$/, "Yandex Metrica"],
  [/^_hp2_/, "Heap"],
  [/^fs_uid$/, "FullStory"],
  [/^_pk_(id|ses|ref)/, "Matomo"],
  [/^_ce\.(s|clock_data|gtld)$/, "Crazy Egg"],
  [/^(VISITOR_INFO1_LIVE|VISITOR_PRIVACY_METADATA|YSC|__Secure-YEC|__Secure-ROLLOUT_TOKEN)$/, "YouTube"],
  [/^_vwo_/, "VWO"],
  [/^_mkto_trk$/, "Marketo"],
  [/^_rdt_uuid$/, "Reddit"],
  [/^_lfa$/, "Leadfeeder"],
];

/**
 * Known tracker hosts: { host, vendor, loader? }. A request to the host or a
 * subdomain counts as tracking unless its path matches `loader` (the
 * script that loads the tag, recorded apart), and a cookie set from the
 * host's own domain is a tracking cookie. `path` limits the host to those
 * paths (facebook.com's pixel, google.com's ad pings).
 */
export const TRACKER_HOSTS = [
  { host: "google-analytics.com", vendor: "Google Analytics", loader: /\/analytics\.js$|\/ga\.js$/ },
  { host: "analytics.google.com", vendor: "Google Analytics" },
  { host: "googletagmanager.com", vendor: "Google Tag Manager", loader: /^\/(gtm\.js|gtag\/js|gtag\/destination|static\/)/ },
  { host: "doubleclick.net", vendor: "Google Ads" },
  { host: "googleadservices.com", vendor: "Google Ads", loader: /\/conversion(_async)?\.js$/ },
  { host: "googlesyndication.com", vendor: "Google Ads", loader: /\.js$/ },
  { host: "google.com", vendor: "Google Ads", path: /^\/(pagead|ads\/|ccm\/collect|rmkt\/)/ },
  { host: "connect.facebook.net", vendor: "Meta Pixel", loader: /fbevents\.js$|\/signals\/(config|plugins)\// },
  { host: "facebook.com", vendor: "Meta Pixel", path: /^\/tr\/?$/ },
  { host: "hotjar.com", vendor: "Hotjar", loader: /^\/c\/hotjar-[\w-]+\.js$|^\/modules\./ },
  { host: "hotjar.io", vendor: "Hotjar" },
  { host: "clarity.ms", vendor: "Microsoft Clarity", loader: /^\/(tag|s)\// },
  { host: "bat.bing.com", vendor: "Microsoft Advertising", loader: /\/bat\.js$/ },
  { host: "snap.licdn.com", vendor: "LinkedIn", loader: /insight(\.min)?\.js$/ },
  { host: "px.ads.linkedin.com", vendor: "LinkedIn" },
  { host: "ads.linkedin.com", vendor: "LinkedIn" },
  { host: "analytics.tiktok.com", vendor: "TikTok", loader: /\/(events|main\.[\w.]+)\.js$/ },
  { host: "static.ads-twitter.com", vendor: "X (Twitter)", loader: /\.js$/ },
  { host: "analytics.twitter.com", vendor: "X (Twitter)" },
  { host: "ads-api.twitter.com", vendor: "X (Twitter)" },
  { host: "ct.pinterest.com", vendor: "Pinterest" },
  { host: "tr.snapchat.com", vendor: "Snapchat" },
  { host: "sc-static.net", vendor: "Snapchat", loader: /\.js$/ },
  { host: "js.hs-scripts.com", vendor: "HubSpot", loader: /\.js$/ },
  { host: "js.hs-analytics.net", vendor: "HubSpot", loader: /\.js$/ },
  { host: "track.hubspot.com", vendor: "HubSpot" },
  { host: "mixpanel.com", vendor: "Mixpanel" },
  { host: "mxpnl.com", vendor: "Mixpanel", loader: /\.js$/ },
  { host: "amplitude.com", vendor: "Amplitude", loader: /\.js$/ },
  { host: "segment.io", vendor: "Segment" },
  { host: "segment.com", vendor: "Segment", loader: /\.js$/ },
  { host: "posthog.com", vendor: "PostHog", loader: /\/static\/|\/array\// },
  { host: "mc.yandex.ru", vendor: "Yandex Metrica", loader: /\/metrika\/|\.js$/ },
  { host: "mc.yandex.com", vendor: "Yandex Metrica", loader: /\/metrika\/|\.js$/ },
  { host: "heapanalytics.com", vendor: "Heap", loader: /\.js$/ },
  { host: "fullstory.com", vendor: "FullStory", loader: /\/s\/fs\.js$/ },
  { host: "crazyegg.com", vendor: "Crazy Egg", loader: /\.js$/ },
  { host: "matomo.cloud", vendor: "Matomo", loader: /\.js$/ },
  { host: "quantserve.com", vendor: "Quantcast" },
  { host: "scorecardresearch.com", vendor: "Comscore" },
  { host: "criteo.com", vendor: "Criteo" },
  { host: "criteo.net", vendor: "Criteo" },
  { host: "adnxs.com", vendor: "Xandr" },
  { host: "taboola.com", vendor: "Taboola" },
  { host: "outbrain.com", vendor: "Outbrain" },
  { host: "visualwebsiteoptimizer.com", vendor: "VWO", loader: /\.js$/ },
  { host: "redditstatic.com", vendor: "Reddit", loader: /\.js$/ },
  { host: "alb.reddit.com", vendor: "Reddit" },
  { host: "mouseflow.com", vendor: "Mouseflow" },
  { host: "smartlook.com", vendor: "Smartlook" },
  { host: "luckyorange.com", vendor: "Lucky Orange" },
  { host: "leadfeeder.com", vendor: "Leadfeeder" },
  { host: "lfeeder.com", vendor: "Leadfeeder" },
];

/**
 * Domains whose own cookies are tracking cookies though nothing is counted
 * from their requests: an embedded YouTube video sets YouTube's visitor
 * cookies (youtube-nocookie.com sets none). Their requests are not tracker
 * requests (the video is content), only their cookies count.
 */
export const TRACKING_COOKIE_DOMAINS = [{ host: "youtube.com", vendor: "YouTube" }];

/**
 * Privacy-friendly analytics that set no cookies and keep no identifier on
 * the device: { host?, path?, script?, vendor }. Never tracking. `script`
 * matches a script's address on the page (a self-hosted or proxied copy).
 */
export const COOKIELESS_ANALYTICS = [
  { host: "plausible.io", vendor: "Plausible" },
  { host: "usefathom.com", vendor: "Fathom" },
  { host: "simpleanalyticscdn.com", vendor: "Simple Analytics" },
  { host: "simpleanalytics.com", vendor: "Simple Analytics" },
  { host: "umami.is", vendor: "Umami" },
  { host: "cloudflareinsights.com", vendor: "Cloudflare Web Analytics" },
  { host: "va.vercel-scripts.com", vendor: "Vercel Analytics" },
  { path: /^\/_vercel\/insights\//, vendor: "Vercel Analytics" },
  { host: "goatcounter.com", vendor: "GoatCounter" },
  { host: "gc.zgo.at", vendor: "GoatCounter" },
  { host: "pirsch.io", vendor: "Pirsch" },
  { host: "tinylytics.app", vendor: "Tinylytics" },
  { host: "counter.dev", vendor: "Counter.dev" },
  { script: /\/umami(\.js)?(\?|$)|umami.*\/script\.js/i, vendor: "Umami" },
  { script: /plausible/i, vendor: "Plausible" },
];

/**
 * Consent tools: { name, hosts, selector }. `hosts` are where their script
 * comes from; `selector` is the element of their banner on the page.
 */
export const CONSENT_TOOLS = [
  { name: "Cookiebot", hosts: ["cookiebot.com", "cookiebot.eu"], selector: "#CybotCookiebotDialog" },
  { name: "OneTrust", hosts: ["cookielaw.org", "onetrust.com"], selector: "#onetrust-banner-sdk, #onetrust-consent-sdk .ot-sdk-container, #onetrust-pc-sdk" },
  { name: "Osano", hosts: ["osano.com"], selector: ".osano-cm-window, .osano-cm-dialog" },
  { name: "CookieYes", hosts: ["cookieyes.com", "cdn-cookieyes.com"], selector: ".cky-consent-container, #cookie-law-info-bar, .cky-modal" },
  { name: "Klaro", hosts: ["kiprotect.com", "klaro.org"], selector: ".klaro .cookie-notice, .klaro .cookie-modal, #klaro .cookie-notice" },
  { name: "Complianz", hosts: [], selector: "#cmplz-cookiebanner-container .cmplz-cookiebanner, .cmplz-cookiebanner" },
  { name: "iubenda", hosts: ["iubenda.com"], selector: "#iubenda-cs-banner" },
  { name: "Termly", hosts: ["termly.io"], selector: "[class*=termly-styles-root], #termly-code-snippet-support [role=dialog]" },
  { name: "Usercentrics", hosts: ["usercentrics.eu", "usercentrics.com"], selector: "#usercentrics-root, #usercentrics-cmp-ui, #uc-banner" },
  { name: "Didomi", hosts: ["privacy-center.org", "didomi.io"], selector: "#didomi-host .didomi-popup-container, #didomi-notice" },
  { name: "Quantcast Choice", hosts: ["quantcast.mgr.consensu.org", "cmp.quantcast.com"], selector: ".qc-cmp2-container" },
  { name: "TrustArc", hosts: ["trustarc.com", "truste.com"], selector: "#truste-consent-track, #consent_blackbar" },
  { name: "CookieFirst", hosts: ["cookiefirst.com"], selector: ".cookiefirst-root" },
  { name: "Cookie Script", hosts: ["cookie-script.com"], selector: "#cookiescript_injected" },
  { name: "Borlabs Cookie", hosts: [], selector: "#BorlabsCookieBox ._brlbs-bar, #BorlabsCookieBox ._brlbs-box" },
  { name: "Google consent message", hosts: ["fundingchoicesmessages.google.com"], selector: ".fc-consent-root" },
  { name: "Sourcepoint", hosts: ["sourcepoint.com", "privacy-mgmt.com"], selector: "[id^=sp_message_container]" },
  { name: "Silktide", hosts: ["silktide.com"], selector: "#silktide-wrapper, #stcm-wrapper" },
  { name: "Termageddon", hosts: ["termageddon.com"], selector: "#usercentrics-root" },
  // The open-source banners: Osano's cookieconsent (cc-window) and orestbida's vanilla-cookieconsent (#cc-main, #cm).
  { name: "cookieconsent", hosts: [], selector: ".cc-window, #cc-main .cm, #cc--main #cm" },
];

const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};
const pathOf = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return "";
  }
};
/** Whether `host` is `domain` or a subdomain of it. */
export const onHost = (host, domain) => {
  const h = String(host ?? "").toLowerCase().replace(/^\./, "");
  return h === domain || h.endsWith(`.${domain}`);
};

// Hosts that give each customer a site of its own under them (public
// suffixes): two sites on github.io are different sites, so the registrable
// part is one label more. Only the ones portfolios use; others fall back to
// the last two labels (three under a two-letter country code's co, com, org...).
const SHARED_HOSTS = [
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com",
  "herokuapp.com", "onrender.com", "fly.dev", "railway.app", "up.railway.app", "glitch.me", "surge.sh",
  "framer.website", "framer.app", "framer.ai", "webflow.io", "wixsite.com", "carrd.co", "notion.site",
  "replit.app", "repl.co", "is-a.dev", "bearblog.dev", "neocities.org", "codeberg.page", "azurewebsites.net",
  "amplifyapp.com", "deno.dev", "blogspot.com", "wordpress.com", "squarespace.com", "super.site", "bio.link",
];

/** The registrable part of a host ("www.ana.dev" → "ana.dev", "ana.github.io" stays), for first or third party. */
export function siteOf(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (!h) return "";
  const shared = SHARED_HOSTS.filter((s) => h.endsWith(`.${s}`)).sort((a, b) => b.length - a.length)[0];
  const labels = h.split(".");
  if (shared) return labels.slice(-(shared.split(".").length + 1)).join(".");
  if (/^\d+(\.\d+){3}$/.test(h)) return h;
  const [sld, tld] = labels.slice(-2);
  if (labels.length >= 3 && tld?.length === 2 && /^(co|com|org|net|ac|gov|edu|ne|or|go)$/.test(sld)) return labels.slice(-3).join(".");
  return labels.slice(-2).join(".");
}

const trackerFor = (host, path) => TRACKER_HOSTS.find((t) => onHost(host, t.host) && (!t.path || t.path.test(path)));
const cookielessFor = (host, path) => COOKIELESS_ANALYTICS.find((c) => (c.host ? onHost(host, c.host) : c.path ? c.path.test(path) : false));

/** The vendor of a tracking cookie, or null: by its name, else by the tracker domain that set it. */
export function trackingCookieVendor({ name, domain }) {
  const byName = TRACKING_COOKIES.find(([re]) => re.test(String(name ?? "")));
  if (byName) return byName[1];
  const byDomain = [...TRACKER_HOSTS, ...TRACKING_COOKIE_DOMAINS].find((t) => !t.path && onHost(domain, t.host));
  return byDomain ? byDomain.vendor : null;
}

/**
 * Google's consent mode: a ping sent while analytics storage is denied and
 * ad storage is not granted (gcs=G100 or G1-0: version 1, then ad_storage and
 * analytics_storage, 1 granted, 0 denied, - not set). It sets no cookie and
 * carries no identifier, so it is counted apart, not as tracking.
 */
export function deniedConsentPing(url) {
  try {
    return /^G1[0-]0$/.test(new URL(url).searchParams.get("gcs") ?? "");
  } catch {
    return false;
  }
}

/** Adds one to `host`'s count in `map` (host → { host, vendor, requests }). */
const tally = (map, host, vendor) => {
  const row = map.get(host) ?? { host, vendor, requests: 0 };
  row.requests++;
  map.set(host, row);
};
const listed = (map) => [...map.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host)).slice(0, MAX_LISTED);
const vendorsOf = (rows) => [...new Set(rows.map((r) => r.vendor).filter(Boolean))];

/**
 * The requests' part of a reading (pure): `urls`, every request the page made
 * before the reading, in order. Returns { trackers, loaders, cookieless,
 * consentHosts, consentPings }: the first three as [{ host, vendor, requests }].
 */
export function classifyRequests(urls) {
  const trackers = new Map();
  const loaders = new Map();
  const cookieless = new Map();
  const consentHosts = new Set();
  let consentPings = 0;
  for (const u of urls ?? []) {
    const host = hostOf(u);
    if (!host) continue;
    const path = pathOf(u);
    const tool = CONSENT_TOOLS.find((c) => c.hosts.some((h) => onHost(host, h)));
    if (tool) consentHosts.add(tool.name);
    const free = cookielessFor(host, path);
    if (free) {
      tally(cookieless, host, free.vendor);
      continue;
    }
    const t = trackerFor(host, path);
    if (!t) continue;
    if (t.loader?.test(path)) tally(loaders, host, t.vendor);
    else if (deniedConsentPing(u)) consentPings++;
    else tally(trackers, host, t.vendor);
  }
  return { trackers: listed(trackers), loaders: listed(loaders), cookieless: listed(cookieless), consentHosts: [...consentHosts], consentPings };
}

/**
 * The cookies' part of a reading (pure): each cookie's name, domain, party
 * (against the page's address `pageUrl`) and tracking vendor (null when it is
 * not a known tracking cookie). Values are never kept, whatever is passed in.
 */
export function classifyCookies(cookies, pageUrl) {
  const site = siteOf(hostOf(pageUrl));
  const rows = [];
  for (const c of cookies ?? []) {
    const name = String(c?.name ?? "");
    const domain = String(c?.domain ?? "").toLowerCase();
    if (!name) continue;
    const party = site && siteOf(domain) === site ? "first" : "third";
    rows.push({ name, domain, party, tracking: trackingCookieVendor({ name, domain }) });
  }
  // Tracking cookies first, then by domain and name, so the stored list keeps what matters when it is cut.
  rows.sort((a, b) => Number(Boolean(b.tracking)) - Number(Boolean(a.tracking)) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * One reading (pure), from what the browser saw before any click:
 *   pageUrl   the page's address at the reading;
 *   cookies   the browser's cookies ({ name, domain }; values are dropped);
 *   requests  the addresses of every request so far;
 *   dom       findConsent's answer ({ tools, banner, generic, scripts }), or
 *             null when the page could not be read;
 *   error     why the reading could not be made, if it could not;
 *   region, at.
 * Returns the stored reading: { region, at, state, reason, banner, tool,
 * tracking_cookies, cookies, cookie_count, trackers, loaders, cookieless,
 * consent_mode_pings, vendors }.
 */
export function makeReading({ pageUrl = "", cookies = [], requests = [], dom = null, error = null, region = DEFAULT_REGION, vantage = null, at = new Date() }) {
  const v = vantageOf(region, vantage);
  const base = { v: PRIVACY_VERSION, region, vantage: v.key, label: v.label, at: (at instanceof Date ? at : new Date(at)).toISOString() };
  if (error) return { ...base, state: "unknown", reason: String(error).slice(0, 200) };
  const jar = classifyCookies(cookies, pageUrl);
  const req = classifyRequests(requests);
  // A cookieless tool loaded from the site itself (a proxied Plausible, a self-hosted Umami): seen by its script.
  const cookieless = [...req.cookieless];
  for (const s of dom?.scripts ?? []) {
    const hit = COOKIELESS_ANALYTICS.find((c) => c.script?.test(s));
    if (hit && !cookieless.some((r) => r.vendor === hit.vendor)) cookieless.push({ host: hostOf(s) || siteOf(hostOf(pageUrl)), vendor: hit.vendor, requests: 0 });
  }
  const trackingCookies = jar.filter((c) => c.tracking);
  const tool = dom?.tools?.find((t) => t.shown)?.name ?? dom?.tools?.[0]?.name ?? req.consentHosts[0] ?? null;
  const banner = dom ? Boolean(dom.banner) : null;
  const tracked = trackingCookies.length > 0 || req.trackers.length > 0;
  const vendors = vendorsOf([...trackingCookies.map((c) => ({ vendor: c.tracking })), ...req.trackers]);
  let state;
  let reason = null;
  if (!tracked) state = banner ? "after-consent" : "none";
  else if (banner === null) {
    state = "unknown";
    reason = "tracking started, but the page could not be read to tell whether a consent banner was shown";
  } else state = banner ? "with-banner" : "no-consent";
  // A consent tool that loaded but showed no banner here: many show it only to visitors from some regions.
  if (state === "no-consent" && tool) reason = `${tool} loaded but showed no banner to this visit (from ${region})`;
  return {
    ...base,
    state,
    reason,
    banner,
    tool,
    banner_how: dom?.banner ?? null,
    vendors,
    tracking_cookies: trackingCookies.length,
    cookie_count: jar.length,
    cookies: jar.slice(0, MAX_LISTED),
    trackers: req.trackers,
    loaders: req.loaders,
    cookieless,
    consent_mode_pings: req.consentPings,
  };
}

/**
 * In the browser: the consent banner, if one is shown. Returns { tools,
 * banner, sample, scripts }: `tools` the known consent tools whose banner
 * element is on the page ({ name, shown }); `banner` how a shown banner was
 * recognised ("tool", "frame" for a consent tool's visible frame, "generic"),
 * or null when none is shown; `sample` the first words of a generic banner,
 * for the reviewer; `scripts` the page's script addresses (for cookieless
 * analytics served from the site itself). Pure DOM reading: nothing is
 * clicked or changed.
 */
export function findConsent([tools, frameHosts]) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) >= 0.05;
  };
  // An element or anything inside it (its shadow root too: Usercentrics draws there) that is visible.
  const shownDeep = (el) => {
    if (visible(el)) return true;
    const inner = [...el.querySelectorAll("*"), ...(el.shadowRoot ? el.shadowRoot.querySelectorAll("*") : [])];
    return inner.slice(0, 800).some((c) => visible(c) && (c.innerText ?? c.textContent ?? "").trim().length > 0);
  };
  const found = [];
  let banner = null;
  for (const [name, selector] of tools) {
    let els = [];
    try {
      els = [...document.querySelectorAll(selector)];
    } catch {
      continue;
    }
    if (!els.length) continue;
    const shown = els.some(shownDeep);
    found.push({ name, shown });
    if (shown) banner ??= "tool";
  }
  // A consent tool's banner in a frame of its own (Sourcepoint, Quantcast, Google's message).
  if (!banner) {
    for (const f of document.querySelectorAll("iframe")) {
      let host = "";
      try {
        host = new URL(f.src, location.href).hostname;
      } catch {
        continue;
      }
      if (frameHosts.some((h) => host === h || host.endsWith(`.${h}`)) && visible(f)) {
        banner = "frame";
        break;
      }
    }
  }
  // The generic banner. Wording and a choice button must both be in one small element.
  const WORDING = /\b(cookies?|consent|gdpr|ccpa)\b|privacy (settings|preferences|choices)|do not sell/i;
  const CHOICE = /^(?:[^\w]*)(accept|agree|allow|reject|decline|deny|refuse|got it|ok(ay)?|understood|i understand|necessary|essential|manage|preferences|customi[sz]e|opt[ -]?out|only (necessary|essential))\b/i;
  const NAMED = /cookie|consent|gdpr|\bcmp\b/i;
  let sample = null;
  if (!banner) {
    const pinned = (el) => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const p = getComputedStyle(e).position;
        if (p === "fixed" || p === "sticky") return true;
      }
      return false;
    };
    const candidates = new Set(document.querySelectorAll("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open], [role=region][aria-label]"));
    for (const el of document.querySelectorAll("[id], [class]")) {
      const name = `${el.id ?? ""} ${typeof el.className === "string" ? el.className : ""}`;
      if (NAMED.test(name)) candidates.add(el);
    }
    let n = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (++n > 6000) break;
      const p = getComputedStyle(el).position;
      if (p === "fixed" || p === "sticky") candidates.add(el);
    }
    for (const el of candidates) {
      if (!el.isConnected || !visible(el)) continue;
      const text = (el.innerText ?? "").trim();
      if (!text || text.length > 1500 || !WORDING.test(text)) continue;
      // Named cookie or consent, or pinned on the screen (fixed, sticky) or a dialog: not a section of the page.
      const named = NAMED.test(`${el.id ?? ""} ${typeof el.className === "string" ? el.className : ""}`);
      if (!named && !pinned(el) && !el.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]")) continue;
      const controls = [...el.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].filter(visible);
      const choice = controls.find((b) => {
        const label = (b.innerText || b.value || b.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
        return label.length > 0 && label.length <= 40 && CHOICE.test(label);
      });
      if (!choice) continue;
      banner = "generic";
      sample = text.replace(/\s+/g, " ").slice(0, 160);
      break;
    }
  }
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 200);
  return { tools: found, banner, sample, scripts };
}

/** The arguments findConsent is evaluated with: the tools' banner selectors, and the hosts of their frames. */
export const consentArgs = () => [CONSENT_TOOLS.map((t) => [t.name, t.selector]), CONSENT_TOOLS.flatMap((t) => t.hosts)];

/**
 * Starts listening to a page's requests (pipeline/capture.mjs, before the
 * first navigation): every address is kept, in order, until `stop()`. The
 * reading takes what came before it.
 * @param {import("playwright").Page} page
 */
export function watchRequests(page) {
  const urls = [];
  let on = true;
  const onRequest = (req) => {
    if (on && urls.length < 5000) urls.push(req.url());
  };
  page.on("request", onRequest);
  return {
    urls,
    stop() {
      on = false;
      page.off?.("request", onRequest);
    },
  };
}

/**
 * The reading on a capture's page as it now is, before anything is clicked
 * (makeReading on the browser's cookies, the requests so far and the page's
 * banner). When tracking was seen and no banner, it looks once more after
 * LATE_BANNER_MS, for a banner that slides in late. Never throws: a page that
 * cannot be read gives an `unknown` reading with the reason.
 * @param {import("playwright").Page} page
 * @param {{ urls: string[] }} watch watchRequests's
 */
export async function readCookieCheck(page, watch, { region = captureRegion(), vantage = null, lateMs = LATE_BANNER_MS } = {}) {
  const once = async () => {
    try {
      const cookies = (await page.context().cookies()).map(({ name, domain }) => ({ name, domain }));
      const dom = await page.evaluate(findConsent, consentArgs()).catch(() => null);
      return makeReading({ pageUrl: page.url(), cookies, requests: [...watch.urls], dom, region, vantage });
    } catch (e) {
      return makeReading({ error: `the cookies could not be read (${String(e?.message ?? e).slice(0, 120)})`, region, vantage });
    }
  };
  const first = await once();
  if (first.state !== "no-consent" || lateMs <= 0) return first;
  await page.waitForTimeout(lateMs).catch(() => {});
  return once();
}

/**
 * The second vantage: the same network address with a European browser (time
 * zone Europe/Paris, language fr-FR, a Paris location for a page that asks).
 * Most consent tools decide by the visitor's network address and are not
 * fooled by it; this only catches the minority that decide in the browser
 * (by time zone or language). So it is labelled for what it is, never as a
 * reading from Europe.
 */
export const EU_SETTINGS = {
  suffix: "eu-browser",
  label: "address in {region}, European browser settings (Europe/Paris, fr-FR)",
  context: {
    timezoneId: "Europe/Paris",
    locale: "fr-FR",
    geolocation: { latitude: 48.8566, longitude: 2.3522 },
    permissions: ["geolocation"],
    extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5" },
  },
};

/** A reading's vantage: its key in facts.privacy.readings and its label. The plain one is the region itself. */
export function vantageOf(region, vantage = null) {
  if (!vantage) return { key: region, label: `address in ${region}, browser in its default settings (en-US)` };
  return { key: `${region}+${vantage.suffix}`, label: vantage.label.replace("{region}", region) };
}

/**
 * Whether the second vantage is worth its visit: the first reading saw a
 * consent tool, a banner, a tracker, a tag loader or a tracking cookie. A
 * page with none of them has nothing a banner could hold back.
 */
export const wantsSecondVantage = (r) =>
  Boolean(r && r.state !== "unknown" && (r.tool || r.banner || r.tracking_cookies > 0 || r.trackers?.length || r.loaders?.length));

/** The longest the second vantage may take, everything included. */
export const SECOND_VANTAGE_LIMIT_MS = 40000;

/**
 * The reading from a second vantage (EU_SETTINGS by default): a fresh browser
 * context of its own with the vantage's settings, the same arrival as the
 * capture's (the load, the network going quiet up to 8 seconds, 1.5 seconds),
 * then readCookieCheck. Nothing is clicked. A page that answers an error
 * status (a bot check meeting a second visit) gives an `unknown` reading.
 * Never throws; its context is always closed. `contextOptions` are the
 * capture's own (viewport, user agent).
 * @param {import("playwright").Browser} browser
 */
export async function readSecondVantage(browser, url, { contextOptions = {}, vantage = EU_SETTINGS, region = captureRegion(), limitMs = SECOND_VANTAGE_LIMIT_MS, lateMs = LATE_BANNER_MS } = {}) {
  let ctx = null;
  let timer;
  const t0 = Date.now();
  const work = (async () => {
    ctx = await browser.newContext({ ...contextOptions, ...vantage.context });
    const page = await ctx.newPage();
    const watch = watchRequests(page);
    const res = await page.goto(url, { waitUntil: "load", timeout: 30000 });
    const status = res?.status() ?? 0;
    if (status >= 400) return makeReading({ error: `the page answered ${status} to this visit`, region, vantage });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return readCookieCheck(page, watch, { region, vantage, lateMs });
  })();
  try {
    // `ms`: what the second visit cost, for the record.
    const r = await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`took over ${Math.round(limitMs / 1000)}s`)), limitMs)))]);
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    work.catch(() => {});
    return { ...makeReading({ error: `the second visit failed (${String(e?.message ?? e).slice(0, 120)})`, region, vantage }), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
    // The context may still be opening when the limit passes: closed once it exists.
    const close = () => ctx?.close().catch(() => {});
    await Promise.race([work.then(close, close), new Promise((r) => setTimeout(r, 5000))]);
    await close();
  }
}

/**
 * The facts' privacy part with `readings` stored under their vantages
 * (reading.vantage, the region for a plain reading): the other vantages'
 * readings in `previous` (the stored facts.privacy) are kept, so a reading
 * made elsewhere is not lost when this runner captures again.
 */
export function withReading(previous, ...readings) {
  const old = previous && typeof previous === "object" && Number(previous.v) === PRIVACY_VERSION && previous.readings && typeof previous.readings === "object" ? previous.readings : {};
  const next = { ...old };
  for (const r of readings) if (r) next[r.vantage ?? r.region] = r;
  return { v: PRIVACY_VERSION, readings: next };
}
