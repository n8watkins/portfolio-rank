#!/usr/bin/env node
// Experiment "Grading test (two sets)", owner-approved 2026-11-13.
// Plan and lock: experiments/grading-two-sets/ (lock.json, prompt-log.md,
// expert-runs.md). Raw data stays local in ~/research/portfoliorank-
// experiments/grading-two-sets/ (TWO_SETS_DIR), out of git.
//
// It never writes a grade, rating or tier. The only database write is the
// request log (gemini_requests, job "exp-grading-two-sets", prompt
// grade-two-sets-solo / grade-two-sets-batch), so the quota day counts it.
//
// Steps:
//   select   read-only: Set A (20 of the 40 sites captured on 13 November)
//            and Set B candidates (20 strata of the other graded, listed
//            portfolios), spread from strong to weak by check points.
//   capture  local Playwright, no AI: Set B desktop and phone tops, page text
//            and facts; Set A first-screen facts only (its images and text
//            come from 13 November).
//   bundle   one input bundle per site (desktop.jpg, phone.jpg, text.txt,
//            facts.json) plus manifest.json.
//   plan     the batch groupings and the repeat lists, written to the branch.
//   run      the Gemini requests (scripts/experiments/grading-two-sets-run.mjs).
//   analyze  scripts/experiments/grading-two-sets-analyze.mjs.
//
//   pass-env run -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- node scripts/experiments/grading-two-sets.mjs select
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { redactContacts } from "../../pipeline/redact.mjs";
import { stripSiteDataMarkers } from "../../pipeline/site-data.mjs";
import { measurePage } from "../../pipeline/facts.mjs";
import { UA, readRenderedPage } from "../../pipeline/gate.mjs";
import { OUTLINE_ARGS, buildExcerpt, readPageOutline } from "../../pipeline/excerpt.mjs";
import { normalizePageText } from "../../pipeline/rubric.mjs";
import { pngDiff } from "../../pipeline/png-diff.mjs";
import {
  BATCH, EXP, JUNK, OLD, RES, SEED, SET_SIZE,
  assertNotOurs, makePasses, mulberry32, nameMatch, readFirstScreen, readJson, screenFacts, sha256, shuffled, strata, writeJson,
} from "./grading-two-sets-lib.mjs";

const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const SEL = path.join(RES, "selection.json");
const CAP = path.join(RES, "capture");

// ---------------------------------------------------------------- select
const ELIGIBLE = `
  SELECT p.url, p.name, t.points FROM portfolios p JOIN tier_ratings t ON t.url = p.url
  WHERE p.status = 'live' AND p.delisted_at IS NULL AND COALESCE(p.health, '') != 'down'
    AND t.points IS NOT NULL
    AND json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL
    AND COALESCE(json_extract(p.ai_rubric, '$.is_portfolio'), 1) != 0`;

