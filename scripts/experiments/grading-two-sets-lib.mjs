// Shared pieces of the "Grading test (two sets)" experiment
// (scripts/experiments/grading-two-sets.mjs): paths, the seeded random
// helpers, the first-screen facts and the batch groupings.
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

export const REPO = path.join(import.meta.dirname, "..", "..");
export const EXP = path.join(REPO, "experiments", "grading-two-sets");
// Raw data stays local and out of git.
export const RES = process.env.TWO_SETS_DIR ?? path.join(os.homedir(), "research", "portfoliorank-experiments", "grading-two-sets");
// Set A reuses the captures of the first grading test (13 November).
export const OLD = process.env.TWO_SETS_OLD ?? path.join(os.homedir(), "worktrees", "portfolio-rank-exp-grading-v3", "experiments", "grading-v3", "data");

export const SEED = 20261113;
export const SET_SIZE = 20;
export const BATCH = 5;
export const JOB = "exp-grading-two-sets";
export const JUNK = { A: "https://toukoum.fr" };

export const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
export const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
};
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled(xs, rnd) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** `n` equal strata over a list already sorted strong to weak (by rank, so ties never decide a stratum). */
export function strata(sorted, n) {
  return Array.from({ length: n }, (_, k) => sorted.slice(Math.floor((k * sorted.length) / n), Math.floor(((k + 1) * sorted.length) / n)));
}

/** Never point a browser at PortfolioRank itself (production or staging). */
export function assertNotOurs(url) {
  const h = new URL(url).hostname.toLowerCase();
  if (/portfoliorank|n8builds/.test(h)) throw new Error(`refusing to load ${url}: PortfolioRank's own host`);
}

// ------------------------------------------------------------ first screen

/**
 * Runs in the page (page.evaluate): the page title, the top heading and
 * every link or button visible in the first screen (no scrolling).
 */
export function readFirstScreen() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const txt = (el) => (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.querySelector?.("img[alt]")?.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const h1 = [...document.querySelectorAll("h1")].find(shown) ?? [...document.querySelectorAll("h1")][0] ?? null;
  const links = [...document.querySelectorAll("a[href], button, [role=link], [role=button]")].filter(shown).map((el) => ({
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute("href") ?? "",
    text: txt(el),
  }));
  return { title: document.title ?? "", top_heading: h1 ? txt(h1) : "", links };
}

const WORK = /\b(projects?|works?|portfolio|case[- ]?stud(?:y|ies)|showcase|builds?|things i(?:'|’)?ve (?:built|made))\b/i;
const RESUME = /\b(resume|résumé|cv|curriculum)\b/i;
const CONTACT = /\b(contact|hire me|get in touch|say hello|say hi|email|e-mail|let'?s (?:talk|chat|connect|work)|message me|book a call)\b/i;

/** What a first-screen link leads to: work, resume, contact or nothing we count. */
export function linkKinds({ href = "", text = "" }) {
  const kinds = new Set();
  const label = `${text} ${href}`;
  let u = null;
  try {
    u = new URL(href, "https://example.invalid/");
  } catch {
    /* not a URL */
  }
  const host = u ? u.hostname.replace(/^www\./, "") : "";
  if (/^(mailto|tel):/i.test(href) || /linkedin\.com\/in\//i.test(href) || /^(x|twitter)\.com$/.test(host) || CONTACT.test(label)) kinds.add("contact");
  if (RESUME.test(text) || RESUME.test(u?.pathname ?? "") || /\.pdf$/i.test(u?.pathname ?? "")) kinds.add("resume");
  if (WORK.test(label) || (host === "github.com" && (u?.pathname.split("/").filter(Boolean).length ?? 0) >= 1)) kinds.add("work");
  return [...kinds];
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Where the person's name shows: "full name", "first name" or null. */
export function nameMatch(name, where) {
  const n = fold(name).replace(/[^a-z0-9 ]+/g, " ").trim();
  const w = fold(where);
  if (!n) return null;
  if (w.includes(n)) return "full name";
  const first = n.split(/\s+/)[0];
  if (first.length >= 3 && new RegExp(`\\b${first}\\b`).test(w)) return "first name";
  return null;
}

/** The first-screen facts of one view, from readFirstScreen's links. */
export function screenFacts(links, redact) {
  const counted = links
    .map((l) => ({ ...l, kinds: linkKinds(l) }))
    .filter((l) => l.kinds.length);
  const has = (k) => counted.some((l) => l.kinds.includes(k));
  const seen = new Set();
  const examples = [];
  for (const l of counted) {
    const label = redact(l.text || l.href).slice(0, 60);
    const key = `${l.kinds.join("+")}:${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    examples.push(`${l.kinds.join("+")}: ${label}`);
    if (examples.length >= 8) break;
  }
  return { work: has("work"), resume: has("resume"), contact: has("contact"), examples };
}

// ------------------------------------------------------------ groupings

/**
 * Three batched passes over 20 ids, 4 batches of 5 each: every id takes a
 * different position (1 to 5) in each pass, and as few pairs as possible
 * share a batch twice. Seeded random search; deterministic for a seed.
 */
export function makePasses(ids, rnd, { passes = 3, size = BATCH, tries = 20000 } = {}) {
  let best = null;
  for (let t = 0; t < tries; t++) {
    const out = [];
    const posOf = new Map(ids.map((id) => [id, new Set()]));
    let ok = true;
    for (let p = 0; p < passes && ok; p++) {
      // Assign positions: each id needs a position it has not had yet.
      const order = shuffled(ids, rnd);
      const batches = Array.from({ length: ids.length / size }, () => new Array(size).fill(null));
      for (const id of order) {
        const free = [];
        batches.forEach((b, bi) => b.forEach((x, pi) => {
          if (x === null && !posOf.get(id).has(pi)) free.push([bi, pi]);
        }));
        if (!free.length) {
          ok = false;
          break;
        }
        const [bi, pi] = free[Math.floor(rnd() * free.length)];
        batches[bi][pi] = id;
      }
      if (!ok) break;
      batches.forEach((b) => b.forEach((id, pi) => posOf.get(id).add(pi)));
      out.push(batches);
    }
    if (!ok) continue;
    const pairs = new Map();
    for (const pass of out) for (const b of pass) for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
      const k = [b[i], b[j]].sort().join("|");
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    const repeats = [...pairs.values()].filter((v) => v > 1).length;
    if (!best || repeats < best.repeats) best = { passes: out, repeats };
    if (repeats === 0) break;
  }
  return best;
}
