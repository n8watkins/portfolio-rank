// The redesigned profile's report (app/p/[slug]/next, the owner's "Banner"
// pick): what code measured about a portfolio, card by card, and "What we
// recommend changing", made from exactly the findings the cards show. Pure:
// no request, no model. Only what the product measures today is here, from
// the same saved checks the automated checks read (lib/tiers-store.mjs
// checkSources):
//
//   inspect   the polish fetch (cache inspect:<url>, app/api/inspect): share
//             image, search description, HTTPS and own domain, resume,
//             contact, GitHub, footer year
//   facts     the capture's measured facts (portfolios.facts, pipeline/facts.mjs):
//             resume, GitHub, contact, project links, footer year, site builder,
//             and the cookie check's reading (facts.privacy, lib/cookie-check.mjs)
//   psi       one Lighthouse run on mobile (cache psi:<url>, lib/tools/psi.ts)
//
// No score and no points: a presence check reads yes or no, a measured thing
// shows its number. A fact nobody measured is left out, never shown as a
// placeholder, and a card with nothing measured is left out with it.
//
// Adding a card: write a builder (below) that returns
//   { id, name, kind, wide?, data, findings: [{ fix, prompt }] }
// and add it to CARD_BUILDERS; the page draws it with the body for its
// `kind` (components/profile-next/ProfileNext.tsx CardBody). Each finding is one
// thing to fix: the card's "N things to fix" counts them, and their `fix`
// and `prompt` sentences become the recommendations, in card order.
//
// When something was measured is the time its row was saved: the cache
// table's `at` for the polish check and Lighthouse (lib/cache.ts; the saved
// value itself carries no time), and the facts' own `measured_at`.
import { MIN_PROJECT_LINKS, newProjectRule, projectLinksPass, projectLinksText } from "../../pipeline/facts.mjs";
import { STALE_FOOTER_YEARS } from "../../pipeline/rubric.mjs";
import { cookieCheckView } from "../cookie-check.mjs";

/**
 * One card of the report: `kind` picks how the page draws `data`; each finding is one thing to fix.
 * `notice`: what the card notes that is not a fix (shown in place of "Nothing to fix").
 * @typedef {{ id: string, name: string, kind: string, data: Record<string, any>, findings: { fix: string, prompt: string }[], notice?: string | null }} Card
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Nov 2026" for an ISO time or a ms timestamp (UTC), or null. */
export function dayOf(t) {
  const ms = typeof t === "number" ? t : Date.parse(String(t ?? ""));
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url ?? "");
  }
};

/** The first boolean among the values, or null. */
const bool = (...vs) => {
  for (const v of vs) if (typeof v === "boolean") return v;
  return null;
};

/** PageSpeed Insights for an address, on mobile: where "Run this test yourself" goes. */
export const pageSpeedUrl = (url) => `https://pagespeed.web.dev/analysis?url=${encodeURIComponent(url)}&form_factor=mobile`;

/** A Lighthouse score's state: 90 and up is good, 50 to 89 needs work, under 50 is poor. */
export const scoreState = (n) => (n >= 90 ? "yes" : n >= 50 ? "warn" : "no");

// ---------------------------------------------------------------- Basics

/**
 * The presence checks: each { id, label, chip, value, st, explain }, `st`
 * "yes" or "no" ("info" for a fact that is not a fault). GitHub is a button in
 * the header when found, so it is listed here only when it is missing.
 */
