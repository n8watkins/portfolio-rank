// What a profile shows for the cookie check (pipeline/cookie-check.mjs): the
// stored reading of one region turned into a display level, a short title,
// one sentence stated as an observation ("On our visit on 25 Nov 2026 from
// the United States, ..."), and, for a fix, the recommendation for the
// profile's "What we recommend changing" list. Pure; nothing here measures or
// writes.
//
// The owner's rule (2026-11-25): "tracking cookies itself is not something to
// fix, tracking cookies and not asking for permission to track cookies is
// something to fix." The guiding rule of the reviews of #305: a wrong public
// claim is the costly error, a miss is cheap. So a fix needs the site's own
// evidence (a first-party tracking cookie, or a beacon from the page itself),
// never an ad's, an embed's or a widget's; and a sentence says only what was
// observed. The mapping (owner, 2026-11-25, as revised after the reviews):
//   fix          "Sets tracking cookies before asking permission" (a
//                first-party tracking cookie) or "Tracks visitors before
//                asking permission" (a beacon only): the site's own tracking
//                started on arrival, before anything was clicked, so before
//                asking, whether or not a banner exists. The second sentence is
//                exactly one of three: a strict cookie banner ("A cookie banner
//                was shown, but X had already started."), a loose hit with a
//                decision control ("A message about cookies was on the page, but
//                X had already started."), or anything else ("No cookie banner
//                offering a choice was found on the page."). The page's own
//                words are never quoted here; they stay in the stored reading;
//   information  "Tracks without asking visitors from the United States": the
//                same, but a consent tool is in the page's own code and showed
//                no banner to our visit (it may ask visitors from other
//                regions; the owner may make this a fix later);
//   pass         "No tracking cookies": no known tracker of the site's own ran;
//   information  "Asks before tracking": a strict cookie banner was shown and
//                nothing of the site's own tracked before a choice;
//   information  "Has a consent tool; banner not shown to a United States
//                visitor": a consent tool in the page's own code, no banner,
//                nothing tracked;
//   information  "Embeds YouTube, which sets its own cookies": an embed's
//                tracking cookies, with the advice that fits the embed;
//   information  "Tracking cookies from a third-party widget (LinkedIn)": a
//                third-party tracking cookie tied to no embed frame and no ad;
//   information  "Tracking seen from an ad on the page": an ad was served (an
//                ad frame or an ad-serving request) and set its own tracking;
//                "Advertising cookies from a third party" when only an ad
//                network's cookies were seen, with no ad served;
//   not-measured "Not measured": a capture from before the cookie check, a
//                reading that could not tell, or no reading from the region.
// Cookieless analytics (Plausible, Cloudflare Web Analytics...) are named as
// a note, never a fix. An ad's, an embed's or a widget's tracking beside a
// primary finding comes back in `notes`.
import { DEFAULT_REGION, EMBEDS, PRIVACY_VERSION, onHost } from "../pipeline/cookie-check.mjs";

const parse = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

const REGION_NAMES = { US: "the United States", EU: "the European Union", UK: "the United Kingdom" };
const regionName = (r) => REGION_NAMES[r] ?? r;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "25 Nov 2026" (UTC), or null. */
const dayOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/** "A", "A and B", "A, B and C". */
const joined = (names) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** Vendors whose tracking is analytics: a site can count visits without cookies instead. */
const ANALYTICS = /analytics|clarity|hotjar|posthog|mixpanel|amplitude|segment|heap|matomo|yandex|fullstory|hubspot|crazy egg|mouseflow|smartlook|lucky orange|vwo/i;

export const TITLES = {
  pass: "No tracking cookies",
  asks: "Asks before tracking",
  toolNoBanner: "Has a consent tool; banner not shown to a United States visitor",
  setsCookies: "Sets tracking cookies before asking permission",
  tracks: "Tracks visitors before asking permission",
  regionOnly: "Tracks without asking visitors from the United States",
  ad: "Tracking seen from an ad on the page",
  adCookies: "Advertising cookies from a third party",
  notMeasured: "Not measured",
};

/** The stored reading of `region` ("US", later "EU") in a facts object (or its JSON), or null. */
export function cookieReading(facts, region = DEFAULT_REGION) {
  const privacy = parse(facts)?.privacy;
  if (!privacy || Number(privacy.v) !== PRIVACY_VERSION) return null;
  const r = privacy.readings?.[region];
  return r && typeof r === "object" && typeof r.state === "string" ? r : null;
}

/** The advice that fits an embed: its privacy mode when it has one, else loading it on a click. */
function embedAdvice(host) {
  const e = EMBEDS.find((x) => onHost(host, x.host));
  return e?.privacy ? `Use ${e.privacy}, or load it only when the visitor clicks it.` : "Load it only when the visitor clicks to open it.";
}

/** The fix's one recommendation, true whatever was on the page: start it only after the visitor agrees. */
function recommendation(vendors) {
  const names = joined(vendors) || "the trackers";
  const analyticsOnly = vendors.length > 0 && vendors.every((v) => ANALYTICS.test(v));
  return `Start ${names} only after the visitor agrees${analyticsOnly ? ", or use analytics that set no cookies (such as Plausible or Cloudflare Web Analytics)" : ""}.`;
}

