// Shared pieces of the two-model check experiment: where the saved inputs
// are, how one site's request is built from them, the two model clients,
// the on-disk answer cache and the spending ledger.
//
// Experiment only. Nothing here is imported by the product.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { redactContacts } from "../../pipeline/redact.mjs";
import { PROMPTS } from "./prompts.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = path.join(process.env.HOME, "projects/ops/handoffs/portfolio-rank/files");
export const BENCH_FILE = path.join(FILES, "benchmark-portfolio-or-not.json");
export const PAGES_DIR = path.join(FILES, "benchmark-pages");
export const OUT_DIR = path.join(FILES, "two-model-check");
export const CACHE_DIR = path.join(OUT_DIR, "cache");
export const LEDGER = path.join(OUT_DIR, "ledger.jsonl");

// Hard limits from the brief.
export const MAX_REQUESTS = 3000;
export const MAX_IN_FLIGHT = 4;
export const MAX_SPEND_USD = 15;

// The production grader's model and settings (pipeline/gemini.mjs
// PRIMARY_MODEL; pipeline/rubric.mjs THINKING_LEVEL and TEMPERATURE).
export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const HAIKU_MODEL = "claude-haiku-5-5";
export const MODELS = { gemini: GEMINI_MODEL, haiku: HAIKU_MODEL };
// US dollars per million tokens. Gemini: the repository's paid Standard rate
// (pipeline/gemini-log.mjs DEFAULT_PRICES), output including thinking.
// Haiku 5.5: Anthropic's list price for prompts up to 100K tokens.
export const PRICES = {
  [GEMINI_MODEL]: { in: 0.3, out: 2.5 },
  [HAIKU_MODEL]: { in: 0.1, out: 0.5 },
};

export const TEXT_CAP = 4000;

const keyOf = (u) => String(u).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
export const slugOf = (u) => keyOf(u).replace(/[^a-z0-9.-]+/g, "_").slice(0, 120);

export function loadBench() {
  return JSON.parse(fs.readFileSync(BENCH_FILE, "utf8"));
}

export function loadSplit() {
  return JSON.parse(fs.readFileSync(path.join(HERE, "split.json"), "utf8"));
}

export function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const STABILITY_SEED = 20261125;
export const STABILITY_N = 60;

/** The fixed 60 held-out sites asked twice: a seeded draw from the held-out sites the models can be asked about. */
export function stabilitySample(bench, split) {
  const byUrl = new Map(bench.sites.map((s) => [s.url, s]));
  const pool = split.heldout.filter((u) => askable(savedPage(byUrl.get(u)))).sort();
  const rand = mulberry32(STABILITY_SEED);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, STABILITY_N).sort();
}

/** The saved copy of one site: screenshot path, page text, record. */
export function savedPage(site) {
  const dir = path.join(PAGES_DIR, slugOf(site.url));
  const shot = path.join(dir, "render-0.jpg");
  const txt = path.join(dir, "rendered.txt");
  const html = path.join(dir, "rendered.html");
  const rec = path.join(dir, "record.json");
  const record = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, "utf8")) : null;
  return {
    dir,
    shot: fs.existsSync(shot) ? shot : null,
    text: fs.existsSync(txt) ? fs.readFileSync(txt, "utf8") : null,
    html: fs.existsSync(html) ? fs.readFileSync(html, "utf8") : null,
    render: record?.renders?.[0] ?? null,
  };
}

/** A site the models can be asked about: the browser rendered it (a screenshot or a text). */
export const askable = (page) => Boolean(page.shot || page.text);