function basicsCard({ inspect, facts, now }) {
  const ins = inspect?.ok === true ? inspect : null;
  const items = [];
  const findings = [];
  const add = (item, finding) => {
    items.push(item);
    if (finding) findings.push(finding);
  };

  const github = bool(facts?.github, ins ? Boolean(ins.githubUrl || ins.hasGithubLink) : null);
  if (github === false)
    add(
      { id: "github", icon: "github", label: "GitHub link", chip: "GitHub link", value: "None found", st: "no", explain: "No link to a GitHub profile was found on the home page." },
      {
        fix: "Link your GitHub profile from the home page.",
        prompt: "Link my GitHub profile. No link to a GitHub profile (github.com/<user>) was found on the home page. Add one in the navigation or the footer. Done when it is on the home page.",
      },
    );

  const resume = bool(facts?.resume, ins?.hasResume);
  if (resume != null)
    add(
      { id: "resume", icon: "resume", label: "Resume", chip: "Resume", value: resume ? "Yes" : "None found", st: resume ? "yes" : "no", explain: resume ? "A link to a resume or CV is on the home page." : "No link to a resume or CV was found on the home page." },
      resume
        ? null
        : {
            fix: "Link your resume from the home page.",
            prompt: "Link my resume. No link to a resume or CV was found on the home page. Add one in the navigation or the hero, to a PDF or a page. Done when a link whose text or address says resume or CV is on the home page.",
          },
    );

  const contact = bool(facts?.contact, ins ? Boolean(ins.hasContact || ins.linkedinUrl) : null);
  if (contact != null)
    add(
      { id: "contact", icon: "mail", label: "A way to reach them", chip: "A way to reach them", value: contact ? "Yes" : "None found", st: contact ? "yes" : "no", explain: contact ? "An email link, a contact form or a LinkedIn link is on the home page." : "No email link, contact form or LinkedIn link was found on the home page." },
      contact
        ? null
        : {
            fix: "Add a way to reach you: an email link, a contact form or LinkedIn.",
            prompt: "Add a way to reach me. No email link, contact form or LinkedIn link was found on the home page. Add a mailto: link or a contact form. Done when it is on the home page.",
          },
    );

  if (ins) {
    const loads = ins.ogImageLoads === true;
    const named = Boolean(ins.ogImage);
    add(
      {
        id: "share",
        icon: "image",
        label: "Share image",
        chip: "Share image",
        value: loads ? "Yes" : named ? "Does not load" : "None",
        st: loads ? "yes" : "no",
        explain: loads
          ? "The picture shown when the link is posted."
          : named
            ? "The page names a share image, but it does not load, so links to this site look bare on social media and in chat."
            : "The picture shown when the link is posted. Without one, links to this site look bare on social media and in chat.",
      },
      loads
        ? null
        : {
            fix: named ? "Fix the share image: the page names one, but it does not load." : "Add a share image, the picture shown when the link is posted.",
            prompt: named
              ? `Fix the share image. The home page's og:image (${ins.ogImage}) does not load, so links to it look bare when posted. Serve a 1200 by 630 px PNG or JPG at that address, or point og:image and twitter:image at one that loads. Done when the image loads.`
              : "Add a share image. The home page has no Open Graph image, so links to it look bare when posted. Create a 1200 by 630 px PNG or JPG, serve it from the site, and add <meta property=\"og:image\"> and <meta name=\"twitter:image\"> tags pointing at it to the <head> of the home page. Done when both tags are in the page source and the image loads.",
          },
    );

    const described = Boolean(ins.description);
    add(
      { id: "desc", icon: "search", label: "Search description", chip: "Search description", value: described ? "Yes" : "None", st: described ? "yes" : "no", explain: described ? "The summary search engines show under the title." : "The summary search engines show under the title. Without one, search engines pick some text from the page themselves." },
      described
        ? null
        : {
            fix: "Add a search description (<meta name=\"description\">).",
            prompt: "Add a search description. The home page has no <meta name=\"description\">. Add one to the <head>: 120 to 160 characters saying who I am and what I build. Done when it is in the page source.",
          },
    );
  }

  const own = ins ? bool(ins.customDomain) : bool(facts?.own_domain);
  const https = ins ? bool(ins.https) : typeof facts?.final_url === "string" ? facts.final_url.startsWith("https:") : null;
  if (own != null && https != null) {
    const ok = own && https;
    const host = hostOf(ins?.finalUrl ?? facts?.final_url ?? "");
    add(
      {
        id: "domain",
        icon: "lock",
        label: "Own domain, secure",
        chip: "Own domain, secure",
        value: ok ? "Yes" : !own ? "Shared host" : "Not secure",
        st: ok ? "yes" : "no",
        explain: ok ? "Its own address, served over HTTPS." : !own ? `It is on a shared host's address (${host}).` : "It is not served over HTTPS.",
      },
      ok
        ? null
        : !https
          ? {
              fix: "Serve the site over HTTPS.",
              prompt: "Serve my portfolio over HTTPS. The home page does not load over HTTPS. Turn on HTTPS at the host and redirect http:// to https://. Done when the address opens over https:// with a valid certificate.",
            }
          : {
              fix: "Move the site to a domain of your own.",
              prompt: `Move my portfolio to a domain of my own. It is on a shared host's address (${host}). Buy a short domain (my name, for example), point it at the host and keep HTTPS on. Done when the site opens at the new domain over HTTPS.`,
            },
    );
  }

  const year = typeof facts?.footer_year === "number" ? facts.footer_year : typeof ins?.copyrightYear === "number" ? ins.copyrightYear : null;
  // null is measured, with no year found; a missing key was never measured.
  const yearMeasured = (facts != null && facts.footer_year !== undefined) || (ins != null && ins.copyrightYear !== undefined);
  if (yearMeasured) {
    const current = now.getUTCFullYear();
    // The rubric's rule (pipeline/rubric.mjs codeChecks fresh_footer): stale when more than STALE_FOOTER_YEARS old.
    const fresh = year == null || current - year <= STALE_FOOTER_YEARS;
    add(
      {
        id: "year",
        icon: "calendar",
        label: "Footer year",
        chip: year == null ? "Footer year: not shown" : `Footer year: ${year}`,
        value: year == null ? "Not shown" : String(year),
        st: year == null ? "info" : fresh ? "yes" : "no",
        explain: year == null ? "No year in the footer, which is fine." : fresh ? "A current year in the footer." : `The footer says ${year}, so the site looks unattended.`,
      },
      fresh
        ? null
        : {
            fix: `Update the footer year (it says ${year}).`,
            prompt: `Update the footer year. The footer says ${year}. Show the current year, or drop the year. Done when the footer shows ${current} or no year.`,
          },
    );
  }

  const tracking = trackingItem(facts);
  if (tracking) add(tracking.item, tracking.finding);

  if (!items.length) return null;
  return { id: "basics", name: "Basics", kind: "basics", data: { items }, findings };
}

