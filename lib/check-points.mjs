// Points from automated checks (owner decision 2026-11-12): a 100-point
// rubric over data we already saved, no AI request. It sets each graded
// portfolio's starting rank (lib/tiers-store.mjs seeds its rating from its
// place by points), so tier letters appear at once; real votes then refine
// the rating. It also feeds the fix list ("+5 if you add a share image").
//
// Sources, all saved before:
//   psi           Lighthouse on mobile (cache psi:<url>): performance, accessibility, SEO, best practices
//   psiDesktop    Lighthouse on desktop (cache psi-desktop:<url>): performance
//   inspect       the polish fetch (cache inspect:<url>): share card, HTTPS, own domain, links, footer year
//   grade         the stored grade (portfolios.ai_rubric): its code checks and facts (project links)
//   meta          the capture (portfolios.meta): fits a phone, console errors
//
// A missing measurement (no Lighthouse yet, no capture) is never scored as
// zero: the item gets the library's median for it and is marked "not
// measured". When nobody in the library has it, every portfolio gets the
// same neutral value, so it never changes the order. Pure.
//
// Using or copying a template is not a fault (owner, 2026-11-13: we grade
// the portfolio, not its origin), so it costs no points. The template is
// still detected and kept as a fact (pipeline/facts.mjs).

/** The owner's points (they add up to 100). Change them here. */
export const CHECK_POINTS = {
  perfMobile: 15,
  perfDesktop: 10,
  accessibility: 10,
  seoBest: 10,
  shareText: 5,
  shareImage: 5,
  projects: 15,
  resume: 5,
  github: 5,
  contact: 5,
  domain: 5,
  phone: 7,
  footer: 3,
};

/** The fewest projects with working links for full project points. */
export const MIN_PROJECTS = 3;

/** Each item: its name, and the fix it suggests when it falls short. */
export const CHECK_ITEMS = [
  { id: "perfMobile", name: "Speed on phones (Lighthouse)", fix: "make the page faster on phones" },
  { id: "perfDesktop", name: "Speed on desktop (Lighthouse)", fix: "make the page faster on desktop" },
  { id: "accessibility", name: "Accessibility (Lighthouse)", fix: "fix the accessibility issues Lighthouse lists" },
  { id: "seoBest", name: "SEO and best practices (Lighthouse)", fix: "fix the SEO and best-practice issues Lighthouse lists" },
  { id: "shareText", name: "Share card title and description", fix: "add a share title and description" },
  { id: "shareImage", name: "Share card image", fix: "add a share image" },
  { id: "projects", name: `Working project links (at least ${MIN_PROJECTS} projects)`, fix: `link at least ${MIN_PROJECTS} projects that load` },
  { id: "resume", name: "Resume", fix: "link your resume" },
  { id: "github", name: "GitHub", fix: "link your GitHub" },
  { id: "contact", name: "Contact or LinkedIn", fix: "add a way to reach you" },
  { id: "domain", name: "Own domain and HTTPS", fix: "use your own domain over HTTPS" },
  { id: "phone", name: "Fits a phone, no console errors", fix: "make it fit a phone screen and fix console errors" },
  { id: "footer", name: "Current footer year", fix: "update the footer year" },
];

const ok = (v) => v && typeof v === "object" && v.ok === true;
const score = (v, k) => (ok(v) && typeof v.scores?.[k] === "number" ? v.scores[k] : null);
const bool = (...vs) => {
  for (const v of vs) if (typeof v === "boolean") return v;
  return null;
};

