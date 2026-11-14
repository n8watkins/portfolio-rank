#!/usr/bin/env node
// Mini test 8, "what the grader sees" (owner-approved, 2026-11-13).
// Ten sites, the same definition (v2.1), two versions with everything else
// the same:
//   A  the desktop and phone first screens plus the page text (today);
//   B  A plus 1 or 2 screens of the Projects section, cut from the tall
//      desktop image (from the outline's projects heading; the second screen
//      when there is none).
// Capture: the lean capture of PR #207 (captureOnce), pinned at f378754 in
// a detached worktree; the first screens are its JPEG crops (what production
// grades). The facts come from one more local load with the two-sets facts
// code (the same as every earlier test). Graders: gemini-3.1-flash-lite here,
// claude-haiku-5-5 run by the owner ($1 stop); each version as 2 batches of 5
// and as 10 one at a time; job "exp-mini8".
//
//   pass-env run -e TURSO_...=... -- node scripts/experiments/mini8.mjs select
//   node scripts/experiments/mini8.mjs capture
//   node scripts/experiments/mini8.mjs bundle      (bundles, groupings, lock)
//   pass-env run -e GEMINI_API_KEY=... -e TURSO_...=... -- node scripts/experiments/mini8.mjs gemini
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- node scripts/experiments/mini8.mjs haiku
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { dailyTotals } from "../../pipeline/gemini-log.mjs";
import { HEADING_MAX_WORDS, NOT_PROJECTS_RX, PROJECTS_RX } from "../../pipeline/excerpt.mjs";
import { redactContacts } from "../../pipeline/redact.mjs";
import { captureOne, clean, factsFor } from "./grading-two-sets.mjs";
import { mulberry32, readJson, sha256, shuffled, writeJson } from "./grading-two-sets-lib.mjs";
import { SETTINGS, loadPrompts, run } from "./grading-two-sets-run.mjs";
import { HAIKU, runClaude } from "./grading-two-sets-claude.mjs";

const REPO = path.join(import.meta.dirname, "..", "..");
const ROOT = path.join(os.homedir(), "research", "portfoliorank-experiments", "mini8");
const PINNED = path.join(os.homedir(), "worktrees", "portfolio-rank-mini8-capture-f378754");
const PINNED_COMMIT = "f378754";
const SEED = 20261115;
const JOB = "exp-mini8";
const GEMINI_MODEL = "gemini-3.1-flash-lite";
const LOCK = path.join(REPO, "experiments", "mini8", "lock.json");

export const SITES = [
  { url: "https://agney.dev", why: "owner list" },
  { url: "https://www.abhisheksharma.codes/", why: "owner list (no role)" },
  { url: "https://heysai.dev/", why: "owner list" },
  { url: "https://luispeche.vercel.app/", why: "owner list" },
  { url: "https://shashikantportfolio.web.app", why: "owner list" },
  { url: "https://d2yap.github.io", why: "inner-scroll site (the <main> element scrolls), tested by the full-page lane" },
  { url: "https://shubhadeepsec.github.io", why: "543 set: behind an intro screen (CLICK TO ENTER)" },
  { url: "https://www.shubhamgupta.dev/", why: "543 set: the whole site sits in a full-screen fixed container" },
  { url: "https://vallarasuk.com", why: "543 set: a clear negative (hijacked, now a gambling site)" },
  { url: "https://anish7.me", why: "543 set: typical mid-quality portfolio, projects well below the first screen" },
];

export const VERSIONS = {
  A: { prompts: path.join(REPO, "experiments", "portfolio-definition-v2.1"), ids: { solo: "portfolio-definition-v2.1-solo", solo_freetext: "portfolio-definition-v2.1-solo-freetext", batch: "portfolio-definition-v2.1-batch" } },
  B: { prompts: path.join(REPO, "experiments", "portfolio-definition-v2.1-projects"), ids: { solo: "portfolio-definition-v2.1-projects-solo", solo_freetext: "portfolio-definition-v2.1-projects-solo-freetext", batch: "portfolio-definition-v2.1-projects-batch" } },
};