async function select({ db, junkB }) {
  if (!junkB) throw new Error("select needs --junk-b URL (Set B's known junk site)");
  const old = readJson(path.join(OLD, "plan.json")).sites;
  const oldUrls = new Set(old.map((s) => s.url));
  const rows = (await db.execute(ELIGIBLE)).rows.map((r) => ({ url: String(r.url), name: String(r.name ?? ""), points: Number(r.points) }));
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const sort = (xs) => [...xs].sort((a, b) => b.points - a.points || a.url.localeCompare(b.url));
  const rnd = mulberry32(SEED);
  // Set A: 19 strata over the 39 non-junk sites of the 40, one per stratum, plus the junk site.
  const poolA = sort(old.map((s) => byUrl.get(s.url)).filter((r) => r && r.url !== JUNK.A));
  const missingA = old.filter((s) => !byUrl.has(s.url)).map((s) => s.url);
  const A = strata(poolA, SET_SIZE - 1).map((st, k) => ({ stratum: k + 1, pick: shuffled(st, rnd)[0], of: st.length }));
  // Set B: 19 strata over every other eligible site; candidates in a seeded
  // order per stratum, the capture takes the first that loads.
  const poolB = sort(rows.filter((r) => !oldUrls.has(r.url) && r.url !== junkB));
  const B = strata(poolB, SET_SIZE - 1).map((st, k) => ({ stratum: k + 1, candidates: shuffled(st, rnd).slice(0, 6), of: st.length, range: [st.at(-1).points, st[0].points] }));
  const junk = byUrl.get(junkB) ?? (await db.execute({ sql: "SELECT p.url, p.name, t.points FROM portfolios p JOIN tier_ratings t ON t.url = p.url WHERE p.url = ?", args: [junkB] })).rows.map((r) => ({ url: String(r.url), name: String(r.name ?? ""), points: Number(r.points) }))[0];
  if (!junk) throw new Error(`junk site ${junkB} not found`);
  writeJson(SEL, {
    created_at: new Date().toISOString(),
    seed: SEED,
    method: "Each set: 19 equal strata by rank over the pool sorted by check points (tier_ratings.points), one random site per stratum (seeded), plus one known junk site.",
    eligible: rows.length,
    missing_from_A_pool: missingA,
    A: { junk: byUrl.get(JUNK.A), pool: poolA.length, strata: A },
    B: { junk, pool: poolB.length, strata: B },
  });
  console.log(`eligible ${rows.length}; Set A pool ${poolA.length} (missing ${missingA.length}); Set B pool ${poolB.length}`);
}

// ---------------------------------------------------------------- capture
async function settle(page) {
  let prev = await page.screenshot({ type: "png" });
  let quiet = 0;
  for (let i = 0; i < 6 && quiet < 2; i++) {
    await page.waitForTimeout(2000);
    const cur = await page.screenshot({ type: "png" });
    quiet = pngDiff(prev, cur) < 0.01 ? quiet + 1 : 0;
    prev = cur;
  }
}

/**
 * One desktop load and one phone load. `shots` saves the screenshots and the
 * outline (Set B); without it only the facts are measured (Set A).
 */
async function captureOne(browser, site, dir, { shots }) {
  assertNotOurs(site.url);
  fs.mkdirSync(dir, { recursive: true });
  const out = { url: site.url, at: new Date().toISOString() };
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const first = await page.evaluate(readRenderedPage);
    if (first.text.trim().length < 30 && !first.media) throw new Error("renders blank");
    await settle(page);
    if (shots) fs.writeFileSync(path.join(dir, "desktop.jpg"), await page.screenshot({ type: "jpeg", quality: 75 }));
    out.desktop = await page.evaluate(readFirstScreen);
    out.final_url = page.url();
    const rendered = await page.evaluate(readRenderedPage);
    out.html_sha = sha256(rendered.html);
    // Scroll through so scroll-triggered sections render, then read the outline.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(height, 20000); y += 700) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const outline = await page.evaluate(readPageOutline, OUTLINE_ARGS);
    if (shots) writeJson(path.join(dir, "outline.json"), { ...outline, final_url: out.final_url });
    const full = await page.evaluate(readRenderedPage);
    out.facts = await measurePage({ html: full.html, text: full.text, url: site.url, finalUrl: out.final_url, name: site.name }, { userAgent: UA });
    out.text_start = normalizePageText(outline.text, 600);
  } finally {
    await ctx.close().catch(() => {});
  }
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: PHONE_UA, ignoreHTTPSErrors: true });
  try {
    const m = await mctx.newPage();
    await m.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await m.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await m.waitForTimeout(3000);
    if (shots) fs.writeFileSync(path.join(dir, "phone.jpg"), await m.screenshot({ type: "jpeg", quality: 75 }));
    out.phone = await m.evaluate(readFirstScreen);
  } finally {
    await mctx.close().catch(() => {});
  }
  writeJson(path.join(dir, "measured.json"), out);
  return out;
}