/** Characters of text in an HTML document, hidden parts included (scripts and styles left out). */
export function htmlTextLength(html) {
  if (!html) return 0;
  return String(html)
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

const SIGNAL_WORDS = {
  projects: "a projects or work section, or project links",
  about: "an about section",
  contact: "a contact path (email link, contact form or contact section)",
  resume: "a resume or CV link",
  github: "a GitHub link",
  name: "the listed person's name on the page",
};

/** The page text the models get: contacts redacted, blank runs folded, cut at TEXT_CAP. */
export function boundedText(text) {
  let t = redactContacts(String(text ?? ""))
    .replace(/<\/?site_data>/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  const full = t.length;
  if (full > TEXT_CAP) t = t.slice(0, TEXT_CAP) + `\n[cut here: ${full - TEXT_CAP} more characters]`;
  return { text: t, full };
}

/** What the code found, as plain facts (no label, no AI verdict, no outcome). */
export function codeFacts(site, page) {
  const c = site.code ?? {};
  const lines = [];
  const finalUrl = c.check?.finalUrl || c.page?.finalUrl || null;
  if (finalUrl) {
    const same = hostOf(finalUrl) === hostOf(site.url);
    lines.push(`- Where it ended up after redirects: ${finalUrl} (${same ? "the same site" : "a different site from the listed address"})`);
  }
  if (c.page?.status != null) lines.push(`- HTTP status of the page: ${c.page.status}`);
  if (c.page?.title) lines.push(`- Page title: ${redactContacts(c.page.title).slice(0, 200)}`);
  lines.push(
    c.check?.ok
      ? "- Health check: passed (the page loads, is not blank and shows no parking phrase)"
      : `- Health check: failed (${c.check?.reason || "unknown reason"})`,
  );
  const sig = c.check?.signals ?? c.signalsRendered ?? null;
  if (sig) {
    const found = Object.keys(SIGNAL_WORDS).filter((k) => sig[k]);
    const missing = Object.keys(SIGNAL_WORDS).filter((k) => !sig[k]);
    lines.push(`- Portfolio signals code looked for in the page's HTML, ${found.length} of 6 found.`);
    lines.push(`  Found: ${found.length ? found.map((k) => SIGNAL_WORDS[k]).join("; ") : "none"}.`);
    lines.push(`  Not found: ${missing.length ? missing.map((k) => SIGNAL_WORDS[k]).join("; ") : "none"}.`);
  }
  const rules = [];
  if (c.hostNotPortfolio || c.urlNotPortfolio) rules.push("the address rule: the address is on a code host, Substack, Medium or a link page service");
  if (c.junk?.rule) rules.push(`the "${c.junk.rule}" rule${c.junk.review ? " (a match that asks for a look, not proof)" : ""}`);
  if (c.parkedRendered) rules.push(`a parking check: ${c.parkedRendered}`);
  lines.push(`- Code rules that matched: ${rules.length ? rules.join("; ") : "none"}`);
  const vis = String(page.text ?? "").length;
  lines.push(`- Visible text on the finished page: ${vis} characters`);
  const inHtml = htmlTextLength(page.html);
  if (page.html) lines.push(`- Text in the finished page's HTML, hidden parts included: ${inHtml} characters`);
  const samples = page.render?.extra?.samples ?? [];
  if (page.render) {
    const ms = page.render.ms;
    if (samples.length > 1) {
      const first = samples[0].text.length;
      const last = samples.at(-1).text.length;
      lines.push(`- While the page settled (${(ms / 1000).toFixed(0)} s), its visible text changed ${samples.length - 1} time(s): ${first} characters at first, ${last} at the last change.`);
    } else {
      lines.push(`- While the page settled (${(ms / 1000).toFixed(0)} s), its visible text did not change.`);
    }
  }
  lines.push(`- Screenshot: ${page.shot ? "the first screen at 1280x800, taken once the page settled" : "none was taken"}`);
  return lines.join("\n");
}

/**
 * The request for one site, arm and prompt version, in a provider-neutral
 * form: { system, image (path or null), text, schema, schemaKind }.
 */
export function buildRequest(site, page, { arm, prompt }) {
  const p = PROMPTS[prompt];
  if (!p) throw new Error(`unknown prompt ${prompt}`);
  const spec = p.arms[arm];
  if (!spec) throw new Error(`prompt ${prompt} has no arm ${arm}`);
  const parts = [`Name on the list: ${redactContacts(site.name ?? "").slice(0, 120) || "(none)"}`, `Listed address: ${site.url}`];
  if (spec.facts) parts.push("", "What the code found:", codeFacts(site, page));
  if (spec.text) {
    const { text, full } = boundedText(page.text);
    parts.push("", `Page text (the finished page's visible text, ${full} characters${full > TEXT_CAP ? `, cut at ${TEXT_CAP}` : ""}):`, text || "(no visible text)");
  }
  if (!page.shot && spec.image) parts.push("", "(No screenshot was taken of this page.)");
  return {
    system: spec.system,
    image: spec.image ? page.shot : null,
    text: `<site_data>\n${parts.join("\n")}\n</site_data>`,
    schemaKind: spec.schemaKind,
  };
}

// ---------- answers ----------

/** A model answer normalised to { answer: portfolio|not_portfolio|cannot_tell, why, kind, reason }. */
export function normalise(schemaKind, out) {
  if (!out) return null;
  if (schemaKind === "old") {
    return { answer: out.is_portfolio ? "portfolio" : "not_portfolio", why: null, kind: null, reason: out.reason ?? "" };
  }
  return {
    answer: out.answer,
    why: out.answer === "cannot_tell" ? out.cannot_tell_why : null,
    kind: out.answer === "not_portfolio" ? out.kind : null,
    reason: out.reason ?? "",
  };
}

// ---------- cache ----------

export function cacheKey(model, req, rep) {
  const img = req.image ? crypto.createHash("sha256").update(fs.readFileSync(req.image)).digest("hex") : null;
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify({ model, system: req.system, text: req.text, img, schemaKind: req.schemaKind, rep }));
  return h.digest("hex").slice(0, 32);
}

export function cacheGet(key) {
  const f = path.join(CACHE_DIR, key.slice(0, 2), `${key}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

export function cachePut(key, value) {
  const d = path.join(CACHE_DIR, key.slice(0, 2));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${key}.json`), JSON.stringify(value, null, 1) + "\n");
}

// ---------- ledger: every HTTP attempt, its tokens and cost ----------

export function costOf(model, usage) {
  const p = PRICES[model];
  return ((usage?.in ?? 0) * p.in + (usage?.out ?? 0) * p.out) / 1e6;
}

export function ledgerTotals() {
  if (!fs.existsSync(LEDGER)) return { requests: 0, usd: 0 };
  let requests = 0;
  let usd = 0;
  for (const line of fs.readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    requests++;
    usd += e.usd ?? 0;
  }
  return { requests, usd };
}

export function ledgerAdd(entry) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
}