async function select() {
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  if (!process.env.TURSO_DATABASE_URL) throw new Error("select reads the production DB: run through pass-env");
  const db = pipelineDb(REPO);
  const out = [];
  for (const s of SITES) {
    const r = (await db.execute({ sql: "SELECT url, name, status, delisted_at, json_extract(ai_rubric, '$.is_portfolio') isp FROM portfolios WHERE url = ?", args: [s.url] })).rows[0];
    if (!r) throw new Error(`${s.url} is not in the database`);
    out.push({ ...s, name: String(r.name ?? ""), status: String(r.status), listed: r.delisted_at == null, production_is_portfolio: r.isp == null ? null : Number(r.isp) === 1 });
  }
  writeJson(path.join(ROOT, "sites.json"), { created_at: new Date().toISOString(), sites: out });
  console.log(out.map((s) => `${s.url} (${s.name})`).join("\n"));
}

/** The Projects screens of B, cut from the desktop tall image. */
async function cutProjects(sharp, tallPath, meta, dir) {
  const H = meta.height;
  const vh = 900;
  // The projects heading, by the same rule as the page-text excerpt
  // (pipeline/excerpt.mjs): projects, work, builds, case studies, showcase,
  // and not experience or contact; a short title, not a sentence; below the
  // top heading (level 2 or 3).
  const title = (t) => t.trim().split(/\s+/).length <= HEADING_MAX_WORDS && t.length <= 48;
  // In page order (by position); a heading that ends in "projects" or "work"
  // first, as the excerpt does, else the first that names the projects.
  // Plus "what I build" (the excerpt rule only counts "builds"), found on luispeche.vercel.app.
  const names = (t) => PROJECTS_RX.test(t) || /\bwhat i build\b/i.test(t);
  const fits = [...(meta.outline ?? [])].filter((h) => h.level > 1 && title(h.text) && names(h.text) && !NOT_PROJECTS_RX.test(h.text)).sort((a, b) => a.y - b.y);
  const ends = /^\W*(?:[\w&'’]+\s+){0,2}(?:projects?|works?)\W*$/i;
  const head = fits.find((h) => ends.test(h.text)) ?? fits[0];
  let y0;
  let what;
  if (head) {
    y0 = Math.max(0, Math.min(head.y - 24, H - vh));
    what = `projects section (heading "${head.text.slice(0, 40)}")`;
  } else {
    y0 = vh;
    what = "the second screen of the page (no projects heading found)";
  }
  if (H <= vh || y0 >= H) return { screens: [], note: `the whole page is ${H} px tall, so there is no further screen to add` };
  const room = H - y0;
  const n = head && room >= 2 * vh ? 2 : 1;
  const screens = [];
  for (let k = 0; k < n; k++) {
    const top = y0 + k * vh;
    const height = Math.min(vh, H - top);
    if (height < 200) break;
    const file = `projects-${k + 1}.jpg`;
    await sharp(tallPath).extract({ left: 0, top, width: meta.width, height }).jpeg({ quality: 75 }).toFile(path.join(dir, file));
    const label = head ? `projects section, screen ${k + 1} of ${n} (desktop, 1440 wide, cut from the whole page)` : "the second screen of the page, desktop, 1440 wide (no projects heading found)";
    screens.push({ file, label, top, height });
  }
  return { screens, note: `${what}, from ${y0} px` };
}

async function capture() {
  const sel = readJson(path.join(ROOT, "sites.json"));
  const { captureOnce } = await import(path.join(PINNED, "pipeline", "capture-once.mjs"));
  const { passModal, passSplashGate } = await import(path.join(PINNED, "pipeline", "splash.mjs"));
  const sharp = (await import("sharp")).default;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const log = [];
  try {
    sel.sites.forEach((s, i) => (s.n = i + 1));
    for (const s of sel.sites) {
      const dir = path.join(ROOT, "sites", `s${String(s.n).padStart(2, "0")}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const t0 = Date.now();
      const r = await captureOnce(browser, s.url);
      const captureSeconds = (Date.now() - t0) / 1000;
      if (!r.desktop?.ok || !r.phone?.ok) {
        log.push({ url: s.url, ok: false, desktop: r.desktop?.meta, phone: r.phone?.meta });
        console.log(`${s.url}: capture failed (desktop ${r.desktop?.meta?.error ?? "ok"}, phone ${r.phone?.meta?.error ?? "ok"})`);
        continue;
      }
      fs.writeFileSync(path.join(dir, "desktop.jpg"), r.desktop.files.crop);
      fs.writeFileSync(path.join(dir, "phone.jpg"), r.phone.files.crop);
      fs.writeFileSync(path.join(dir, "tall-desktop.avif"), r.desktop.files.tall);
      fs.writeFileSync(path.join(dir, "tall-phone.avif"), r.phone.files.tall);
      // WebP copies of the tall images, for the report.
      await sharp(r.desktop.files.tall).webp({ quality: 70 }).toFile(path.join(dir, "tall-desktop.webp"));
      await sharp(r.phone.files.tall).webp({ quality: 70 }).toFile(path.join(dir, "tall-phone.webp"));
      const text = redactContacts(clean(r.text, 6000)).trim();
      fs.writeFileSync(path.join(dir, "text.txt"), `${text}\n`);
      const proj = await cutProjects(sharp, path.join(dir, "tall-desktop.avif"), r.desktop.meta, dir);
      // The facts: one more local load with the two-sets facts code.
      const t1 = Date.now();
      const prepare = async (page) => {
        const a = await passSplashGate(page).catch(() => null);
        const b = await passModal(page).catch(() => null);
        return { splash: a, modal: b };
      };
      const measured = await captureOne(browser, s, path.join(dir, "facts-load"), { shots: false, prepare }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 200) }));
      const factsSeconds = (Date.now() - t1) / 1000;
      const facts = factsFor(s, measured.error ? {} : measured, { parts: ["the visible text, first 4,000 characters"], full_length: r.text.length });
      writeJson(path.join(dir, "facts.json"), facts);
      const rec = {
        n: s.n,
        url: s.url,
        final_url: r.finalUrl,
        splash: r.splash,
        modal: r.modal,
        desktop: r.desktop.meta,
        phone: r.phone.meta,
        projects: proj,
        capture_seconds: captureSeconds,
        facts_seconds: factsSeconds,
        facts_error: measured.error ?? null,
      };
      writeJson(path.join(dir, "capture.json"), rec);
      log.push({ url: s.url, ok: true, dir });
      console.log(`${s.url}: ${captureSeconds.toFixed(1)} s (+${factsSeconds.toFixed(1)} s facts); desktop ${r.desktop.meta.height} px${r.desktop.meta.scroller ? ` (scroller ${r.desktop.meta.scroller})` : ""}${r.desktop.meta.timeCut ? " timeCut" : ""}; phone ${r.phone.meta.height} px; B: ${proj.screens.length} screens, ${proj.note}; splash ${r.splash ? JSON.stringify(r.splash).slice(0, 60) : "none"}; dialog ${r.modal ? JSON.stringify(r.modal).slice(0, 60) : "none"}`);
    }
  } finally {
    await browser.close();
  }
  writeJson(path.join(ROOT, "capture-log.json"), { at: new Date().toISOString(), pinned: PINNED_COMMIT, log });
}

/** B's screens again from the saved tall images (no page loads), after a change to the heading rule. */
async function recut() {
  const sharp = (await import("sharp")).default;
  for (const d of fs.readdirSync(path.join(ROOT, "sites")).sort()) {
    const dir = path.join(ROOT, "sites", d);
    const cap = readJson(path.join(dir, "capture.json"));
    for (const f of fs.readdirSync(dir).filter((x) => /^projects-\d\.jpg$/.test(x))) fs.rmSync(path.join(dir, f));
    cap.projects = await cutProjects(sharp, path.join(dir, "tall-desktop.avif"), cap.desktop, dir);
    writeJson(path.join(dir, "capture.json"), cap);
    console.log(`${cap.url}: B ${cap.projects.screens.length} screens, ${cap.projects.note}`);
  }
}

// ---------------------------------------------------------------- bundles, groupings, lock
const FILES = ["desktop.jpg", "phone.jpg", "text.txt", "facts.json"];

function bundle() {
  const sel = readJson(path.join(ROOT, "sites.json"));
  const rnd = mulberry32(SEED);
  const done = sel.sites.map((s, i) => ({ ...s, dir: path.join(ROOT, "sites", `s${String(i + 1).padStart(2, "0")}`) })).filter((s) => fs.existsSync(path.join(s.dir, "capture.json")));
  if (done.length !== 10) throw new Error(`captures not ready: ${done.length} of 10 sites captured`);
  const order = shuffled(done, rnd);
  const manifest = [];
  for (const [i, s] of order.entries()) {
    const id = `P${String(i + 1).padStart(2, "0")}`;
    const cap = readJson(path.join(s.dir, "capture.json"));
    for (const v of ["A", "B"]) {
      const dir = path.join(ROOT, `bundles-${v}`, "P", id);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const f of FILES) fs.copyFileSync(path.join(s.dir, f), path.join(dir, f));
      if (v === "B") {
        for (const x of cap.projects.screens) fs.copyFileSync(path.join(s.dir, x.file), path.join(dir, x.file));
        writeJson(path.join(dir, "extra.json"), cap.projects.screens.map((x) => ({ file: x.file, label: x.label })));
      }
    }
    manifest.push({ id, url: s.url, name: s.name, why: s.why, dir: s.dir, b_screens: cap.projects.screens.length, b_note: cap.projects.note });
  }
  // The same groupings and solo order for both versions and both models.
  const ids = manifest.map((m) => m.id);
  const b = shuffled(ids, rnd);
  const groupings = { batches: [b.slice(0, 5), b.slice(5, 10)], solo_order: shuffled(ids, rnd) };
  writeJson(path.join(ROOT, "manifest.json"), { created_at: new Date().toISOString(), seed: SEED, sites: manifest, groupings });
  // Lock: the hashes of every input, the prompts and the settings, before any request.
  const hash = (p) => sha256(fs.readFileSync(p));
  const bundles = {};
  for (const v of ["A", "B"]) {
    for (const id of ids) {
      const dir = path.join(ROOT, `bundles-${v}`, "P", id);
      for (const f of fs.readdirSync(dir).sort()) bundles[`${v}/${id}/${f}`] = hash(path.join(dir, f));
    }
  }
  const prompts = {};
  for (const [v, x] of Object.entries(VERSIONS)) for (const f of ["solo.txt", "batch.txt", "schema.json"]) prompts[`${v}/${path.relative(REPO, path.join(x.prompts, f))}`] = hash(path.join(x.prompts, f));
  writeJson(LOCK, {
    locked_at: new Date().toISOString(),
    seed: SEED,
    capture: `captureOnce, feat/fullpage-shots at ${PINNED_COMMIT} (pinned worktree)`,
    sites: manifest.map(({ id, url, name, why, b_screens, b_note }) => ({ id, url, name, why, b_screens, b_note })),
    groupings,
    versions: Object.fromEntries(Object.entries(VERSIONS).map(([v, x]) => [v, { prompts: path.relative(REPO, x.prompts), prompt_ids: x.ids }])),
    settings: { gemini: { model: GEMINI_MODEL, temperature: SETTINGS.temperature, thinkingLevel: SETTINGS.thinkingLevel, hard_stop: 32, day_cap: 480 }, haiku: { model: HAIKU.model, hard_stop_usd: 1.0 }, job: JOB },
    prompts,
    bundles,
  });
  console.log(`bundles A and B for ${ids.length} sites; batches ${JSON.stringify(groupings.batches)}; locked at ${LOCK}`);
}

/** Refuses to run until the bundles exist and match the lock. */
function assertLocked() {
  if (!fs.existsSync(LOCK)) throw new Error("not locked: run the bundle step first");
  const lock = readJson(LOCK);
  for (const [k, h] of Object.entries(lock.bundles)) {
    const [v, id, f] = k.split("/");
    const p = path.join(ROOT, `bundles-${v}`, "P", id, f);
    if (!fs.existsSync(p) || sha256(fs.readFileSync(p)) !== h) throw new Error(`inputs changed since the lock: ${k}`);
  }
  for (const [k, h] of Object.entries(lock.prompts)) {
    const p = path.join(REPO, k.slice(2));
    if (sha256(fs.readFileSync(p)) !== h) throw new Error(`prompt changed since the lock: ${k}`);
  }
  return lock;
}

function requestsFor(lock) {
  const out = [];
  lock.groupings.batches.forEach((ids, b) => out.push({ key: `mini8/batch${b + 1}`, step: "batch", set: "P", kind: "batch", ids }));
  for (const id of lock.groupings.solo_order) out.push({ key: `solo/${id}`, step: "solo", set: "P", kind: "solo", ids: [id] });
  return out;
}

async function gemini() {
  const lock = assertLocked();
  if (!process.env.TURSO_DATABASE_URL) throw new Error("needs TURSO_DATABASE_URL through pass-env (request log)");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(REPO);
  const used = (await dailyTotals(db)).used.get(GEMINI_MODEL)?.n ?? 0;
  console.log(`${GEMINI_MODEL}: ${used} requests this Pacific quota day`);
  if (used + 24 > 480) throw new Error(`refusing: ${used} + 24 would pass 480`);
  let exit = "done";
  for (const v of ["A", "B"]) {
    const settings = { ...SETTINGS, model: GEMINI_MODEL, job: JOB, prompt_ids: VERSIONS[v].ids, hard_stop: 16, day_cap: 480 };
    const r = await run({ db, plan: { requests: requestsFor(lock) }, settings, prompts: loadPrompts(VERSIONS[v].prompts), out: path.join(ROOT, `gemini-3.1-${v}`), rawDir: path.join(ROOT, "raw", `gemini-3.1-${v}`), bundleRoot: path.join(ROOT, `bundles-${v}`), timelinePath: path.join(ROOT, "timeline.json") });
    if (r.exit !== "done") exit = r.exit;
  }
  process.exit(exit === "done" ? 0 : 3);
}

async function haiku() {
  const lock = assertLocked();
  let exit = "done";
  for (const v of ["A", "B"]) {
    // One state per version; the $1.00 stop is split $0.50 a version.
    const settings = { ...HAIKU, folder: `claude-haiku-api-${v}`, hard_stop_usd: 0.5, job: JOB, prompt_version: VERSIONS[v].ids.batch };
    const r = await runClaude({ settings, requestList: requestsFor(lock), prompts: loadPrompts(VERSIONS[v].prompts), out: path.join(ROOT, `claude-haiku-api-${v}`), rawDir: path.join(ROOT, "raw", `claude-haiku-api-${v}`), bundleRoot: path.join(ROOT, `bundles-${v}`), timelinePath: path.join(ROOT, "timeline.json") });
    if (r.exit !== "done") exit = r.exit;
  }
  process.exit(exit === "done" ? 0 : exit === "spend_limit" ? 4 : 3);
}

/** The code-only verdict of definition v2.1 (mini7's check) on each site's version-A bundle. */
async function code() {
  const { codeVerdict } = await import("./mini7.mjs");
  const { parkingPhrase } = await import("../../pipeline/gate.mjs");
  const man = readJson(path.join(ROOT, "manifest.json"));
  const out = {};
  for (const s of man.sites) {
    const dir = path.join(ROOT, "bundles-A", "P", s.id);
    const facts = readJson(path.join(dir, "facts.json"));
    const text = fs.readFileSync(path.join(dir, "text.txt"), "utf8");
    const mp = path.join(s.dir, "facts-load", "measured.json");
    out[s.id] = codeVerdict({ facts, text, measured: fs.existsSync(mp) ? readJson(mp) : null, parked: parkingPhrase({ text, title: facts.page_title ?? "" }) ?? null });
    console.log(`${s.id} ${s.url}: ${out[s.id].is_portfolio ? "portfolio" : "not a portfolio"} (${out[s.id].reason.slice(0, 120)})`);
  }
  writeJson(path.join(ROOT, "code-verdicts.json"), out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  const steps = { select, capture, recut, bundle, gemini, haiku, code };
  if (!steps[step]) {
    console.error("usage: mini8.mjs <select|capture|recut|bundle|gemini|haiku>");
    process.exit(1);
  }
  try {
    await steps[step]();
  } catch (e) {
    if (!/^(captures not ready|not locked|inputs changed|prompt changed)/.test(String(e?.message))) throw e;
    console.error(e.message);
    process.exit(2);
  }
}