const keyOf = (url) => sha256(url).slice(0, 16);

async function capture({ only }) {
  const sel = readJson(SEL);
  const statePath = path.join(RES, "capture-state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { A: {}, B: {}, failures: [], log: [] };
  const save = () => writeJson(statePath, state);
  const log = (m) => {
    console.log(m);
    state.log.push(`${new Date().toISOString()} ${m}`);
  };
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    // Set A: facts only, on the 13 November images and text.
    if (!only || only === "A") {
      const oldPlan = readJson(path.join(OLD, "plan.json")).sites;
      const listA = [...sel.A.strata.map((s) => s.pick), sel.A.junk];
      for (const s of listA) {
        if (state.A[s.url]) continue;
        const o = oldPlan.find((x) => x.url === s.url);
        const dir = path.join(CAP, "A", o.shot_key);
        try {
          await captureOne(browser, s, dir, { shots: false });
          state.A[s.url] = { shot_key: o.shot_key, dir };
          log(`A ${s.url} facts ok`);
        } catch (e) {
          state.failures.push({ set: "A", url: s.url, why: String(e?.message ?? e).slice(0, 200) });
          log(`A ${s.url} FAILED ${String(e?.message ?? e).slice(0, 120)}`);
        }
        save();
      }
    }
    if (!only || only === "B") {
      const slots = [...sel.B.strata.map((s) => ({ stratum: s.stratum, candidates: s.candidates })), { stratum: "junk", candidates: [sel.B.junk] }];
      for (const slot of slots) {
        if (Object.values(state.B).some((x) => x.stratum === slot.stratum)) continue;
        for (const c of slot.candidates) {
          if (state.failures.some((f) => f.url === c.url)) continue;
          const dir = path.join(CAP, "B", keyOf(c.url));
          try {
            await captureOne(browser, c, dir, { shots: true });
            const outline = readJson(path.join(dir, "outline.json"));
            if (normalizePageText(outline.text).length < 30 && slot.stratum !== "junk") throw new Error("no text");
            state.B[c.url] = { stratum: slot.stratum, key: keyOf(c.url), dir };
            log(`B stratum ${slot.stratum}: ${c.url} ok`);
            save();
            break;
          } catch (e) {
            state.failures.push({ set: "B", stratum: slot.stratum, url: c.url, why: String(e?.message ?? e).slice(0, 200) });
            log(`B stratum ${slot.stratum}: ${c.url} FAILED ${String(e?.message ?? e).slice(0, 120)}`);
            save();
          }
        }
      }
    }
  } finally {
    await browser.close();
    save();
  }
}

// ---------------------------------------------------------------- bundle
const clean = (s, max) =>
  stripSiteDataMarkers(String(s ?? ""))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, max);
const red = (s, max = 200) => redactContacts(clean(s, max)).trim();

/** facts.json: what code measured, as the expert and Gemini both see it. No scores, grades or points. */
export function factsFor(site, measured, excerpt) {
  const f = measured.facts ?? {};
  const pl = f.project_links ?? {};
  const view = (v) => (v ? screenFacts(v.links, (s) => red(s, 80)) : null);
  return {
    url: site.url,
    name: red(site.name, 120),
    name_in_page_title: nameMatch(site.name, measured.desktop?.title ?? ""),
    name_in_top_heading: nameMatch(site.name, measured.desktop?.top_heading ?? ""),
    page_title: red(measured.desktop?.title ?? "", 160),
    top_heading: red(measured.desktop?.top_heading ?? "", 160),
    first_screen_links: { desktop: view(measured.desktop), phone: view(measured.phone) },
    resume_link_anywhere: Boolean(f.resume),
    project_links: { checked: pl.checked ?? 0, loaded: pl.ok ?? 0, broken: pl.broken ?? 0, blocked: pl.blocked ?? 0 },
    template_match: f.template ?? null,
    page_text: { parts: excerpt.parts, full_length: excerpt.full_length },
  };
}

