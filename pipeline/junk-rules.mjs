// The narrow code rules for "not a portfolio" that need no AI (from the
// junk-detection experiment, PR #212, experiments/junk-detection: rules.mjs
// recommend(), results.md). Only exact strings that never hit a real site in
// the whole-database audit; no word-count rule and no facts.template, which
// both caught real, sparse or gated portfolios.
//
//   junk    an unedited placeholder: a demo persona or placeholder name in
//           the heading (Aaaaby, John Doe, Jane Doe, Your Name), or template
//           promo text ("Build your AI portfolio") standing in for content on
//           a page that shows none of the person's own work; an exact parked
//           or for-sale phrase; or a listed address that is a code host, a
//           link-in-bio page or an admin or login path
//
// Templates are fine (owner, 2026-11-13): using or copying a template is
// never junk and never a penalty, and a real portfolio that offers itself as
// a template ("Get this portfolio as a template") is a portfolio. Only the
// unedited placeholder content counts.
//   review  the same page text (20 words or more) on another domain: a copy,
//           or the original; a person or the AI decides which
//
// Rows are { url, name, page_text, has_work? } from the portfolios table, the
// page text from a fresh capture. has_work (the page shows projects or
// project links) must be false for promo text to count; unknown is never junk.
import { createHash } from "node:crypto";

const PLACEHOLDER = [/\baaaa+by\b/i, /\bjohn doe\b/i, /\bjane doe\b/i, /\byour name\b/i];
const PROMO = [/build your ai portfolio/i];
const PARKED = [/\bhas expired and is parked\b/i, /\bdomain (name )?(is|may be) for sale\b/i, /\bbuy this domain\b/i, /\bmake an offer on this domain\b/i];
const MIN_DUP_WORDS = 20;

const words = (text) => String(text ?? "").split(/\s+/).filter(Boolean).length;

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return String(url);
  }
}

/** Letters only, lower case, so clocks, dates and counters don't split a copy. */
function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}]+/gu, " ")
    .trim();
}

const hashOf = (text) => createHash("sha1").update(normalise(text)).digest("hex");

/** A code host, a link-in-bio page, or an admin or login path: never a portfolio. */
export function urlNotPortfolio(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  if (/^(github\.com|gitlab\.com|linktr\.ee|bio\.link|beacons\.ai)$/.test(h)) return true;
  return /\/(admin|login|wp-admin)(\/|$)/i.test(u.pathname);
}

/** Page-text hash -> hosts, over every row with 20 words or more. */
export function buildDupIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    if (!r.page_text || words(normalise(r.page_text)) < MIN_DUP_WORDS) continue;
    const h = hashOf(r.page_text);
    if (!idx.has(h)) idx.set(h, new Set());
    idx.get(h).add(hostOf(r.url));
  }
  return idx;
}

/**
 * { junk, review, rule }: junk is safe to act on without the AI; review means
 * the same text is on another domain. rule names what matched.
 */
export function junkCheck(row, dupIndex = new Map()) {
  const text = String(row.page_text ?? "");
  const heading = `${row.name ?? ""}\n${text.slice(0, 300)}`;
  const rule = PLACEHOLDER.some((re) => re.test(heading))
    ? "placeholder name"
    : row.has_work === false && PROMO.some((re) => re.test(text))
      ? "template promo text, no work shown"
      : PARKED.some((re) => re.test(text))
        ? "parked or for sale"
        : urlNotPortfolio(row.url)
          ? "not a portfolio address"
          : null;
  if (rule) return { junk: true, review: false, rule };
  const dup = text && words(normalise(text)) >= MIN_DUP_WORDS && [...(dupIndex.get(hashOf(text)) ?? [])].some((h) => h !== hostOf(row.url));
  return { junk: false, review: Boolean(dup), rule: dup ? "same text on another domain" : null };
}
