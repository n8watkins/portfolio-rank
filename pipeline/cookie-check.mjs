// The cookie check (owner, 2026-11-25): whether a site sets tracking cookies,
// and whether it asks permission first. In his words: "tracking cookies itself
// is not something to fix, tracking cookies and not asking for permission to
// track cookies is something to fix." Plain observed facts, measured by code
// during the capture's own visit (pipeline/capture.mjs), before the capture
// clicks or dismisses anything: no score, no AI, no legal verdict.
//
// The guiding rule (review of #305): a wrong public "tracks without asking"
// on someone's profile is the costly error, a miss is cheap. So only the
// site's own evidence can make a fix (lib/cookie-check.mjs), and every rule
// below leans toward "not seen" when it cannot tell.
//
// What is read, once the page has loaded and settled (and once more, 2
// seconds later, when the site's own tracking was seen and no banner yet: a
// banner that slides in late), bounded in time (readCookieCheck):
//   - every request so far, with where it came from (watchRequests): the
//     main frame, a same-site frame (or a blank frame a page script made),
//     or a third-party embed (a YouTube player, a Calendly widget), named by
//     its host.
//   - the cookies in the browser (name, domain, first or third party, and
//     whether each is a known tracking cookie: TRACKING_COOKIES by name, or
//     any cookie a tracker sets from its own domain). Cookie values are never
//     read into the result. A third-party cookie belongs to an embed when
//     every request to its site came from that embed's frame.
//   - tracker requests (TRACKERS): a request counts as tracking only when it
//     is a known beacon (a /g/collect, a /tr, a /v1/t), never a script or a
//     configuration fetch, which is recorded apart as a loader.
//   - cookieless analytics (COOKIELESS_ANALYTICS): recorded apart, never
//     tracking. They set no cookies and keep no identifier on the device.
//   - a consent tool (CONSENT_TOOLS) from the main frame or same-site frames
//     only (its script host, a script address on the page, its banner
//     element), and whether a banner is shown: a known tool's element, a
//     consent tool's own frame, or a generic banner (findConsent).
//
// The site's own tracking (`own`): a first-party tracking cookie on the
// analytics list (TRACKING_COOKIES), or a beacon from the main frame or a
// same-site frame to an analytics or pixel tracker. An ad network's cookie or
// request (a rotating ad creative), its first-party cookies included (__gads,
// _gcl_*), is kept as `ads`; an embed's cookies and beacons as `embeds`; any
// other third-party tracking cookie (a LinkedIn badge's or an X timeline's
// script) as `widgets`. None of them is the site's own tracking, so none
// changes the state. Infrastructure cookies (INFRA_COOKIES: __cf_bm,
// _cfuvid, cf_clearance, load balancers, consent records) are never tracking.
//
// The state (makeReading), from the site's own tracking only:
//   none           no own tracking (ads, embeds or widgets may still be recorded);
//   after-consent  a strict banner is shown and no own tracking before a choice;
//   with-banner    a banner with a choice is shown (strict, or loose with a decision
//                  button) and own tracking started before any choice;
//   with-notice    own tracking, and only a loose cookie notice (an OK, no decision);
//   no-consent     own tracking and no banner or notice at either level (with or
//                  without a consent tool);
//   unknown        the capture could not tell, with the reason.
//
// Each reading records where it was made from: `region`, the capture
// runner's network address (CAPTURE_REGION, "US" by default: GitHub's
// runners), which is also its key in facts.privacy.readings. A capture keeps
// the readings of other regions it finds (withReading), so a reading from a
// runner in Europe ("EU") can sit beside it later with no change of shape.
// Many consent tools show their banner only to visitors in some regions, so
// a US reading of a site that asks Europeans can be no-consent with a tool:
// that is what a US visitor met, and lib/cookie-check.mjs shows it as
// information, not a fix.
//
// The lists are fixed and written out here, so a reading is repeatable and a
// reviewer can see why a cookie or request counted; a tracker not on them is
// not seen (a miss, never a false accusation).

/** The shape of facts.privacy; a reader of another version treats it as not measured. */
export const PRIVACY_VERSION = 1;
/** Where the capture runs, unless CAPTURE_REGION says otherwise. */
export const DEFAULT_REGION = "US";
export const STATES = ["none", "after-consent", "with-banner", "with-notice", "no-consent", "unknown"];
/** At most this many cookies and hosts are stored per list (the counts are kept whole). */
export const MAX_LISTED = 40;
/** How long a reading waits once more for a late banner, when it saw the site's own tracking and no banner. */
export const LATE_BANNER_MS = 2000;
/** The most a reading may take, the late look included. */
export const READ_LIMIT_MS = 12000;
/** What a reading leaves of the capture's own time limit, for the rest of the capture. */
export const READ_MARGIN_MS = 120000;

/** The region a reading is made from: CAPTURE_REGION, else DEFAULT_REGION. */
export const captureRegion = (env = process.env) => String(env.CAPTURE_REGION ?? "").trim().toUpperCase() || DEFAULT_REGION;

/**
 * Known tracking cookies by name: [pattern, vendor, kind]. A cookie is a
 * tracking cookie when its name matches one of these, wherever it is set
 * (Google Analytics' _ga is a first-party cookie the site's own page writes).
 *
 * `kind` "ads" (the advertising list): cookies an ad network's script sets,
 * on the site's own domain too (AdSense's __gads, __gpi, __eoi; the Google
 * Ads and Microsoft Ads conversion cookies _gcl_*, _uet*; doubleclick's IDE,
 * DSID, test_cookie, APC). They come and go with the ad served, appearing on
 * some visits and not others, so they are filed under `ads` and never make a
 * fix. Every other entry is the analytics and session-recording list (Google
 * Analytics and its server-side FPID and FPLC, Hotjar, Clarity, Segment,
 * PostHog, Meta Pixel's _fbp, and the rest): the site's own measuring, which
 * can make a fix when it is first-party.
 */