function bundle() {
  const sel = readJson(SEL);
  const state = readJson(path.join(RES, "capture-state.json"));
  const oldPlan = readJson(path.join(OLD, "plan.json")).sites;
  const rnd = mulberry32(SEED + 1);
  const manifest = { created_at: new Date().toISOString(), seed: SEED + 1, note: "Bundle ids are assigned in a seeded random order, so an id says nothing about a site's points.", sets: {} };
  const sites = { created_at: manifest.created_at, seed: SEED, sets: {} };
  for (const set of ["A", "B"]) {
    const list =
      set === "A"
        ? [...sel.A.strata.map((s) => ({ ...s.pick, stratum: s.stratum })), { ...sel.A.junk, stratum: "junk" }]
        : Object.entries(state.B).map(([url, v]) => {
            const c = v.stratum === "junk" ? sel.B.junk : sel.B.strata.find((s) => s.stratum === v.stratum).candidates.find((x) => x.url === url);
            return { ...c, stratum: v.stratum };
          });
    if (list.length !== SET_SIZE) throw new Error(`Set ${set} has ${list.length} sites, expected ${SET_SIZE}`);
    const ordered = shuffled(list.sort((a, b) => a.url.localeCompare(b.url)), rnd);
    manifest.sets[set] = [];
    sites.sets[set] = [];
    ordered.forEach((s, i) => {
      const id = `${set}${String(i + 1).padStart(2, "0")}`;
      const dir = path.join(RES, "bundles", set, id);
      fs.mkdirSync(dir, { recursive: true });
      let measured;
      let outline;
      let src;
      if (set === "A") {
        const o = oldPlan.find((x) => x.url === s.url);
        src = path.join(OLD, "sites", o.shot_key);
        fs.copyFileSync(path.join(src, "hero.jpg"), path.join(dir, "desktop.jpg"));
        fs.copyFileSync(path.join(src, "mobile.jpg"), path.join(dir, "phone.jpg"));
        outline = readJson(path.join(src, "outline.json"));
        measured = readJson(path.join(state.A[s.url].dir, "measured.json"));
      } else {
        src = state.B[s.url].dir;
        fs.copyFileSync(path.join(src, "desktop.jpg"), path.join(dir, "desktop.jpg"));
        fs.copyFileSync(path.join(src, "phone.jpg"), path.join(dir, "phone.jpg"));
        outline = readJson(path.join(src, "outline.json"));
        measured = readJson(path.join(src, "measured.json"));
      }
      const ex = buildExcerpt(outline);
      const text = redactContacts(clean(ex.text, 6000)).trim();
      fs.writeFileSync(path.join(dir, "text.txt"), `${text}\n`);
      writeJson(path.join(dir, "facts.json"), factsFor(s, measured, ex));
      const files = Object.fromEntries(["desktop.jpg", "phone.jpg", "text.txt", "facts.json"].map((f) => [f, sha256(fs.readFileSync(path.join(dir, f)))]));
      manifest.sets[set].push({ id, files });
      sites.sets[set].push({
        id,
        url: s.url,
        name: s.name,
        points: s.points,
        stratum: s.stratum,
        junk: s.stratum === "junk",
        images_from: set === "A" ? "2026-11-13 capture of exp/grading-v3" : measured.at,
        facts_measured_at: measured.at,
        text_from: set === "A" ? "2026-11-13 capture of exp/grading-v3" : measured.at,
      });
    });
  }
  writeJson(path.join(RES, "bundles", "manifest.json"), manifest);
  writeJson(path.join(EXP, "sites.json"), sites);
  console.log(`bundles: A ${manifest.sets.A.length}, B ${manifest.sets.B.length}`);
}

// ---------------------------------------------------------------- plan
/**
 * The batch groupings and the repeat lists, the same for both models.
 * Per set: 3 passes of 4 batches of 5 (each site in a different position
 * each pass), pass 1 sent again identically, and 5 sites (never the junk
 * one) sent again solo.
 */
