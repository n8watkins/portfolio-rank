// Code-only junk detection rules (no AI, no fetches).
// Each rule is a pure function over the stored row fields:
// url, name, page_text and facts (signals, words, template, project_links, github, contact).
// Rule (b) also needs a duplicate index built once from every row in the DB.
import { createHash } from "node:crypto";

// (a) Strings that only appear on unedited starter templates.
// The first two come from the experiment brief; the rest are generic starter copy.
export const TEMPLATE_STRINGS = [
  /build your ai portfolio/i,
  /hey,? i'?m aaaaby/i,
  /\bthis is a template\b/i,
  /\bportfolio template by\b/i,
  /\breplace this (text|with)\b/i,
  /\byour (bio|tagline|description) (goes )?here\b/i,
];

// (c) Placeholder names.
export const PLACEHOLDER_NAMES = [
  /\baaaa+by\b/i,
  /\bjohn doe\b/i,
  /\bjane doe\b/i,
  /\byour name( here)?\b/i,
  /\blorem ipsum\b/i,
  /\bfirst ?name last ?name\b/i,
  /\bjohn smith\b/i,
  /\bdolor sit amet\b/i,
];

// (d) Parked, expired or for-sale wording.
export const PARKED = [
  /\bdomain (name )?(is|may be) for sale\b/i,
  /\bbuy this domain\b/i,
  /\bparked\b/i,
  /\bthis domain has expired\b/i,
  /\bget this domain\b/i,
  /\bhugedomains\b/i,
  /\bmake an offer on this domain\b/i,
];
const COMING_SOON = /\b(coming soon|under construction)\b/i;

export const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return String(url);
  }
}

/** Lowercase letters only, so clocks, dates and counters do not split a copy. */
export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

const MIN_DUP_WORDS = 20; // shorter texts ("Loading", "Home About") collide by chance

/** (b) Index: normalised page_text hash -> set of hosts, over all rows. */
export function buildDupIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    if (!r.page_text) continue;
    const n = normalise(r.page_text);
    if (words(n) < MIN_DUP_WORDS) continue;
    const h = createHash("sha1").update(n).digest("hex");
    if (!idx.has(h)) idx.set(h, new Set());
    idx.get(h).add(hostOf(r.url));
  }
  return idx;
}

function dupHit(row, idx) {
  if (!row.page_text) return false;
  const n = normalise(row.page_text);
  if (words(n) < MIN_DUP_WORDS) return false;
  const hosts = idx.get(createHash("sha1").update(n).digest("hex"));
  return Boolean(hosts && [...hosts].some((h) => h !== hostOf(row.url)));
}

const heading = (row) => `${row.name ?? ""}\n${String(row.page_text ?? "").slice(0, 300)}`;

/** Runs every rule on one row. Returns { a, b, c, d, e, strong, junk, evaluable }. */
export function classify(row, dupIndex) {
  const text = String(row.page_text ?? "");
  const f = row.facts && typeof row.facts === "object" ? row.facts : null;
  const n = f?.words ?? words(text);
  const evaluable = Boolean(text || f);
  const a = Boolean(f?.template) || TEMPLATE_STRINGS.some((re) => re.test(text));
  const b = dupHit(row, dupIndex);
  const c = PLACEHOLDER_NAMES.some((re) => re.test(heading(row)));
  const d = PARKED.some((re) => re.test(text)) || (COMING_SOON.test(text) && n < 50);
  // "No outbound links" from stored facts: no checked project link, no GitHub link,
  // no contact link (mailto, LinkedIn, X, contact form).
  const noLinks = Boolean(f) && !(f.project_links?.checked > 0) && !f.github && !f.contact;
  const e = evaluable && n < 30 && noLinks;
  const strong = (f?.signals?.score ?? 0) >= 4;
  // (f) the strong-signals guard: score >= 4 is real unless (a) to (d) hit.
  const junk = a || b || c || d || (e && !strong);
  return { a, b, c, d, e, strong, junk, evaluable };
}
