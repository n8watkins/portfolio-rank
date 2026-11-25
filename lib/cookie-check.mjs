// What a profile shows for the cookie check (pipeline/cookie-check.mjs): the
// stored reading of one vantage turned into a display level, a short title,
// one plain sentence and, for a fix, the recommendation for the profile's
// "What we recommend changing" list. Pure; nothing here measures or writes.
//
// The owner's rule (2026-11-25): "tracking cookies itself is not something to
// fix, tracking cookies and not asking for permission to track cookies is
// something to fix." His mapping (2026-11-25), case by case:
//   1. no tracking cookies and no tracker requests: pass, "No tracking cookies"
//      (cookieless analytics alone is this case, with a note; never a fix);
//   2. a consent tool or banner is shown and nothing tracked before a choice:
//      information, "Asks before tracking";
//   3. tracking started and no consent tool anywhere on the page: fix,
//      "Sets tracking cookies without asking";
//   4. a banner or consent tool is present but tracking started before any
//      choice: fix, "Tracks before you answer the banner";
//   5. a consent tool is in the page's code but no banner was shown to our
//      visit and nothing tracked: information, "Has a consent tool; banner not
//      shown to a United States visitor". Never a fix.
// A site measured before the cookie check (facts without `privacy`), a reading
// that failed (`unknown`), and a vantage with no reading are "not measured",
// never "no tracking".
import { DEFAULT_REGION, EU_SETTINGS, PRIVACY_VERSION, vantageOf } from "../pipeline/cookie-check.mjs";

const parse = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
};

/** The visitor a region's reading stands for, in the titles and sentences. */
const VISITOR = { US: "a United States visitor", EU: "a European visitor", UK: "a United Kingdom visitor" };
const visitorOf = (region) => VISITOR[region] ?? `a visitor from ${region}`;
const REGION_NAMES = { US: "the United States", EU: "the European Union", UK: "the United Kingdom" };
const regionName = (r) => REGION_NAMES[r] ?? r;

/** "A", "A and B", "A, B and C". */
const joined = (names) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export const TITLES = {
  pass: "No tracking cookies",
  asks: "Asks before tracking",
  noConsent: "Sets tracking cookies without asking",
  beforeChoice: "Tracks before you answer the banner",
  notMeasured: "Not measured",
};

export const RECOMMENDATIONS = {
  noConsent: "Ask visitors before setting tracking cookies, or switch to analytics that set no cookies (such as Plausible or Cloudflare Web Analytics).",
  beforeChoice: "Load tracking only after the visitor accepts the cookie banner, not before they answer it.",
};

/** The stored reading of `vantage` ("US", "US+eu-browser", later "EU") in a facts object (or its JSON), or null. */
export function cookieReading(facts, vantage = DEFAULT_REGION) {
  const privacy = parse(facts)?.privacy;
  if (!privacy || Number(privacy.v) !== PRIVACY_VERSION) return null;
  const r = privacy.readings?.[vantage];
  return r && typeof r === "object" && typeof r.state === "string" ? r : null;
}

/**
 * The cookie check as a profile shows it, for one vantage (the runner's
 * region "US" by default). Returns { level: "pass" | "information" | "fix" |
 * "not-measured", case (1 to 5, null when not measured), title, sentence,
 * recommendation (a fix's, else null), vantage, at }. `facts` is
 * portfolios.facts (an object or its JSON).
 */
export function cookieCheckView(facts, vantage = DEFAULT_REGION) {
  const r = cookieReading(facts, vantage);
  const base = { vantage, at: r?.at ?? null };
  if (!r || r.state === "unknown" || !["none", "after-consent", "with-banner", "no-consent"].includes(r.state)) {
    return { ...base, level: "not-measured", case: null, title: TITLES.notMeasured, sentence: r?.reason ? `The cookie check could not tell: ${r.reason}.` : "The cookie check has not run on this capture yet.", recommendation: null };
  }
  const region = r.region ?? vantage;
  const withEuSettings = r.vantage && r.vantage !== region;
  const where = withEuSettings ? `Checked from ${regionName(region)} with European browser settings.` : `Checked from ${regionName(region)}.`;
  const vendors = joined(Array.isArray(r.vendors) ? r.vendors : []) || "unnamed trackers";
  const freeNames = [...new Set((r.cookieless ?? []).map((c) => c.vendor).filter(Boolean))];
  const freeNote = freeNames.length ? ` Visits are counted with ${joined(freeNames)}, which ${freeNames.length === 1 ? "sets" : "set"} no cookies.` : "";
  const tool = r.tool ? ` (${r.tool})` : "";
  const out = (level, kase, title, sentence, recommendation = null) => ({ ...base, level, case: kase, title, sentence: `${sentence} ${where}`, recommendation });
  const tracked = r.state === "with-banner" || r.state === "no-consent";
  const asked = r.banner === true;
  if (!tracked) {
    if (asked) return out("information", 2, TITLES.asks, `A cookie banner${tool} is shown and nothing tracks the visit before a choice.${freeNote}`);
    if (r.tool) {
      const visitor = withEuSettings ? "a visit with European browser settings" : visitorOf(region);
      return out("information", 5, `Has a consent tool; banner not shown to ${visitor}`, `${r.tool} is in the page's code, but no banner was shown to this visit, and nothing tracked it.${freeNote}`);
    }
    return out("pass", 1, TITLES.pass, `No tracking cookies or trackers.${freeNote}`);
  }
  // The same address with European browser settings: a banner or a consent tool it met is on the page too.
  const eu = vantage === region ? cookieReading(facts, vantageOf(region, EU_SETTINGS).key) : null;
  if (asked || r.tool) {
    const how = asked ? `before the visitor answers the cookie banner${tool}` : `while ${r.tool} is in the page's code but showed no banner to this visit`;
    return out("fix", 4, TITLES.beforeChoice, `Tracking (${vendors}) starts ${how}.`, RECOMMENDATIONS.beforeChoice);
  }
  if (eu?.banner === true || eu?.tool) {
    const what = eu.banner === true ? `a cookie banner${eu.tool ? ` (${eu.tool})` : ""} appears only for a browser set to European settings` : `${eu.tool} appears only for a browser set to European settings`;
    return out("fix", 4, TITLES.beforeChoice, `Tracking (${vendors}) starts without a banner for this visit; ${what}.`, RECOMMENDATIONS.beforeChoice);
  }
  return out("fix", 3, TITLES.noConsent, `Tracks visitors without asking (${vendors}): no cookie banner or consent tool was found.`, RECOMMENDATIONS.noConsent);
}