export function makePlan(sites, seed = SEED + 2) {
  const rnd = mulberry32(seed);
  const plan = { seed, batch_size: BATCH, sets: {} };
  for (const set of ["A", "B"]) {
    const ids = sites.sets[set].map((s) => s.id);
    const best = makePasses(ids, rnd);
    const solo_order = shuffled(ids, rnd);
    const repeat = shuffled(sites.sets[set].filter((s) => !s.junk).map((s) => s.id), rnd).slice(0, 5);
    plan.sets[set] = {
      solo_order,
      solo_repeat: repeat,
      passes: Object.fromEntries(best.passes.map((p, i) => [`pass${i + 1}`, p])),
      pairs_sharing_a_batch_twice: best.repeats,
    };
  }
  return plan;
}

/** The fixed order of every request, the same for Gemini and the expert. */
export function requestList(plan) {
  const out = [];
  const solo = (set, step, ids) => ids.forEach((id) => out.push({ key: `${step}/${id}`, step, set, kind: "solo", ids: [id] }));
  const pass = (set, step, src) => plan.sets[set].passes[src].forEach((ids, b) => out.push({ key: `${step}/${set}-b${b + 1}`, step, set, kind: "batch", pass: src, batch: b + 1, ids }));
  for (const set of ["A", "B"]) solo(set, "solo", plan.sets[set].solo_order);
  for (const set of ["A", "B"]) pass(set, "pass1", "pass1");
  for (const set of ["A", "B"]) pass(set, "pass2", "pass2");
  for (const set of ["A", "B"]) pass(set, "pass3", "pass3");
  for (const set of ["A", "B"]) solo(set, "solo-repeat", plan.sets[set].solo_repeat);
  for (const set of ["A", "B"]) pass(set, "pass1-repeat", "pass1");
  // Amendment 2026-11-13, Gemini only: the solo-repeat sites again, with the
  // free-text level_line schema of the batches, to measure the schema change alone.
  for (const set of ["A", "B"]) plan.sets[set].solo_repeat.forEach((id) => out.push({ key: `solo-freetext/${id}`, step: "solo-freetext", set, kind: "solo", schema: "solo_freetext", ids: [id], gemini_only: true }));
  return out;
}

function planStep() {
  const sites = readJson(path.join(EXP, "sites.json"));
  const plan = makePlan(sites);
  plan.requests = requestList(plan);
  plan.created_at = new Date().toISOString();
  writeJson(path.join(EXP, "groupings.json"), plan);
  console.log(`requests per model: ${plan.requests.length}`);
  for (const set of ["A", "B"]) console.log(`Set ${set}: pairs sharing a batch twice ${plan.sets[set].pairs_sharing_a_batch_twice}`);
}