export const TRACKING_COOKIES = [
  [/^_ga(_[A-Z0-9]+)?$/, "Google Analytics"],
  [/^_gid$/, "Google Analytics"],
  [/^_gat(_.+)?$/, "Google Analytics"],
  [/^__utm[abcztv]$/, "Google Analytics"],
  // Server-side Google Tag Manager's first-party identifiers.
  [/^(FPID|FPLC)$/, "Google Analytics"],
  [/^_gcl_/, "Google Ads", "ads"],
  [/^(IDE|DSID|test_cookie|__gads|__gpi|__eoi|APC)$/, "Google Ads", "ads"],
  [/^_fb[pc]$/, "Meta Pixel"],
  [/^_hj/, "Hotjar"],
  [/^_cl(ck|sk)$/, "Microsoft Clarity"],
  [/^_uet(sid|vid)$/, "Microsoft Advertising", "ads"],
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
  [/^_hp[25]_/, "Heap"],
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
 * Infrastructure cookies: bot protection, load balancing, a site's or a
 * widget's own consent and language records. Never tracking, on any domain
 * (a __cf_bm on linkedin.com or x.com is Cloudflare's bot check, not LinkedIn's
 * or X's tracking).
 */
export const INFRA_COOKIES =
  /^(__cf_bm|_cfuvid|cf_clearance|__cflb|cf_ob_info|cf_use_ob|__cfruid|__cfwaitingroom|AWSALB(CORS|TG|TGCORS)?|AWSELB(CORS)?|ARRAffinity(SameSite)?|__ddg\d*_?|incap_ses_.*|visid_incap_.*|nlbi_.*|_dd_s|datadome|JSESSIONID|li_gc|lang|lms_ads_consent|CookieConsent|OptanonConsent|OptanonAlertBoxClosed|cookieyes-consent|__Host-.*|__Secure-next-auth\..*|csrftoken|XSRF-TOKEN)$/i;

/**
 * Known trackers: { host, vendor, kind, beacon? }. `kind` is "analytics" or
 * "pixel" (the site's own measuring: its beacons from the main frame are the
 * site's own tracking) or "ads" (an ad network serving ads: never the site's
 * own). A request to the host or a subdomain is a beacon when its path
 * matches `beacon` ("ads" hosts: any request that is not a script); every
 * other request to it (a script, a configuration) is a loader, never
 * tracking. A cookie set from the host's own domain is a tracking cookie of
 * the vendor. `path` limits the host to those paths. The beacons verified
 * against live sites on 2026-11-25 are marked "verified".
 */
export const TRACKERS = [
  // verified: www.google-analytics.com, analytics.google.com and stats.g.doubleclick.net /g/collect (adhamdannaway.com, juncie.com, adityaseth.in)
  { host: "google-analytics.com", vendor: "Google Analytics", kind: "analytics", beacon: /^\/(g\/|j\/|r\/|mp\/)?collect\b/ },
  { host: "analytics.google.com", vendor: "Google Analytics", kind: "analytics", beacon: /^\/(g\/)?collect\b/ },
  { host: "stats.g.doubleclick.net", vendor: "Google Analytics", kind: "analytics", beacon: /^\/(g\/|j\/|r\/)?collect\b/ },
  // A tag manager only loads tags (gtm.js, gtag/js): never a beacon.
  { host: "googletagmanager.com", vendor: "Google Tag Manager", kind: "analytics", beacon: null },
  { host: "googleadservices.com", vendor: "Google Ads", kind: "pixel", beacon: /^\/pagead\/conversion\// },
  { host: "google.com", vendor: "Google Ads", kind: "pixel", path: /^\/(pagead|ccm|rmkt)\//, beacon: /^\/(pagead\/(1p-user-list|1p-conversion|conversion|viewthroughconversion)|ccm\/collect|rmkt\/collect)\b/ },
  // verified: AdSense on elangodev.com (pagead2.googlesyndication.com/pagead/ping from the main frame, the ad in a doubleclick frame)
  { host: "doubleclick.net", vendor: "Google Ads", kind: "ads" },
  { host: "googlesyndication.com", vendor: "Google AdSense", kind: "ads" },
  { host: "adtrafficquality.google", vendor: "Google AdSense", kind: "ads" },
  // verified: connect.facebook.net fbevents.js, signals/config (juncie.com), sdk.js, app_config (adhamdannaway.com): all loaders
  { host: "connect.facebook.net", vendor: "Meta Pixel", kind: "pixel", beacon: null },
  { host: "facebook.com", vendor: "Meta Pixel", kind: "pixel", path: /^\/tr\/?$/, beacon: /^\/tr\/?$/ },
  // verified: static.hotjar.com and script.hotjar.com scripts are loaders (tajmirul.site); its data goes to *.hotjar.io
  { host: "hotjar.com", vendor: "Hotjar", kind: "analytics", beacon: null },
  { host: "hotjar.io", vendor: "Hotjar", kind: "analytics", beacon: /^\/(?!.*\.js$)/ },
  // verified: www.clarity.ms/tag and scripts.clarity.ms are loaders, b.clarity.ms/collect the beacon (adityaseth.in)
  { host: "clarity.ms", vendor: "Microsoft Clarity", kind: "analytics", beacon: /^\/collect\b/ },
  { host: "bat.bing.com", vendor: "Microsoft Advertising", kind: "pixel", beacon: /^\/action\// },
  { host: "snap.licdn.com", vendor: "LinkedIn", kind: "pixel", beacon: null },
  { host: "px.ads.linkedin.com", vendor: "LinkedIn", kind: "pixel", beacon: /^\/(collect|wa)\b/ },
  { host: "analytics.tiktok.com", vendor: "TikTok", kind: "pixel", beacon: /^\/api\/v\d\/(pixel|monitor)\b/ },
  { host: "static.ads-twitter.com", vendor: "X (Twitter)", kind: "pixel", beacon: null },
  { host: "analytics.twitter.com", vendor: "X (Twitter)", kind: "pixel", beacon: /^\/i\/adsct\b/ },
  { host: "t.co", vendor: "X (Twitter)", kind: "pixel", path: /^\/i\/adsct\b/, beacon: /^\/i\/adsct\b/ },
  { host: "ct.pinterest.com", vendor: "Pinterest", kind: "pixel", beacon: /^\/(v3|user)\b/ },
  { host: "tr.snapchat.com", vendor: "Snapchat", kind: "pixel", beacon: /^\/(p|cm)\b/ },
  { host: "sc-static.net", vendor: "Snapchat", kind: "pixel", beacon: null },
  { host: "js.hs-scripts.com", vendor: "HubSpot", kind: "analytics", beacon: null },
  { host: "js.hs-analytics.net", vendor: "HubSpot", kind: "analytics", beacon: null },
  { host: "track.hubspot.com", vendor: "HubSpot", kind: "analytics", beacon: /^\/__pt[qc]\.gif\b/ },
  { host: "mixpanel.com", vendor: "Mixpanel", kind: "analytics", beacon: /^\/(track|engage|import)\b/ },
  { host: "mxpnl.com", vendor: "Mixpanel", kind: "analytics", beacon: null },
  { host: "cdn.amplitude.com", vendor: "Amplitude", kind: "analytics", beacon: null },
  { host: "sr-client-cfg.amplitude.com", vendor: "Amplitude", kind: "analytics", beacon: null },
  { host: "amplitude.com", vendor: "Amplitude", kind: "analytics", beacon: /^\/(2\/httpapi|batch)\b/ },
  { host: "cdn.segment.io", vendor: "Segment", kind: "analytics", beacon: null },
  { host: "cdn.segment.com", vendor: "Segment", kind: "analytics", beacon: null },
  { host: "segment.io", vendor: "Segment", kind: "analytics", beacon: /^\/v1\/(t|p|i|track|page|identify|batch|m)\b/ },
  // verified: eu-assets.i.posthog.com /static and /array are loaders (carlton.dev); its events go to /e/, /i/v0/e/, /batch
  { host: "posthog.com", vendor: "PostHog", kind: "analytics", beacon: /^\/(e|i\/v0\/e|batch|capture|s)\/?/ },
  { host: "mc.yandex.ru", vendor: "Yandex Metrica", kind: "analytics", beacon: /^\/(watch|webvisor)\// },
  { host: "mc.yandex.com", vendor: "Yandex Metrica", kind: "analytics", beacon: /^\/(watch|webvisor)\// },
  // verified on hotjar.com: cdn.us.heap-api.com (heap.js, heap_config.js) loads, c.us.heap-api.com/api/capture/v2/track
  // is the beacon, heapanalytics.com/api/telemetry is the library's own telemetry (not counted)
  { host: "heapanalytics.com", vendor: "Heap", kind: "analytics", beacon: null },
  { host: "heap-api.com", vendor: "Heap", kind: "analytics", beacon: /^\/api\/capture\// },
  { host: "fullstory.com", vendor: "FullStory", kind: "analytics", beacon: /^\/rec\// },
  { host: "matomo.cloud", vendor: "Matomo", kind: "analytics", beacon: /^\/(matomo|piwik)\.php\b/ },
  // Reddit's pixel: no request path verified live, so cookie-only (its first-party _rdt_uuid; rbu on reddit.com).
  { host: "alb.reddit.com", vendor: "Reddit", kind: "pixel", beacon: null },
  { host: "pixel-config.reddit.com", vendor: "Reddit", kind: "pixel", beacon: null },
  { host: "redditstatic.com", vendor: "Reddit", kind: "pixel", beacon: null },
  { host: "crazyegg.com", vendor: "Crazy Egg", kind: "analytics", beacon: null },
  { host: "visualwebsiteoptimizer.com", vendor: "VWO", kind: "analytics", beacon: null },
  { host: "mouseflow.com", vendor: "Mouseflow", kind: "analytics", beacon: null },
  { host: "smartlook.com", vendor: "Smartlook", kind: "analytics", beacon: null },
  { host: "luckyorange.com", vendor: "Lucky Orange", kind: "analytics", beacon: null },
  { host: "leadfeeder.com", vendor: "Leadfeeder", kind: "analytics", beacon: null },
  { host: "lfeeder.com", vendor: "Leadfeeder", kind: "analytics", beacon: null },
  { host: "quantserve.com", vendor: "Quantcast", kind: "ads" },
  { host: "scorecardresearch.com", vendor: "Comscore", kind: "ads" },
  { host: "criteo.com", vendor: "Criteo", kind: "ads" },
  { host: "criteo.net", vendor: "Criteo", kind: "ads" },
  { host: "adnxs.com", vendor: "Xandr", kind: "ads" },
  { host: "taboola.com", vendor: "Taboola", kind: "ads" },
  { host: "outbrain.com", vendor: "Outbrain", kind: "ads" },
  { host: "bing.com", vendor: "Microsoft Advertising", kind: "ads", path: /^\/c\.gif\b/ },
];

/**
 * Domains whose own cookies (other than INFRA_COOKIES) are tracking cookies
 * of their vendor; their requests are content, not tracking. `kind` "ads":
 * an ad network's (bing.com's MUID is Microsoft Advertising's).
 */
export const TRACKING_COOKIE_DOMAINS = [
  { host: "youtube.com", vendor: "YouTube" },
  { host: "linkedin.com", vendor: "LinkedIn" },
  { host: "facebook.com", vendor: "Meta" },
  { host: "twitter.com", vendor: "X (Twitter)" },
  { host: "x.com", vendor: "X (Twitter)" },
  { host: "tiktok.com", vendor: "TikTok" },
  { host: "reddit.com", vendor: "Reddit" },
  { host: "bing.com", vendor: "Microsoft Advertising", kind: "ads" },
];

/** Embeds by the host of their frame, for the name shown and the advice that fits ("privacy" mode, else click to load). */
export const EMBEDS = [
  { host: "youtube.com", name: "YouTube", privacy: "youtube-nocookie.com, YouTube's privacy-enhanced mode" },
  { host: "youtube-nocookie.com", name: "YouTube (privacy-enhanced mode)" },
  { host: "vimeo.com", name: "Vimeo", privacy: "the Vimeo player's do-not-track setting (dnt=1)" },
  { host: "calendly.com", name: "Calendly" },
  { host: "linkedin.com", name: "LinkedIn" },
  { host: "twitter.com", name: "X (Twitter)" },
  { host: "x.com", name: "X (Twitter)" },
  { host: "facebook.com", name: "Facebook" },
  { host: "instagram.com", name: "Instagram" },
  { host: "spotify.com", name: "Spotify" },
  { host: "soundcloud.com", name: "SoundCloud" },
  { host: "codepen.io", name: "CodePen" },
  { host: "google.com", name: "Google" },
];

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
  { host: "openpanel.dev", vendor: "OpenPanel" },
  { script: /\/umami(\.js)?(\?|$)|umami.*\/script\.js/i, vendor: "Umami" },
  { script: /plausible/i, vendor: "Plausible" },
];

/**
 * Consent tools: { name, hosts, selector, script? }. `hosts` are where their
 * script comes from, `script` a self-hosted copy's address, `selector` the
 * element of their banner on the page.
 */
export const CONSENT_TOOLS = [
  { name: "Cookiebot", hosts: ["cookiebot.com", "cookiebot.eu"], selector: "#CybotCookiebotDialog" },
  { name: "OneTrust", hosts: ["cookielaw.org", "onetrust.com"], selector: "#onetrust-banner-sdk, #onetrust-consent-sdk .ot-sdk-container, #onetrust-pc-sdk" },
  { name: "Osano", hosts: ["osano.com"], selector: ".osano-cm-window, .osano-cm-dialog" },
  { name: "CookieYes", hosts: ["cookieyes.com", "cdn-cookieyes.com"], selector: ".cky-consent-container, #cookie-law-info-bar, .cky-modal" },
  { name: "Klaro", hosts: ["kiprotect.com", "klaro.org"], selector: ".klaro .cookie-notice, .klaro .cookie-modal, #klaro .cookie-notice", script: /\/klaro(\.min)?\.js/i },
  { name: "Complianz", hosts: [], selector: "#cmplz-cookiebanner-container .cmplz-cookiebanner, .cmplz-cookiebanner", script: /complianz/i },
  { name: "iubenda", hosts: ["iubenda.com"], selector: "#iubenda-cs-banner" },
  { name: "Termly", hosts: ["termly.io"], selector: "[class*=termly-styles-root], #termly-code-snippet-support [role=dialog]" },
  { name: "Usercentrics", hosts: ["usercentrics.eu", "usercentrics.com"], selector: "#usercentrics-root, #usercentrics-cmp-ui, #uc-banner" },
  { name: "Didomi", hosts: ["privacy-center.org", "didomi.io"], selector: "#didomi-host .didomi-popup-container, #didomi-notice" },
  { name: "Quantcast Choice", hosts: ["quantcast.mgr.consensu.org", "cmp.quantcast.com"], selector: ".qc-cmp2-container" },
  { name: "TrustArc", hosts: ["trustarc.com", "truste.com"], selector: "#truste-consent-track, #consent_blackbar" },
  { name: "CookieFirst", hosts: ["cookiefirst.com"], selector: ".cookiefirst-root" },
  { name: "Cookie Script", hosts: ["cookie-script.com"], selector: "#cookiescript_injected" },
  { name: "Borlabs Cookie", hosts: [], selector: "#BorlabsCookieBox ._brlbs-bar, #BorlabsCookieBox ._brlbs-box", script: /borlabs-cookie/i },
  { name: "Google consent message", hosts: ["fundingchoicesmessages.google.com"], selector: ".fc-consent-root" },
  { name: "Sourcepoint", hosts: ["sourcepoint.com", "privacy-mgmt.com"], selector: "[id^=sp_message_container]" },
  { name: "Silktide", hosts: ["silktide.com"], selector: "#silktide-wrapper, #stcm-wrapper" },
  { name: "Axeptio", hosts: ["axept.io"], selector: "#axeptio_overlay .axeptio_mount, #axeptio_overlay [class*=axeptio_widget], #axeptio_main_button" },
  { name: "CookieHub", hosts: ["cookiehub.net", "cookiehub.eu"], selector: ".ch2-dialog, .ch2-container .ch2-dialog" },
  { name: "Consentmanager", hosts: ["consentmanager.net"], selector: "#cmpbox, .cmpbox" },
  { name: "Ketch", hosts: ["ketchcdn.com", "ketchjs.com"], selector: "#lanyard_root" },
  { name: "Tarteaucitron", hosts: ["tarteaucitron.io"], selector: "#tarteaucitronAlertBig, #tarteaucitronRoot #tarteaucitronAlertBig", script: /tarteaucitron/i },
  { name: "Cookie Notice (WordPress)", hosts: ["hu-manity.co"], selector: "#cookie-notice", script: /cookie-notice\/js\/front/i },
  { name: "HubSpot cookie banner", hosts: ["hs-banner.com"], selector: "#hs-eu-cookie-confirmation" },
  // The open-source banners: Osano's cookieconsent (cc-window) and orestbida's vanilla-cookieconsent (#cc-main, #cm).
  { name: "cookieconsent", hosts: [], selector: ".cc-window, #cc-main .cm, #cc--main #cm", script: /cookieconsent/i },
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

const trackerFor = (host, path) => TRACKERS.filter((t) => onHost(host, t.host) && (!t.path || t.path.test(path))).sort((a, b) => b.host.length - a.host.length)[0];
const cookielessFor = (host, path) => COOKIELESS_ANALYTICS.find((c) => (c.host ? onHost(host, c.host) : c.path ? c.path.test(path) : false));
const isScript = (path) => /\.m?js$/i.test(path);

/** Whether a request to tracker `t` at `path` is one of its beacons (never a script or a configuration). */
export function isBeacon(t, path) {
  if (!t) return false;
  if (t.kind === "ads") return !isScript(path);
  return Boolean(t.beacon && t.beacon.test(path) && !isScript(path));
}

/** The vendor of a tracking cookie, or null: by its name, else by the tracker domain that set it. */
export function trackingCookieVendor(cookie) {
  return trackingCookie(cookie)?.vendor ?? null;
}

/**
 * A tracking cookie's { vendor, ads } (ads: on the advertising list, or set
 * from an ad network's own domain), or null: an infrastructure cookie
 * (INFRA_COOKIES) is never one, on any domain.
 */
export function trackingCookie({ name, domain }) {
  const n = String(name ?? "");
  if (INFRA_COOKIES.test(n)) return null;
  const byName = TRACKING_COOKIES.find(([re]) => re.test(n));
  if (byName) return { vendor: byName[1], ads: byName[2] === "ads" };
  const byDomain = [...TRACKERS.filter((t) => !t.path), ...TRACKING_COOKIE_DOMAINS].find((t) => onHost(domain, t.host));
  return byDomain ? { vendor: byDomain.vendor, ads: byDomain.kind === "ads" } : null;
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

/** The name an embed is shown by: EMBEDS, else its host. */
export const embedName = (host) => EMBEDS.find((e) => onHost(host, e.host))?.name ?? String(host ?? "").replace(/^www\./, "");

/**
 * Where a request came from (pure), against the page's address: "main", or
 * "same-site" (a frame on the site's own registrable domain, or a frame
 * with no address of its own, which a page script made), or "embed" with
 * the embed frame's host. `r` is watchRequests's record: { url, frame }
 * (frame: null for the main frame, else the address of the top frame under
 * the page that the request belongs to).
 */
export function originOf(r, pageSite) {
  if (r.frame == null) return { origin: "main", embed: null };
  const host = hostOf(r.frame);
  if (!host || siteOf(host) === pageSite) return { origin: "same-site", embed: null };
  return { origin: "embed", embed: host };
}

/** Adds one to `key`'s count in `map`. */
const tally = (map, key, row) => {
  const cur = map.get(key) ?? { ...row, requests: 0 };
  cur.requests++;
  map.set(key, cur);
};
const listed = (map) => [...map.values()].sort((a, b) => b.requests - a.requests || a.host.localeCompare(b.host)).slice(0, MAX_LISTED);
const vendorsOf = (rows) => [...new Set(rows.map((r) => r.vendor).filter(Boolean))];

/**
 * The requests' part of a reading (pure). `requests`: watchRequests's
 * records ({ url, frame }; a plain address string is a main-frame request).
 * Returns { beacons, loaders, ads, embedBeacons, cookieless, consentHosts,
 * consentPings, sitesFrom, embedHosts }: beacons (the site's own tracking),
 * loaders and ads as [{ host, vendor, requests }]; embedBeacons as [{ embed,
 * host, vendor, requests }]; `sitesFrom` maps each requested registrable
 * domain to the origins that asked for it ("main" for the page's own and
 * same-site frames, else the embed's host), for the cookies.
 */
export function classifyRequests(requests, pageUrl = "") {
  const pageSite = siteOf(hostOf(pageUrl));
  const beacons = new Map();
  const loaders = new Map();
  const ads = new Map();
  const embedBeacons = new Map();
  const cookieless = new Map();
  const consentHosts = new Set();
  const sitesFrom = new Map();
  const embedHosts = new Set();
  let consentPings = 0;
  for (const raw of requests ?? []) {
    const r = typeof raw === "string" ? { url: raw, frame: null } : raw;
    const host = hostOf(r.url);
    if (!host) continue;
    const path = pathOf(r.url);
    const { origin, embed } = originOf(r, pageSite);
    if (embed) embedHosts.add(embed);
    const from = origin === "embed" ? embed : "main";
    const site = siteOf(host);
    if (!sitesFrom.has(site)) sitesFrom.set(site, new Set());
    sitesFrom.get(site).add(from);
    // Consent tools and cookieless analytics: the page's own only, never an embed's.
    if (origin !== "embed") {
      const tool = CONSENT_TOOLS.find((c) => c.hosts.some((h) => onHost(host, h)));
      if (tool) consentHosts.add(tool.name);
      const free = cookielessFor(host, path);
      if (free) {
        tally(cookieless, host, { host, vendor: free.vendor });
        continue;
      }
    }
    const t = trackerFor(host, path);
    if (!t) continue;
    if (origin === "embed") {
      if (isBeacon(t, path)) tally(embedBeacons, `${embed} ${host}`, { embed, host, vendor: t.vendor });
      continue;
    }
    if (t.kind !== "ads" && deniedConsentPing(r.url)) consentPings++;
    else if (!isBeacon(t, path)) tally(loaders, host, { host, vendor: t.vendor });
    else if (t.kind === "ads") tally(ads, host, { host, vendor: t.vendor });
    else tally(beacons, host, { host, vendor: t.vendor });
  }
  return {
    beacons: listed(beacons),
    loaders: listed(loaders),
    ads: listed(ads),
    embedBeacons: [...embedBeacons.values()].slice(0, MAX_LISTED),
    cookieless: listed(cookieless),
    consentHosts: [...consentHosts],
    consentPings,
    sitesFrom,
    embedHosts: [...embedHosts],
  };
}

/**
 * The cookies' part of a reading (pure): each cookie's name, domain, party
 * (against the page's address `pageUrl`), tracking vendor (null when it is
 * not a known tracking cookie) and, for a third-party cookie, the embed it
 * belongs to (`embed`): the embed frame on the cookie's own site (a YouTube
 * player's frame for a youtube.com cookie, even when the page also loaded
 * YouTube's player script), else the one embed that every request to the
 * cookie's site came from (a doubleclick.net cookie set from inside the
 * YouTube player); null otherwise. Values are never kept, whatever is passed
 * in. `seen`: classifyRequests's { sitesFrom, embedHosts }.
 */
export function classifyCookies(cookies, pageUrl, { sitesFrom = new Map(), embedHosts = [] } = {}) {
  const site = siteOf(hostOf(pageUrl));
  const rows = [];
  for (const c of cookies ?? []) {
    const name = String(c?.name ?? "");
    const domain = String(c?.domain ?? "").toLowerCase();
    if (!name) continue;
    const cookieSite = siteOf(domain);
    const party = site && cookieSite === site ? "first" : "third";
    const from = sitesFrom.get(cookieSite);
    const embed =
      party === "first" ? null : (embedHosts.find((h) => siteOf(h) === cookieSite) ?? (from && from.size === 1 && !from.has("main") ? [...from][0] : null));
    const t = trackingCookie({ name, domain });
    rows.push({ name, domain, party, tracking: t?.vendor ?? null, ad: Boolean(t?.ads), embed });
  }
  // Tracking cookies first, then by domain and name, so the stored list keeps what matters when it is cut.
  rows.sort((a, b) => Number(Boolean(b.tracking)) - Number(Boolean(a.tracking)) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * One reading (pure), from what the browser saw before any click:
 *   pageUrl   the page's address at the reading;
 *   cookies   the browser's cookies ({ name, domain }; values are dropped);
 *   requests  watchRequests's records so far;
 *   dom       findConsent's answer ({ tools, banner, sample, scripts }), or
 *             null when the page could not be read;
 *   error     why the reading could not be made, if it could not;
 *   region, at.
 * Returns the stored reading: { v, region, at, state, reason, banner,
 * banner_how, tool, vendors (the site's own), own_cookies, beacons, loaders,
 * ads, embeds, cookieless, consent_mode_pings, cookies, cookie_count }.
 */
export function makeReading({ pageUrl = "", cookies = [], requests = [], dom = null, error = null, region = DEFAULT_REGION, at = new Date() }) {
  const base = { v: PRIVACY_VERSION, region, at: (at instanceof Date ? at : new Date(at)).toISOString() };
  if (error) return { ...base, state: "unknown", reason: String(error).slice(0, 200) };
  const req = classifyRequests(requests, pageUrl);
  const jar = classifyCookies(cookies, pageUrl, req);
  // A cookieless tool loaded from the site itself (a proxied Plausible, a self-hosted Umami): seen by its script.
  const cookieless = [...req.cookieless];
  for (const s of dom?.scripts ?? []) {
    const hit = COOKIELESS_ANALYTICS.find((c) => c.script?.test(s));
    if (hit && !cookieless.some((r) => r.vendor === hit.vendor)) cookieless.push({ host: hostOf(s) || siteOf(hostOf(pageUrl)), vendor: hit.vendor, requests: 0 });
  }
  // The site's own: first-party tracking cookies of the analytics list and the main frame's beacons. An ad
  // script's first-party cookies (__gads, _gcl_*) are an ad's: they come and go with the ad served.
  const ownCookies = jar.filter((c) => c.tracking && c.party === "first" && !c.ad);
  const firstPartyAds = jar.filter((c) => c.tracking && c.party === "first" && c.ad);
  // An embed's: its third-party tracking cookies and its beacons, by embed. An ad's own frame (an AdSense
  // slot is a doubleclick frame) is an ad, not an embed.
  const adFrame = (host) => trackerFor(host, "/")?.kind === "ads";
  const embeds = new Map();
  const embedRow = (host) => embeds.get(host) ?? embeds.set(host, { host, name: embedName(host), cookies: [], trackers: [] }).get(host);
  const adsFromFrames = [];
  for (const c of jar) {
    if (!c.embed || !c.tracking) continue;
    if (adFrame(c.embed)) adsFromFrames.push({ host: c.domain.replace(/^\./, ""), vendor: c.tracking, cookie: c.name });
    else embedRow(c.embed).cookies.push(c.name);
  }
  for (const b of req.embedBeacons) {
    if (adFrame(b.embed)) adsFromFrames.push({ host: b.host, vendor: b.vendor, requests: b.requests });
    else embedRow(b.embed).trackers.push(`${b.host} x${b.requests}`);
  }
  const own = ownCookies.length > 0 || req.beacons.length > 0;
  const vendors = vendorsOf([...ownCookies.map((c) => ({ vendor: c.tracking })), ...req.beacons]);
  // Third-party tracking cookies tied to no embed frame: an ad network's are an ad's; one of a vendor the
  // site itself measures with (Clarity's own MUID beside its beacons) is part of that; any other is a
  // widget's (a LinkedIn badge's or an X timeline's script).
  const cookieRow = (c) => ({ host: c.domain.replace(/^\./, ""), vendor: c.tracking, cookie: c.name });
  const thirdCookies = jar.filter((c) => c.tracking && c.party === "third" && !c.embed);
  const ads = [...req.ads, ...firstPartyAds.map(cookieRow), ...thirdCookies.filter((c) => c.ad).map(cookieRow), ...adsFromFrames].slice(0, MAX_LISTED);
  const widgets = thirdCookies.filter((c) => !c.ad && !vendors.includes(c.tracking)).map(cookieRow).slice(0, MAX_LISTED);
  // A consent tool in the page's own code: its script host, a script address, or its element on the page.
  const scriptTool = CONSENT_TOOLS.find((t) => t.script && (dom?.scripts ?? []).some((s) => t.script.test(s)))?.name ?? null;
  const tool = dom?.tools?.find((t) => t.shown)?.name ?? dom?.tools?.[0]?.name ?? req.consentHosts[0] ?? scriptTool ?? null;
  // The banner, at two levels (findConsent): `banner` the strict one, which alone earns "Asks before
  // tracking"; `notice` the loose one, which keeps the site's own tracking from ever reading as "without
  // asking": with a decision button (Accept, Decline) it is a banner the tracking ran before; with only an
  // acknowledgement (OK, Got it) it is a cookie notice.
  const banner = dom ? Boolean(dom.banner) : null;
  const notice = dom?.loose ?? null;
  let state;
  let reason = null;
  if (!own) state = banner ? "after-consent" : "none";
  else if (banner === null) {
    state = "unknown";
    reason = "the site's own tracking started, but the page could not be read to tell whether a consent banner was shown";
  } else if (banner) state = "with-banner";
  else if (notice?.decision) state = "with-banner";
  else if (notice) state = "with-notice";
  else state = "no-consent";
  if (state === "no-consent" && tool) reason = `${tool} is in the page's code but showed no banner to this visit (from ${region})`;
  return {
    ...base,
    state,
    reason,
    banner,
    banner_how: dom?.banner ?? (notice ? (notice.decision ? "loose" : "notice") : null),
    banner_sample: dom?.sample ?? notice?.sample ?? null,
    tool,
    vendors,
    own_cookies: ownCookies.map((c) => ({ name: c.name, vendor: c.tracking })),
    beacons: req.beacons,
    loaders: req.loaders,
    ads,
    widgets,
    embeds: [...embeds.values()].filter((e) => e.cookies.length || e.trackers.length),
    embed_hosts: req.embedHosts.slice(0, MAX_LISTED),
    cookieless,
    consent_mode_pings: req.consentPings,
    cookie_count: jar.length,
    cookies: jar.slice(0, MAX_LISTED),
  };
}

/**
 * In the browser: the consent banner, if one is shown. Returns { tools,
 * banner, sample, scripts }: `tools` the known consent tools whose banner
 * element is on the page ({ name, shown }); `banner` how a shown banner was
 * recognised ("tool", "frame" for a consent tool's visible frame, "generic"),
 * or null when none is shown; `sample` the first words of a generic banner,
 * for the reviewer; `scripts` the page's script addresses (for cookieless
 * analytics and consent tools served from the site itself). Pure DOM
 * reading: nothing is clicked or changed.
 *
 * The generic banner, at two levels. Both need a visible element that is
 * fixed, sticky, a dialog, or named like a consent banner, under 1,500
 * characters, holding a short choice control (accept, reject, agree,
 * decline, allow, deny, manage, settings, OK in English, French, German,
 * Spanish, Italian, Portuguese, Dutch and Polish; read from its text, value,
 * aria-label or title).
 *   strict (`banner: "generic"`): its text says it uses cookies or tracking
 *     ("we use", "this site uses", "stores cookies", "cookie preferences",
 *     "cookies help us" and the same in those languages), or it is named like
 *     a consent tool's banner. Only this level earns "Asks before tracking".
 *   loose (`loose: { decision, sample }`): its text names cookies or consent
 *     at all. It never earns praise; it keeps the site's own tracking from
 *     reading as "without asking" (makeReading). `decision`: a control that
 *     decides (accept, decline...), not only acknowledges (OK, Got it).
 * The false-positive guard, for both: a footer that says "No cookies, no
 * tracking. OK", a footer link to a cookie policy (no choice control), a
 * blog post about cookies or a "Cookie Clicker" project card (not pinned,
 * not a dialog) is not a banner.
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
  // Says it uses cookies or tracking, in English, French, German, Spanish, Italian, Portuguese, Dutch or Polish.
  const USES = new RegExp(
    [
      String.raw`\b(we|this (web)?site|our (web)?site|this page)\s+(also\s+)?(use|uses|place|store|set)\b`,
      String.raw`\b(uses?|using)\s+(analytics\s+|tracking\s+)?(cookies|trackers)`,
      // A notice that says what the cookies do: "this site counts visits with cookies".
      String.raw`\b(counts?|measures?|tracks?|remembers?)\b[^.]{0,40}\bwith (analytics |tracking )?cookies\b`,
      String.raw`\bwe and our (\d+ )?(partners|vendors)\b`,
      String.raw`\bby (using|continuing|browsing|clicking)\b[^.]{0,80}\b(agree|accept|consent)`,
      // "This website stores cookies", "the storing of cookies", "We'd like to set cookies",
      // "Choose your cookie preferences", "Cookies help us understand how the site is used".
      String.raw`\b(stores?|storing|sets?|setting|place|places|placing)\s+(of\s+)?(analytics\s+|optional\s+|some\s+)?cookies\b`,
      String.raw`\b(like|want|need) to (use|set|store|place) (analytics |optional |some )?cookies\b`,
      String.raw`\bcookie (preferences|settings|choices|consent)\b`,
      String.raw`\bcookies (help|allow|enable|let) us\b`,
      String.raw`nous utilisons|ce site( web)? utilise|utilise des cookies|nous et nos partenaires|en poursuivant (votre )?navigation`,
      String.raw`wir (verwenden|nutzen|setzen)|diese (web)?seite (verwendet|nutzt|setzt)|(verwendet|nutzt|setzt) cookies|wir und unsere partner`,
      String.raw`(utilizamos|usamos)\s+(cookies|galletas)|este (sitio( web)?|portal) (utiliza|usa)|nosotros y nuestros socios`,
      String.raw`(utilizziamo|usiamo)\s+(i\s+)?cookie|questo sito (web )?(utilizza|usa)|noi e i nostri partner`,
      String.raw`(utilizamos|usamos)\s+cookies|este (site|website) (utiliza|usa)|n[oó]s e os nossos parceiros`,
      String.raw`(wij|we) gebruiken|deze (web)?site gebruikt|maakt gebruik van cookies`,
      String.raw`u[zż]ywamy|wykorzystujemy|ta strona (u[zż]ywa|wykorzystuje|korzysta)|strona korzysta z`,
    ].join("|"),
    "i"
  );
  const ABOUT = /cookie|ciasteczk|traceur|tracker|tracking|t[ée]moin|galleta/i;
  // A consent banner's or a consent tool's own markers in an element's id or class.
  const NAMED =
    /cookie[-_ ]?(banner|consent|notice|bar|popup|law|box|message|alert|disclaimer)|consent[-_ ]?(banner|bar|popup|box|notice|manager)|\bgdpr\b|\bcmp\b|cookiebot|onetrust|osano|cky-|klaro|cmplz|iubenda|termly|usercentrics|didomi|qc-cmp|truste|cookiefirst|cookiescript|borlabs|axeptio|ch2-|cmpbox|tarteaucitron|hs-eu-cookie|cc-window|cookieconsent/i;
  // A short choice button: its label starts with one of these, in the same languages.
  const CHOICE = new RegExp(
    String.raw`^[^\p{L}]*(` +
      [
        "accept( all)?|i accept|agree|i agree|allow( all)?|reject( all)?|decline|deny|refuse|manage|settings|preferences|customi[sz]e|ok|okay|got it|understood|necessary only|only necessary|essential only",
        "accepter|tout accepter|j'accepte|j’accepte|refuser|tout refuser|continuer sans accepter|autoriser|param[eè]tr|personnaliser|g[ée]rer|d'accord|d’accord|compris",
        "akzeptieren|alle akzeptieren|annehmen|zustimmen|einverstanden|ablehnen|alle ablehnen|erlauben|zulassen|verweigern|einstellungen|anpassen|verwalten|verstanden|nur notwendige",
        "aceptar|rechazar|permitir|denegar|configurar|configuraci[oó]n|gestionar|personalizar|de acuerdo|entendido",
        "accetta|accetto|rifiuta|consenti|nega|impostazioni|gestisci|personalizza|ho capito",
        "aceitar|aceito|rejeitar|recusar|negar|configura[cç][oõ]es|defini[cç][oõ]es|gerir|gerenciar|entendi",
        "accepteren|alles accepteren|akkoord|weigeren|afwijzen|toestaan|instellingen|beheren|aanpassen|begrepen",
        "akceptuj|akceptuj[eę]|zaakceptuj|zgadzam si[eę]|odrzu[cć]|odrzucam|zezw[oó]l|pozw[oó]l|odm[oó]w|ustawienia|zarz[aą]dzaj|dostosuj|rozumiem",
      ].join("|") +
      String.raw`)(?=$|[^\p{L}])`,
    "iu"
  );
  // The loose level's wording: cookies or consent named at all, in the same languages.
  const COOKIE_WORDS =
    /cookie|ciasteczk|traceur|t[ée]moin|galleta|consent|zustimmung|einwilligung|consentement|consentimiento|consenso|consentimento|toestemming|zgod[aęy]|privacy (settings|preferences|choices)|datenschutzeinstellungen/i;
  // Says it does not use them: "No cookies, no tracking", "cookie-free". Never a banner at either level.
  const NONE_USED =
    /\b(no|zero|without)\s+(cookies|tracking|trackers)\b|cookie-?free|cookieless|sans (cookies|traceurs)|ohne cookies|sin cookies|senza cookie|sem cookies|zonder cookies|bez (plik[oó]w )?cookie/i;
  // A decision, not only an acknowledgement: accept, agree, allow, reject, decline, deny, refuse.
  const DECISION = new RegExp(
    String.raw`^[^\p{L}]*(` +
      [
        "accept|i accept|agree|i agree|allow|reject|decline|deny|refuse|only necessary|necessary only|essential only",
        "accepter|tout accepter|j'accepte|j’accepte|refuser|tout refuser|continuer sans accepter|autoriser",
        "akzeptieren|alle akzeptieren|annehmen|zustimmen|einverstanden|ablehnen|alle ablehnen|erlauben|zulassen|verweigern|nur notwendige",
        "aceptar|rechazar|permitir|denegar",
        "accetta|accetto|rifiuta|consenti|nega",
        "aceitar|aceito|rejeitar|recusar|negar",
        "accepteren|alles accepteren|akkoord|weigeren|afwijzen|toestaan",
        "akceptuj|akceptuj[eę]|zaakceptuj|zgadzam si[eę]|odrzu[cć]|odrzucam|zezw[oó]l|pozw[oó]l|odm[oó]w",
      ].join("|") +
      String.raw`)(?=$|[^\p{L}])`,
    "iu"
  );
  const nameOf = (el) => `${el.id ?? ""} ${typeof el.className === "string" ? el.className : ""}`;
  // A control's labels: its text, value, aria-label and title (a "✓" button labelled "Accept cookies").
  const labelsOf = (b) =>
    [b.innerText, b.value, b.getAttribute("aria-label"), b.getAttribute("title")].map((l) => String(l ?? "").replace(/\s+/g, " ").trim()).filter((l) => l.length > 0 && l.length <= 40);
  let sample = null;
  let loose = null;
  const pinned = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "fixed" || p === "sticky") return true;
    }
    return false;
  };
  const DIALOG = "[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]";
  const candidates = new Set(document.querySelectorAll(`${DIALOG}, [role=region][aria-label]`));
  for (const el of document.querySelectorAll("[id], [class]")) if (NAMED.test(nameOf(el))) candidates.add(el);
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (++n > 6000) break;
    const p = getComputedStyle(el).position;
    if (p === "fixed" || p === "sticky") candidates.add(el);
  }
  for (const el of banner ? [] : candidates) {
    if (!el.isConnected || !visible(el)) continue;
    const text = (el.innerText ?? "").trim();
    if (!text || text.length > 1500) continue;
    const named = NAMED.test(nameOf(el));
    // Pinned on the screen (fixed, sticky), a dialog, or named as a banner: not a section of the page.
    if (!named && !pinned(el) && !el.matches(DIALOG)) continue;
    const uses = USES.test(text) && ABOUT.test(text);
    // "No cookies, no tracking. OK" is neither level, unless it also says it uses some.
    if (NONE_USED.test(text) && !uses) continue;
    if (!(named || COOKIE_WORDS.test(text))) continue;
    const labels = [...el.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]")].filter(visible).flatMap(labelsOf);
    const choice = labels.find((l) => CHOICE.test(l));
    if (!choice) continue;
    const words = text.replace(/\s+/g, " ").slice(0, 160);
    // Strict: says it uses cookies or tracking, or is named as a consent banner. Earns "Asks before tracking".
    if (named || uses) {
      banner = "generic";
      sample = words;
      break;
    }
    // Loose: cookie or consent wording and a choice. Never praise; it keeps tracking from reading as "without asking".
    const decision = labels.some((l) => DECISION.test(l));
    if (!loose || (decision && !loose.decision)) loose = { decision, sample: words };
  }
  const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 200);
  return { tools: found, banner, sample, loose: banner ? null : loose, scripts };
}

/** The arguments findConsent is evaluated with: the tools' banner selectors, and the hosts of their frames. */
export const consentArgs = () => [CONSENT_TOOLS.map((t) => [t.name, t.selector]), CONSENT_TOOLS.flatMap((t) => t.hosts)];

/**
 * The frame a request belongs to, for originOf: null for the main frame (and
 * for a request with no frame, a worker's), else the address of the top
 * frame under the page it is in. A frame's own document request is that
 * frame's address (its frame has none yet).
 * @param {import("playwright").Page} page
 */
export function frameOfRequest(page, req) {
  try {
    const main = page.mainFrame();
    let f = req.frame();
    if (!f || f === main) return null;
    if (req.isNavigationRequest() && f.parentFrame() === main) return req.url();
    while (f.parentFrame() && f.parentFrame() !== main) f = f.parentFrame();
    const u = f.url();
    return u && u !== "about:blank" ? u : "";
  } catch {
    return null;
  }
}

/**
 * Starts listening to a page's requests (pipeline/capture.mjs, before the
 * first navigation): each is kept with its frame (frameOfRequest), in
 * order, until `stop()`. The reading takes what came before it.
 * @param {import("playwright").Page} page
 */
export function watchRequests(page) {
  const records = [];
  let on = true;
  const onRequest = (req) => {
    if (on && records.length < 5000) records.push({ url: req.url(), frame: frameOfRequest(page, req) });
  };
  page.on("request", onRequest);
  return {
    records,
    stop() {
      on = false;
      page.off?.("request", onRequest);
    },
  };
}

/**
 * The reading on a capture's page as it now is, before anything is clicked
 * (makeReading on the browser's cookies, the requests so far and the page's
 * banner). When the site's own tracking was seen and no banner, it looks
 * once more after LATE_BANNER_MS, for a banner that slides in late. It takes
 * at most `limitMs` (READ_LIMIT_MS, or less when the capture has less time
 * left: `deadline`, the capture's own limit, less READ_MARGIN_MS); past it,
 * or with no time left, the reading is `unknown`. Never throws.
 * @param {import("playwright").Page} page
 * @param {{ records: object[] }} watch watchRequests's
 */
export async function readCookieCheck(page, watch, { region = captureRegion(), lateMs = LATE_BANNER_MS, limitMs = READ_LIMIT_MS, deadline = Infinity, now = Date.now } = {}) {
  const budget = Math.min(limitMs, deadline - now() - READ_MARGIN_MS);
  if (!(budget > 1000)) return makeReading({ error: "no time left in the capture for the cookie check", region });
  const until = now() + budget;
  const once = async () => {
    const cookies = (await page.context().cookies()).map(({ name, domain }) => ({ name, domain }));
    const dom = await page.evaluate(findConsent, consentArgs()).catch(() => null);
    return makeReading({ pageUrl: page.url(), cookies, requests: [...watch.records], dom, region });
  };
  const work = (async () => {
    const first = await once();
    if (first.state !== "no-consent" || lateMs <= 0 || now() + lateMs + 1000 > until) return first;
    await page.waitForTimeout(lateMs);
    return once();
  })();
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`took over ${Math.round(budget / 1000)}s`)), budget)))]);
  } catch (e) {
    work.catch(() => {});
    return makeReading({ error: `the cookies could not be read (${String(e?.message ?? e).slice(0, 120)})`, region });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The facts' privacy part with `readings` stored under their region: the
 * other regions' readings in `previous` (the stored facts.privacy) are kept,
 * so a reading made elsewhere is not lost when this runner captures again.
 */
export function withReading(previous, ...readings) {
  const old = previous && typeof previous === "object" && Number(previous.v) === PRIVACY_VERSION && previous.readings && typeof previous.readings === "object" ? previous.readings : {};
  const next = { ...old };
  for (const r of readings) if (r) next[r.region] = r;
  return { v: PRIVACY_VERSION, readings: next };
}