/**
 * The cookie check as a profile shows it, for one region ("US" by default).
 * Returns { level: "pass" | "information" | "fix" | "not-measured", kind,
 * title, sentence, recommendation (a fix's, else null), notes ([{ kind,
 * title, sentence }]: an embed's, a widget's or an ad's tracking beside the
 * main finding), region, at }. `facts` is portfolios.facts (an object or its
 * JSON).
 */
export function cookieCheckView(facts, region = DEFAULT_REGION) {
  const r = cookieReading(facts, region);
  const base = { region, at: r?.at ?? null, notes: [] };
  if (!r || !["none", "after-consent", "with-banner", "with-notice", "no-consent"].includes(r.state)) {
    return { ...base, level: "not-measured", kind: "not-measured", title: TITLES.notMeasured, sentence: "The cookie check has no reading of this site from this capture.", recommendation: null };
  }
  const day = dayOf(r.at);
  const where = regionName(r.region ?? region);
  const visit = `On our visit${day ? ` on ${day}` : ""} from ${where}`;
  const vendors = Array.isArray(r.vendors) ? r.vendors : [];
  const names = joined(vendors) || "a known tracker";
  const free = uniq((r.cookieless ?? []).map((c) => c.vendor));
  const freeNote = free.length ? ` Visits are counted with ${joined(free)}, which ${free.length === 1 ? "sets" : "set"} no cookies.` : "";
  const tool = r.tool ?? null;
  // An embed's, a widget's and an ad's tracking: never the site's own.
  const embedItems = (r.embeds ?? [])
    .filter((e) => e.cookies?.length)
    .map((e) => ({
      kind: "embed",
      title: `Embeds ${e.name}, which sets its own cookies`,
      sentence: `${visit}, the embedded ${e.name} set its own tracking cookies (${joined(uniq(e.cookies).slice(0, 4))}). ${embedAdvice(e.host)}`,
    }));
  const widgetVendors = uniq((r.widgets ?? []).map((w) => w.vendor));
  const widgetItem = widgetVendors.length
    ? {
        kind: "widget",
        title: `Tracking cookies from a third-party widget (${joined(widgetVendors)})`,
        sentence: `${visit}, a widget from ${joined(widgetVendors)} on the page set its own tracking cookies (${joined(uniq((r.widgets ?? []).map((w) => w.cookie)).slice(0, 4))}). Load it only when the visitor clicks to open it.`,
      }
    : null;
  const adVendors = uniq((r.ads ?? []).map((a) => a.vendor));
  const adItem = !adVendors.length
    ? null
    : r.ad_served
      ? { kind: "ad", title: TITLES.ad, sentence: `${visit}, an ad on the page (${joined(adVendors)}) ran its own tracking.` }
      : {
          kind: "ad-cookies",
          title: TITLES.adCookies,
          sentence: `${visit}, an advertising network (${joined(adVendors)}) set its own cookies (${joined(uniq((r.ads ?? []).map((a) => a.cookie)).slice(0, 4))}); no ad was seen being served.`,
        };
  const others = [...embedItems, ...(widgetItem ? [widgetItem] : []), ...(adItem ? [adItem] : [])];
  const out = (level, kind, title, sentence, rec = null, notes = others) => ({ ...base, level, kind, title, sentence, recommendation: rec, notes });

  // The site's own tracking started on arrival, before anything was clicked.
  if (["with-banner", "with-notice", "no-consent"].includes(r.state)) {
    const strict = r.banner === true;
    if (!strict && tool) {
      return out("information", "region-only", TITLES.regionOnly, `${visit}, ${names} tracked the visit and no banner was shown. ${tool} is in the page's code and may ask visitors from other regions.`);
    }
    const cookies = (r.own_cookies ?? []).length > 0;
    const started = cookies ? `${names} set tracking cookies on the site's own domain as the page loaded, before anything was clicked.` : `${names} tracked the visit as the page loaded, before anything was clicked.`;
    // Exactly one of three; the page's own words stay in the stored reading (banner_sample) for the admin, never here.
    const seen = strict
      ? ` A cookie banner was shown, but ${names} had already started.`
      : r.state === "with-notice" && r.notice_decision === true
        ? ` A message about cookies was on the page, but ${names} had already started.`
        : " No cookie banner offering a choice was found on the page.";
    return out("fix", cookies ? "sets-cookies" : "tracks", cookies ? TITLES.setsCookies : TITLES.tracks, `${visit}, ${started}${seen}`, recommendation(vendors));
  }
  if (r.state === "after-consent") {
    return out("information", "asks", TITLES.asks, `${visit}, a cookie banner${tool ? ` (${tool})` : ""} was shown and no known tracker of the site's own ran before a choice.${freeNote}`);
  }
  // none: nothing of the site's own tracked the visit.
  if (tool) return out("information", "tool-no-banner", TITLES.toolNoBanner, `${visit}, ${tool} is in the page's code, but no banner was shown and no known tracker ran.${freeNote}`);
  if (others.length) {
    const [first, ...rest] = others;
    return out("information", first.kind, first.title, first.sentence, null, rest);
  }
  return out("pass", "none", TITLES.pass, `${visit}, no known tracker ran and no tracking cookie was set.${freeNote}`, null, []);
}