// The chip for each thing the cookie check can show (lib/cookie-check.mjs cookieCheckView `kind`). Only the
// site's own tracking that started before a choice is a fault; a site that asks first reads as a yes; an
// embed's, a widget's or an ad's cookies, and a consent tool that showed no banner, are information.
const TRACKING_CHIP = {
  none: ["No tracking", "yes"],
  asks: ["Asks before tracking", "yes"],
  "sets-cookies": ["Tracks before asking", "no"],
  tracks: ["Tracks before asking", "no"],
  "region-only": ["Tracks without asking", "info"],
  "tool-no-banner": ["No tracking seen", "info"],
  embed: ["Cookies from an embed", "info"],
  widget: ["Cookies from a widget", "info"],
  ad: ["Tracking from an ad", "info"],
  "ad-cookies": ["Advertising cookies", "info"],
};

/**
 * The Basics row for tracking, from the capture's cookie check: a reading
 * taken on arrival, before anything was clicked, on a visit from the United
 * States. Null when the site has no reading (never a placeholder). The owner's
 * rule (2026-11-25): tracking is not a fault, tracking before asking is. The
 * sentences are the cookie check's own, stated as what was observed on that
 * visit; nothing here says a law was broken.
 */
function trackingItem(facts) {
  const view = cookieCheckView(facts);
  const chip = TRACKING_CHIP[view.kind];
  if (view.level === "not-measured" || !chip) return null;
  const explain = [view.sentence, ...view.notes.map((n) => n.sentence)].join(" ");
  const item = { id: "tracking", icon: "cookie", label: "Tracking", chip: chip[0], value: view.title, st: chip[1], explain };
  if (view.level !== "fix") return { item, finding: null };
  return {
    item,
    finding: {
      fix: `Ask before tracking visitors: ${view.recommendation.charAt(0).toLowerCase()}${view.recommendation.slice(1)}`,
      prompt: `Ask before tracking visitors. ${view.sentence} ${view.recommendation} Done when no tracker runs and no tracking cookie is set until the visitor has agreed.`,
    },
  };
}