// ---------------------------------------------------------------- expert runs
/** experiments/grading-two-sets/expert-runs.md, generated from groupings.json. */
function expertRuns() {
  const plan = readJson(path.join(EXP, "groupings.json"));
  const B = "~/research/portfoliorank-experiments/grading-two-sets";
  const lines = [
    "# Expert runs (Claude Sonnet)",
    "",
    "Generated from `groupings.json` by `node scripts/experiments/grading-two-sets.mjs expert-runs`; do not edit by hand.",
    "The expert grades the same requests as Gemini, in the same order, with the same groupings and positions.",
    "The expert's first one-at-a-time pass (step `solo`) is the answer key; the other steps measure the expert's own consistency and batch effect.",
    "",
    "## Rules",
    "",
    "- Each request below is graded in a fresh context (a new Sonnet agent) that has seen no other request and no earlier answer.",
    "  A repeat must not know it is a repeat, or the consistency numbers mean nothing.",
    "- Read only these files: `experiments/grading-two-sets/expert-instructions.txt`, `expert-batch-instructions.txt`, `rubric.txt`, this file, and the four files of each bundle named in the request (`desktop.jpg`, `phone.jpg`, `text.txt`, `facts.json`).",
    "- Never open: `experiments/grading-two-sets/prompts/`, `prompt-log.md`, `sites.json`, `lock.json`, anything under `" + B + "` other than `bundles/` and your own `expert/` folder (never `gemini/`, `raw/`, `capture/`, `selection.json` or `analysis.json`), the old `grading-v3` data, the database, or any website.",
    "  Those hold check points, Gemini's prompt or Gemini's answers.",
    "- The prompt for a one-at-a-time request is `expert-instructions.txt` with the line `[rubric: the three parts and their five levels, exactly as shown above]` replaced by the full text of `rubric.txt`.",
    "  The prompt for a 5-at-a-time request is `expert-batch-instructions.txt`, with the same replacement, and the 5 bundles in the order listed.",
    "- Never redo a request whose output file exists, and never edit an output after writing it.",
    "",
    "## Output",
    "",
    "One JSON file per request, at the path given, in this shape (one entry in `answers` per bundle id; `evidence` is the one-line reason; `tips` may be empty strings):",
    "",
    "```json",
    JSON.stringify(
      {
        step: "solo",
        set: "A",
        kind: "solo",
        ids: ["A01"],
        started_at: "2026-11-13T19:00:00Z",
        finished_at: "2026-11-13T19:01:00Z",
        answers: {
          A01: {
            five_second: Object.fromEntries(["name", "clear_role", "way_forward", "notable"].map((q) => [q, { seen: "quoted words, or nothing", desktop: true, phone: true }])),
            visual_design: { evidence: "what you saw", level_line: "the level line that fits", score: 3 },
            project_presentation: { evidence: "...", level_line: "...", score: 3 },
            writing: { evidence: "...", level_line: "...", score: 3 },
            is_portfolio: { reason: "...", answer: true },
            tips: { visual_design: "", project_presentation: "", writing: "" },
          },
        },
      },
      null,
      1
    ),
    "```",
    "",
    "For a 5-at-a-time request, `kind` is `batch`, `ids` lists the 5 bundle ids in the order shown, and `answers` has all 5.",
    "",
    "## Requests, in order",
    "",
    "Bundles live in `" + B + "/bundles/<set>/<id>/`; outputs go in `" + B + "/expert/<step>/`.",
    "",
  ];
  let step = null;
  plan.requests.filter((r) => !r.gemini_only).forEach((r, i) => {
    if (r.step !== step) {
      step = r.step;
      lines.push("", `### Step ${step}`, "");
    }
    const file = `${B}/expert/${r.step}/${r.key.split("/")[1]}.json`;
    lines.push(`${i + 1}. ${r.kind === "solo" ? "One at a time" : `5 at a time (${r.pass}, batch ${r.batch})`}: ${r.ids.join(", ")} -> \`${file}\``);
  });
  fs.writeFileSync(path.join(EXP, "expert-runs.md"), `${lines.join("\n")}\n`);
  console.log(`expert-runs.md: ${plan.requests.filter((r) => !r.gemini_only).length} requests`);
}

