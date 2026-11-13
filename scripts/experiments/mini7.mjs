#!/usr/bin/env node
// Owner mini test 2 ("mini7"), 2026-11-13, with the owner's new portfolio
// definition (prompt version "portfolio-definition-v2": the locked prompts
// with only the is_portfolio section replaced; experiments/
// portfolio-definition-v2/). Seven sites: agney.dev and abhisheksharma.codes
// (their mini5 bundles) and 5 new not-ranked sites, one per group (seed
// 20261114, none from mini5), captured with the mini5 rules. Two batches,
// positions shuffled: the 5 new sites, then the 2 mini5 sites. Graded by
// gemini-3.1-flash-lite (2 requests) and claude-haiku-5-5 (run by the
// owner, $0.10 stop), job "exp-mini7"; plus a code-only verdict per site.
//
//   pass-env run -e TURSO_...=... -- node scripts/experiments/mini7.mjs select
//   node scripts/experiments/mini7.mjs capture
//   pass-env run -e GEMINI_API_KEY=... -e TURSO_...=... -- node scripts/experiments/mini7.mjs gemini
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- node scripts/experiments/mini7.mjs haiku
//   node scripts/experiments/mini7.mjs code
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { buildExcerpt } from "../../pipeline/excerpt.mjs";
import { dailyTotals } from "../../pipeline/gemini-log.mjs";
import { redactContacts } from "../../pipeline/redact.mjs";
import { clean, factsFor } from "./grading-two-sets.mjs";
import { mulberry32, readJson, shuffled, writeJson } from "./grading-two-sets-lib.mjs";
import { SETTINGS, loadPrompts, run } from "./grading-two-sets-run.mjs";
import { HAIKU, runClaude } from "./grading-two-sets-claude.mjs";
import { FULLPAGE, GROUPS, captureSite } from "./mini5.mjs";

const RES = path.join(os.homedir(), "research", "portfoliorank-experiments");
const ROOT = path.join(RES, "mini7");
const MINI5 = path.join(RES, "mini5");
const SEED = 20261114;
const JOB = "exp-mini7";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
export const PROMPTS_DIR = path.join(import.meta.dirname, "..", "..", "experiments", "portfolio-definition-v2");
const PROMPT_IDS = { solo: "portfolio-definition-v2-solo", solo_freetext: "portfolio-definition-v2-solo-freetext", batch: "portfolio-definition-v2-batch" };
// From mini5: M4 agney.dev and M3 abhisheksharma.codes.
const REUSED = ["M4", "M3"];

async function select() {
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  if (!process.env.TURSO_DATABASE_URL) throw new Error("select reads the production DB: run through pass-env");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const used = new Set(readJson(path.join(MINI5, "manifest.json")).sites.map((s) => s.url));
  const rnd = mulberry32(SEED);
  const out = { created_at: new Date().toISOString(), seed: SEED, excluded_from_mini5: [...used], groups: [] };
  for (const g of GROUPS) {
    const rows = (await db.execute(`SELECT p.url, p.name, p.status, p.reason, p.delisted_at FROM portfolios p LEFT JOIN tier_ratings t ON t.url = p.url WHERE t.points IS NULL AND ${g.where} ORDER BY p.url`)).rows.filter((r) => !used.has(String(r.url)));
    out.groups.push({ ...g, pool: rows.length, candidates: shuffled(rows.map((r) => ({ url: String(r.url), name: String(r.name ?? ""), status: String(r.status), reason: r.reason == null ? null : String(r.reason), delisted_at: r.delisted_at == null ? null : String(r.delisted_at) })), rnd).slice(0, 8) });
    console.log(`group ${g.group} (${g.label}): ${rows.length} sites`);
  }
  writeJson(path.join(ROOT, "selection.json"), out);
}