// ---------------------------------------------------------------- Projects

const num = (v) => Number(v) || 0;
const sentence = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;

/**
 * The project links the capture checked, in the product's own words and
 * counting (pipeline/facts.mjs projectLinksText and projectLinksPass, as the
 * current profile reads them): links a site turned away are left out of the
 * total and named, as are the site's own pages that could not be verified and
 * links that were not counted. The links themselves are not stored (checkLinks
 * keeps the counts), so the card shows counts. "Built with" when a site
 * builder was recognised.
 */
function projectsCard({ facts }) {
  const links = facts?.project_links;
  const has = links && typeof links === "object" && typeof links.checked === "number";
  const builder = typeof facts?.builder === "string" && facts.builder ? facts.builder : null;
  if (!has && !builder) return null;
  const findings = [];
  /** @type {string | null} */
  let notice = null;
  let data = { links: null, builtWith: builder };
  if (has) {
    const rule = newProjectRule(facts.v);
    const ok = num(links.ok);
    // Under the current rule a link behind a bot check is neither loading nor failing: out of the total.
    const tested = rule ? links.checked - num(links.blocked) : links.checked;
    const bad = Math.max(0, tested - ok);
    const [headline, ...notes] = String(projectLinksText(links, facts.v)).split("; ");
    const pass = projectLinksPass(links, facts.v);
    data = { links: { ok, bad, headline, notes: notes.map(sentence), rule, min: MIN_PROJECT_LINKS }, builtWith: builder };
    // Enough links load for the product's rule, but a tested one does not: information, not a fix, and never
    // "Nothing to fix" beside a red mark.
    if (pass === true && bad > 0) notice = `${bad} ${bad === 1 ? "link does" : "links do"} not load`;
    const where = "on the home page and its projects page";
    if (pass === false && links.checked === 0) {
      const others = num(links.not_counted);
      findings.push({
        fix: `Link at least ${MIN_PROJECT_LINKS} projects, each to a live demo or its repository.`,
        prompt: `Link my projects. No project links were found in a projects section ${where}${others ? ` (${others} other ${others === 1 ? "link" : "links"} on the page ${others === 1 ? "was" : "were"} not counted, as they are not in a projects section)` : ""}. Link at least ${MIN_PROJECT_LINKS} projects in a projects section, each to a live demo or its repository. Done when at least ${MIN_PROJECT_LINKS} project links load.`,
      });
    } else if (pass === false && bad > 0) {
      findings.push({
        fix: `Fix or remove the ${bad === 1 ? "project link that does" : `${bad} project links that do`} not load.`,
        prompt: `Fix the project links that do not load. ${bad} of the ${tested} project links checked ${where} did not load (a 404, a server error, an empty page or no answer within 8 seconds). Open each project link there, then fix or remove the ones that fail.${rule ? ` Done when at least ${MIN_PROJECT_LINKS} project links load and none fails.` : " Done when every project link loads."}`,
      });
    } else if (pass === false) {
      findings.push({
        fix: `Link more projects: ${ok} load, and ${MIN_PROJECT_LINKS} is the least that counts.`,
        prompt: `Link more projects. Only ${ok} project link${ok === 1 ? "" : "s"} ${where} load${ok === 1 ? "s" : ""}. Link at least ${MIN_PROJECT_LINKS} projects, each to a live demo or its repository. Done when at least ${MIN_PROJECT_LINKS} project links load.`,
      });
    }
  }
  return { id: "projects", name: "Projects", kind: "projects", data, findings, notice };
}

// ---------------------------------------------------------------- Lighthouse

const LIGHTHOUSE_ROWS = [
  { key: "accessibility", label: "Accessibility", def: "Labels, contrast, order." },
  { key: "seo", label: "Search", def: "Can search engines read it." },
  { key: "best-practices", label: "Best practices", def: "Safe, current web code." },
];