// ---------------------------------------------------------------- lock
async function lock() {
  const { SETTINGS } = await import("./grading-two-sets-run.mjs");
  writeJson(path.join(EXP, "settings.json"), SETTINGS);
  const files = [
    "sites.json",
    "groupings.json",
    "rubric.txt",
    "expert-instructions.txt",
    "expert-batch-instructions.txt",
    "expert-runs.md",
    "prompts/solo.txt",
    "prompts/batch.txt",
    "prompts/schema.json",
    "settings.json",
    "pass-rules.json",
    "prompt-log.md",
  ];
  const code = ["scripts/experiments/grading-two-sets.mjs", "scripts/experiments/grading-two-sets-lib.mjs", "scripts/experiments/grading-two-sets-run.mjs", "scripts/experiments/grading-two-sets-analyze.mjs", "pipeline/excerpt.mjs", "pipeline/redact.mjs"];
  const hash = (p) => sha256(fs.readFileSync(p));
  const plan = readJson(path.join(EXP, "groupings.json"));
  const out = {
    locked_at: new Date().toISOString(),
    seed: SEED,
    design: "Symmetric: both sets and both models (Gemini 3.5 Flash-Lite and Claude Sonnet) go through the same 41 requests per set: 20 one at a time; batched pass 1 (4 batches of 5); passes 2 and 3 (new groupings and positions); 5 sites sent again one at a time with an identical request; pass 1 sent again identically. The expert's first one-at-a-time pass is the answer key.",
    requests_per_model: plan.requests.length,
    gemini_hard_stop: SETTINGS.hard_stop,
    files: Object.fromEntries(files.map((f) => [`experiments/grading-two-sets/${f}`, hash(path.join(EXP, f))])),
    code: Object.fromEntries(code.map((f) => [f, hash(path.join(EXP, "..", "..", f))])),
    bundles_manifest: hash(path.join(RES, "bundles", "manifest.json")),
  };
  writeJson(path.join(EXP, "lock.json"), out);
  console.log(`locked at ${out.locked_at}`);
}

/** Append a dated amendment to lock.json with the hashes as they are now; the original lock stays as it was. */
async function amend(note) {
  if (!note) throw new Error("amend needs --note TEXT");
  const lockPath = path.join(EXP, "lock.json");
  const before = readJson(lockPath);
  const { SETTINGS } = await import("./grading-two-sets-run.mjs");
  writeJson(path.join(EXP, "settings.json"), SETTINGS);
  const hash = (p) => sha256(fs.readFileSync(p));
  const files = Object.fromEntries(Object.keys(before.files).map((f) => [f, hash(path.join(REPO_ROOT, f))]));
  const codeFiles = [...new Set([...Object.keys(before.code), "scripts/experiments/grading-two-sets-claude.mjs", "tests/grading-two-sets.test.mjs"])].filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  const code = Object.fromEntries(codeFiles.map((f) => [f, hash(path.join(REPO_ROOT, f))]));
  const prev = { ...before.files, ...before.code, ...Object.assign({}, ...(before.amendments ?? []).map((a) => ({ ...a.files, ...a.code }))) };
  const changed = Object.entries({ ...files, ...code }).filter(([f, h]) => prev[f] !== h).map(([f]) => f);
  const plan = readJson(path.join(EXP, "groupings.json"));
  (before.amendments ??= []).push({ at: new Date().toISOString(), note, requests_gemini: plan.requests.length, requests_expert: plan.requests.filter((r) => !r.gemini_only).length, changed, files, code });
  writeJson(lockPath, before);
  console.log(`amended at ${before.amendments.at(-1).at}; changed: ${changed.join(", ")}`);
}
const REPO_ROOT = path.join(EXP, "..", "..");

// ---------------------------------------------------------------- main
async function main() {
  const [step, ...rest] = process.argv.slice(2);
  const flag = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);
  if (step === "capture") return capture({ only: flag("only") });
  if (step === "bundle") return bundle();
  if (step === "plan") return planStep();
  if (step === "expert-runs") return expertRuns();
  if (step === "lock") return lock();
  if (step === "amend") return amend(flag("note"));
  if (step === "select") {
    const { pipelineDb } = await import("../../pipeline/roster.mjs");
    if (!process.env.TURSO_DATABASE_URL) throw new Error("select reads the production DB: run through pass-env with TURSO_DATABASE_URL");
    return select({ db: pipelineDb(path.join(import.meta.dirname, "..", "..")), junkB: flag("junk-b") });
  }
  console.error("usage: grading-two-sets.mjs <select --junk-b URL|capture [--only A|B]|bundle|plan>");
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