/** Each item's share of its points, 0 to 1, or null when it wasn't measured. */
export function checkShares({ psi = null, psiDesktop = null, inspect = null, grade = null, meta = null, year = new Date().getUTCFullYear() } = {}) {
  const checks = grade?.checks ?? {};
  const facts = grade?.facts ?? {};
  const pm = score(psi, "performance");
  const pd = score(psiDesktop, "performance");
  const a11y = score(psi, "accessibility");
  const seo = score(psi, "seo");
  const best = score(psi, "best-practices");
  const ins = ok(inspect) ? inspect : null;
  const links = facts.project_links;
  const footerYear = typeof facts.footer_year === "number" ? facts.footer_year : ins ? ins.copyrightYear : undefined;
  const half = (x, y) => (x == null && y == null ? null : ((x ?? 0) + (y ?? 0)) / 2);
  return {
    perfMobile: pm == null ? null : pm / 100,
    perfDesktop: pd == null ? null : pd / 100,
    accessibility: a11y == null ? null : a11y / 100,
    seoBest: seo == null && best == null ? null : ((seo ?? best) + (best ?? seo)) / 200,
    shareText: ins ? half(ins.ogTitle || ins.title ? 1 : 0, ins.ogDescription || ins.description ? 1 : 0) : null,
    shareImage: ins ? (ins.ogImageLoads === true ? 1 : 0) : null,
    projects: links && typeof links.checked === "number" ? (links.checked > 0 ? (links.ok / links.checked) * Math.min(1, links.checked / MIN_PROJECTS) : 0) : null,
    resume: toShare(bool(checks.resume, ins?.hasResume)),
    github: toShare(bool(checks.github, ins ? Boolean(ins.githubUrl || ins.hasGithubLink) : null)),
    contact: toShare(bool(checks.contact, ins ? Boolean(ins.hasContact || ins.linkedinUrl) : null)),
    domain: ins ? half(ins.customDomain === true ? 1 : 0, ins.https === true ? 1 : 0) : toShare(bool(checks.own_domain)),
    phone: meta && (typeof meta.overflow390 === "boolean" || typeof meta.consoleErrors === "number") ? half(meta.overflow390 === false ? 1 : 0, meta.consoleErrors === 0 ? 1 : 0) : null,
    // No year in the footer is not a stale one (as the polish checklist counts it).
    footer: footerYear === undefined ? toShare(bool(checks.fresh_footer)) : footerYear == null || footerYear >= year - 1 ? 1 : 0,
  };
}

const toShare = (b) => (b == null ? null : b ? 1 : 0);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The library's median share of each item among the portfolios where it was
 * measured: { item: share }. An item nobody has gets a neutral value (half
 * the points), the same for everyone.
 */
export function libraryMedians(shareList) {
  const out = {};
  for (const { id } of CHECK_ITEMS) {
    const m = median(shareList.map((s) => s[id]).filter((v) => typeof v === "number"));
    out[id] = m ?? 0.5;
  }
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * The points: { total, items: [{ id, name, points, max, measured, gain, fix }] }.
 * `gain` is what fixing the item fully would add (0 when it is full).
 */
export function checkPoints(shares, medians) {
  const items = CHECK_ITEMS.map(({ id, name, fix }) => {
    const weight = CHECK_POINTS[id];
    const measured = typeof shares[id] === "number";
    const share = measured ? shares[id] : medians[id];
    const points = round1(weight * share);
    return { id, name, points, max: weight, measured, gain: round1(weight - points), fix };
  });
  return { total: round1(items.reduce((s, i) => s + i.points, 0)), items };
}

/**
 * A breakdown as stored with a rank ([item, points, measured] rows,
 * lib/tiers-store.mjs) back in checkPoints' shape, or null. Rows for items
 * no longer scored (the old template penalty) are left out of it and its total.
 */
export function unpackCheck(rows) {
  if (!Array.isArray(rows)) return null;
  const byId = new Map(rows.filter((r) => Array.isArray(r)).map(([id, points, measured]) => [id, { points: Number(points) || 0, measured: Boolean(measured) }]));
  const items = CHECK_ITEMS.filter(({ id }) => byId.has(id)).map(({ id, name, fix }) => {
    const { points, measured } = byId.get(id);
    const weight = CHECK_POINTS[id];
    return { id, name, points, max: weight, measured, gain: round1(weight - points), fix };
  });
  return { total: round1(items.reduce((s, i) => s + i.points, 0)), items };
}

/**
 * The fixes worth the most points first: "+5 if you add a share image". Measured items only.
 * @param {{ items: { id: string, measured: boolean, gain: number, fix: string }[] }} points
 * @param {number} [limit]
 * @returns {{ id: string, gain: number, text: string }[]}
 */
export function pointFixes(points, limit = 3) {
  return points.items
    .filter((i) => i.measured && i.gain >= 1)
    .sort((a, b) => b.gain - a.gain)
    .slice(0, limit)
    .map((i) => ({ id: i.id, gain: i.gain, text: `+${Math.round(i.gain)} if you ${i.fix}` }));
}