/** One Lighthouse run on mobile: speed as the ring, the other scores under it. */
function mobileCard({ url, psi, psiAt }) {
  const scores = psi?.ok === true ? psi.scores ?? {} : null;
  const speed = typeof scores?.performance === "number" ? Math.round(scores.performance) : null;
  if (speed == null) return null;
  const rows = LIGHTHOUSE_ROWS.filter((r) => typeof scores[r.key] === "number").map((r) => ({ ...r, value: Math.round(scores[r.key]), st: scoreState(Math.round(scores[r.key])) }));
  const findings = [];
  if (speed < 90)
    findings.push({
      fix: `Speed up the page on mobile: Lighthouse gives it ${speed} of 100.`,
      prompt: `Speed up the page on mobile. Its Lighthouse mobile performance is ${speed} of 100. Run Lighthouse on mobile (${pageSpeedUrl(url)}) and fix the largest issues it lists, aiming for 90 or more.`,
    });
  for (const r of rows) {
    if (r.value >= 90) continue;
    const what = r.key === "seo" ? "search" : r.label.toLowerCase();
    findings.push({
      fix: `Raise ${what} on mobile: Lighthouse gives it ${r.value} of 100.`,
      prompt: `Fix the ${what} issues Lighthouse lists on mobile. Its ${what} score is ${r.value} of 100. Run Lighthouse on mobile (${pageSpeedUrl(url)}) and fix what it lists under ${r.label}, aiming for 90 or more.`,
    });
  }
  return {
    id: "mobile",
    name: "Mobile",
    kind: "lighthouse",
    data: { speed, speedState: scoreState(speed), rows, measuredOn: dayOf(psiAt), testUrl: pageSpeedUrl(url) },
    findings,
  };
}

/** The cards, in the order they show. */
export const CARD_BUILDERS = [basicsCard, projectsCard, mobileCard];

/**
 * The whole report: `cards` (each with `fixes`, how many things it found to
 * fix), `recommendations` (one sentence each, in card order), `prompt` (the
 * same list ready to paste into an AI coding tool) and `checkedOn`, the day
 * of the newest measurement shown. `inspectAt` and `psiAt` are when those
 * results were saved (ms, the cache row's `at`).
 * @param {{ url: string, inspect?: any, facts?: any, psi?: any, inspectAt?: number | null, psiAt?: number | null, now?: Date }} input
 */
export function profileReport({ url, inspect = null, facts = null, psi = null, inspectAt = null, psiAt = null, now = new Date() }) {
  const input = { url, inspect, facts, psi, psiAt, now };
  /** @type {(Card & { fixes: number })[]} */
  const cards = [];
  for (const build of CARD_BUILDERS) {
    const c = build(input);
    if (c) cards.push({ ...c, fixes: c.findings.length });
  }
  const findings = cards.flatMap((c) => c.findings);
  // Only the measurements the cards show count.
  const shown = new Set(cards.map((c) => c.id));
  const times = [
    shown.has("basics") && inspect?.ok === true ? inspectAt : null,
    (shown.has("basics") || shown.has("projects")) && facts ? Date.parse(String(facts.measured_at ?? "")) : null,
    shown.has("mobile") ? psiAt : null,
  ].filter((t) => typeof t === "number" && Number.isFinite(t));
  const checkedOn = times.length ? dayOf(Math.max(...times)) : null;
  return {
    cards,
    checkedOn,
    recommendations: findings.map((f) => f.fix),
    prompt: fixPrompt({ url, checkedOn, items: findings.map((f) => f.prompt) }),
  };
}

/**
 * The recommendations as a prompt for an AI coding tool: what was checked,
 * when, and each change with what "done" looks like.
 * @param {{ url: string, checkedOn: string | null, items: string[] }} p
 */
export function fixPrompt({ url, checkedOn, items }) {
  const addr = String(url).replace(/\/$/, "");
  const head = `My portfolio at ${addr} was checked${checkedOn ? ` on ${checkedOn}` : ""}. Please make the changes below in its code. Each says what was found and what done looks like. Do not change anything else, and tell me which files you changed.`;
  return `${head}\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n\n") || "Nothing was found to fix."}`;
}