async function capture() {
  const sel = readJson(path.join(ROOT, "selection.json"));
  // A manifest from an earlier, unfinished run must never be graded.
  fs.rmSync(path.join(ROOT, "manifest.json"), { force: true });
  const fp = await import(FULLPAGE);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const picked = [];
  const tries = [];
  try {
    for (const g of sel.groups) {
      for (const c of g.candidates) {
        const dir = path.join(ROOT, "sites", `g${g.group}`);
        fs.rmSync(dir, { recursive: true, force: true });
        try {
          const m = await captureSite(browser, c, dir, fp);
          const ex = buildExcerpt(readJson(path.join(dir, "outline.json")));
          fs.writeFileSync(path.join(dir, "text.txt"), `${redactContacts(clean(ex.text, 6000)).trim()}\n`);
          writeJson(path.join(dir, "facts.json"), factsFor(c, m, ex));
          picked.push({ group: g.group, label: g.label, ...c, dir, capture_seconds: m.capture_seconds, full_page_seconds: m.full_page_seconds, desktop_action: m.desktop_action.note, phone_action: m.phone_action.note });
          tries.push({ group: g.group, url: c.url, ok: true });
          console.log(`group ${g.group}: ${c.url} ok in ${m.capture_seconds.toFixed(1)} s (+${m.full_page_seconds.toFixed(1)} s tall images); desktop: ${m.desktop_action.note ?? "no click"}; phone: ${m.phone_action.note ?? "no click"}`);
          break;
        } catch (e) {
          tries.push({ group: g.group, url: c.url, ok: false, why: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
          console.log(`group ${g.group}: ${c.url} failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 120)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  // Batch 1: the new sites, shuffled; batch 2: the two mini5 sites, shuffled.
  const rnd = mulberry32(SEED + 1);
  const m5 = readJson(path.join(MINI5, "manifest.json")).sites;
  const reused = REUSED.map((id) => ({ ...m5.find((s) => s.id === id), from_mini5: id }));
  const sites = [...shuffled(picked, rnd).map((s) => ({ ...s, batch: 1 })), ...shuffled(reused, rnd).map((s) => ({ ...s, batch: 2 }))];
  sites.forEach((s, i) => {
    s.id = `N${i + 1}`;
    const link = path.join(ROOT, "bundles", "N", s.id);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(s.dir, link);
  });
  writeJson(path.join(ROOT, "manifest.json"), { created_at: new Date().toISOString(), seed: SEED, sites, tries });
}

export const BUNDLE_FILES = ["desktop.jpg", "phone.jpg", "text.txt", "facts.json"];

/**
 * Refuses to grade until all 7 bundles exist: 5 new sites in batch 1 and the
 * 2 mini5 sites in batch 2, each with non-empty images, text and facts.
 * Throws "captures not ready" with what is missing.
 */
export function assertReady(root = ROOT) {
  const missing = [];
  const manPath = path.join(root, "manifest.json");
  const sites = fs.existsSync(manPath) ? readJson(manPath).sites ?? [] : [];
  if (!fs.existsSync(manPath)) missing.push("manifest.json (the capture has not finished)");
  const b1 = sites.filter((s) => s.batch === 1).length;
  const b2 = sites.filter((s) => s.batch === 2).length;
  if (b1 !== 5) missing.push(`batch 1 has ${b1} of 5 new sites`);
  if (b2 !== 2) missing.push(`batch 2 has ${b2} of 2 mini5 sites`);
  for (const s of sites) {
    for (const f of BUNDLE_FILES) {
      const p = path.join(root, "bundles", "N", s.id, f);
      if (!fs.existsSync(p) || fs.statSync(p).size === 0) missing.push(`${s.id} ${f}`);
    }
  }
  if (missing.length) throw new Error(`captures not ready: ${missing.join("; ")}. Wait for "node scripts/experiments/mini7.mjs capture" to finish, then run this again. Nothing was sent.`);
  return sites;
}

const requests = () => {
  const s = assertReady();
  return [1, 2].map((b) => ({ key: `mini7/batch${b}`, step: "mini7", set: "N", kind: "batch", ids: s.filter((x) => x.batch === b).map((x) => x.id) }));
};

async function gemini() {
  if (!process.env.TURSO_DATABASE_URL) throw new Error("needs TURSO_DATABASE_URL through pass-env (request log)");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const used = (await dailyTotals(db)).used.get(GEMINI_MODEL)?.n ?? 0;
  console.log(`${GEMINI_MODEL}: ${used} requests this Pacific quota day`);
  if (used + 2 > 495) throw new Error(`refusing: ${used} + 2 would pass 495`);
  const settings = { ...SETTINGS, model: GEMINI_MODEL, job: JOB, prompt_ids: PROMPT_IDS, hard_stop: 4, day_cap: 495 };
  const { exit } = await run({ db, plan: { requests: requests() }, settings, prompts: loadPrompts(PROMPTS_DIR), out: path.join(ROOT, "gemini-3.1"), rawDir: path.join(ROOT, "raw", "gemini-3.1"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : 3);
}

async function haiku() {
  const settings = { ...HAIKU, folder: "claude-haiku-api", hard_stop_usd: 0.1, job: JOB, prompt_version: "portfolio-definition-v2" };
  const { exit } = await runClaude({ settings, requestList: requests(), prompts: loadPrompts(PROMPTS_DIR), out: path.join(ROOT, "claude-haiku-api"), rawDir: path.join(ROOT, "raw", "claude-haiku-api"), bundleRoot: path.join(ROOT, "bundles"), timelinePath: path.join(ROOT, "timeline.json") });
  process.exit(exit === "done" ? 0 : exit === "spend_limit" ? 4 : 3);
}

// ---------------------------------------------------------------- code only
const ROLE = /\b(developer|engineer|engineering|designer|programmer|coder|architect|scientist|analyst|full[\s-]?stack|front[\s-]?end|back[\s-]?end|devops|software|web\s?dev|student|researcher|freelancer|consultant|hacker|maker|creative technologist)\b/i;
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * The definition, by code: (1) a name (in the title or top heading, or the
 * listed name's tokens in the top of the page with spaces and symbols
 * removed, so spaced-out letters count), (2) role words in the top of the
 * page, (3) a way to the work (a projects or work link in the first screen,
 * a GitHub link, project links, or a resume). All three: a portfolio.
 */
export function codeVerdict({ facts, text, measured }) {
  const top = fold(String(text).slice(0, 1500));
  const squashed = top.replace(/[^a-z0-9]+/g, "");
  const tokens = fold(facts.name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const nameHit = facts.name_in_page_title || facts.name_in_top_heading || (tokens.length && tokens.some((t) => squashed.includes(t)));
  const name = Boolean(nameHit);
  const roleMatch = top.match(ROLE);
  const fs1 = facts.first_screen_links ?? {};
  const github = Boolean(measured?.facts?.github);
  const workBits = [];
  if (fs1.desktop?.work || fs1.phone?.work) workBits.push("a work or projects link in the first screen");
  if (github) workBits.push("a GitHub link");
  if ((facts.project_links?.checked ?? 0) > 0) workBits.push(`${facts.project_links.checked} project links`);
  if (facts.resume_link_anywhere || fs1.desktop?.resume || fs1.phone?.resume) workBits.push("a resume link");
  const verdict = name && Boolean(roleMatch) && workBits.length > 0;
  const why = [
    name ? `name found (${facts.name_in_page_title ? `title: ${facts.name_in_page_title}` : facts.name_in_top_heading ? `heading: ${facts.name_in_top_heading}` : "in the page text"})` : "no name found",
    roleMatch ? `role word "${roleMatch[0]}"` : "no role word in the top of the page",
    workBits.length ? workBits.join(", ") : "no way to the work",
  ];
  return { is_portfolio: verdict, name, role: Boolean(roleMatch), work: workBits.length > 0, reason: why.join("; ") };
}

function code() {
  const man = readJson(path.join(ROOT, "manifest.json"));
  const out = {};
  for (const s of man.sites) {
    out[s.id] = codeVerdict({ facts: readJson(path.join(s.dir, "facts.json")), text: fs.readFileSync(path.join(s.dir, "text.txt"), "utf8"), measured: readJson(path.join(s.dir, "measured.json")) });
    console.log(`${s.id} ${s.url}: ${out[s.id].is_portfolio ? "portfolio" : "not a portfolio"} (${out[s.id].reason})`);
  }
  writeJson(path.join(ROOT, "code-verdicts.json"), out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  const steps = { select, capture, gemini, haiku, code };
  if (!steps[step]) {
    console.error("usage: mini7.mjs <select|capture|gemini|haiku|code>");
    process.exit(1);
  }
  try {
    await steps[step]();
  } catch (e) {
    if (!/^captures not ready/.test(String(e?.message))) throw e;
    console.error(e.message);
    process.exit(2);
  }
}
