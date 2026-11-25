// What a profile shows for the cookie check (pipeline/cookie-check.mjs): the
// stored reading of one vantage turned into one of three display levels, with
// one plain sentence. Pure; nothing here measures or writes.
//
// The owner's rule (2026-11-25): "tracking cookies itself is not something to
// fix, tracking cookies and not asking for permission to track cookies is
// something to fix."
//   pass         none: nothing tracked the visit;
//                after-consent: a consent banner was shown and nothing tracked the visit before a choice.
//   fix          with-banner: tracking started before the visitor answered the banner;
//                no-consent: tracking started and no banner asked.
//   information  unknown: the capture could not tell (the reason is kept).
// A site measured before the cookie check (facts without `privacy`), or with
// no reading from the vantage asked for, is not measured: null, never "no tracking".
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

const REGION_NAMES = { US: "the US", EU: "the EU", UK: "the UK" };
const regionName = (r) => REGION_NAMES[r] ?? r;

/** "A", "A and B", "A, B and C". */
const joined = (names) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The stored reading of `vantage` ("US", "US+eu-browser", later "EU") in a facts object (or its JSON), or null. */
export function cookieReading(facts, vantage = DEFAULT_REGION) {
  const privacy = parse(facts)?.privacy;
  if (!privacy || Number(privacy.v) !== PRIVACY_VERSION) return null;
  const r = privacy.readings?.[vantage];
  return r && typeof r === "object" && typeof r.state === "string" ? r : null;
}

/**
 * The cookie check as a profile shows it: { level: "pass" | "information" |
 * "fix", state, vantage, label, sentence, at }, or null when the site was not
 * measured from `vantage`. `facts` is portfolios.facts (an object or its
 * JSON). A no-consent reading whose European-browser-settings reading from
 * the same address did show a banner says so: the site asks some visitors.
 */
export function cookieCheckView(facts, vantage = DEFAULT_REGION) {
  const r = cookieReading(facts, vantage);
  if (!r) return null;
  const region = r.region ?? vantage;
  const where = r.vantage && r.vantage !== region ? `Checked from ${regionName(region)} with European browser settings.` : `Checked from ${regionName(region)}.`;
  const vendors = joined(Array.isArray(r.vendors) ? r.vendors : []) || "unnamed trackers";
  const cookieless = joined([...new Set((r.cookieless ?? []).map((c) => c.vendor).filter(Boolean))]);
  const tool = r.tool ? ` (${r.tool})` : "";
  const out = (level, sentence) => ({ level, state: r.state, vantage: r.vantage ?? vantage, label: r.label ?? null, sentence: `${sentence} ${where}`, at: r.at ?? null });
  switch (r.state) {
    case "none":
      return out("pass", cookieless ? `No tracking cookies or trackers; visits are counted with ${cookieless}, which sets no cookies.` : "No tracking cookies or trackers.");
    case "after-consent":
      return out("pass", `Asks before tracking: a cookie banner${tool} is shown and nothing tracks the visit before a choice.`);
    case "with-banner":
      return out("fix", `Tracking (${vendors}) starts before the visitor answers the cookie banner${tool}. Start it only after the visitor accepts.`);
    case "no-consent": {
      const eu = vantage === region ? cookieReading(facts, vantageOf(region, EU_SETTINGS).key) : null;
      const asksEurope = eu?.banner === true ? " A banner does appear for a browser set to European settings." : "";
      return out(
        "fix",
        `Tracks visitors without asking (${vendors}): no cookie banner was shown${r.tool ? `; ${r.tool} loaded but showed none` : ""}. Ask first, or use analytics that set no cookies.${asksEurope}`
      );
    }
    default:
      return out("information", `Could not tell whether the site asks before tracking${r.reason ? `: ${r.reason}` : ""}.`);
  }
}
