#!/usr/bin/env node
// Experiment: rubric v3 against rubric v2, solo against batches of 5, and
// today's evidence against richer evidence, all measured against an answer
// key (a hand ranking of the same 40 portfolios, answer-key.json) and against
// themselves (two runs). Owner-approved spending on 3.5 Flash-Lite
// (2026-11-13). It never writes a grade, rating or tier: everything goes to
// local files in --out. The only database write is the request log
// (gemini_requests, job "exp-grading-v3", prompt grade-v2 / grade-v3 /
// grade-v3-rich / grade-v3-batch), so the quota day counts the calls.
//
// Steps (each resumable; a finished request is never repeated):
//   sample   read-only: 40 slots spread over the stored v2 scores of live
//            portfolios with a saved screenshot and text, with backups.
//   capture  local Playwright, no Gemini: per site the desktop top
//            (1440x900), the phone top (390x844), the projects section, the
//            full page, and the page outline (full text + projects section).
//   sheets   one viewing sheet per site for the answer key.
//   run      the Gemini requests (A, B and C below).
//   analyze  agreement with the answer key and with itself.
//
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY \
//     -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- npm run exp:grading-v3 -- <step> --out DIR
//
// Flags: --out DIR (required) --model M --seed S (3) --rpm R (10)
//        --max-requests N (300, retries included, across restarts)
//        --day-cap N (430, the model's requests this Pacific quota day)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PRIMARY_MODEL, createGemini, createLimiter } from "../../pipeline/gemini.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { AI_CRITERIA, RESPONSE_SCHEMA, buildRubricRequest, checksScore, codeChecks, normalizePageText, parseRubricResponse, qualityScore, versionOf } from "../../pipeline/rubric.mjs";
import { buildV3BatchRequest, buildV3Request, parseV3BatchResponse, parseV3Response, batchIds, V3_AXES } from "../../pipeline/rubric-v3.mjs";
import { OUTLINE_ARGS, buildExcerpt, readPageOutline } from "../../pipeline/excerpt.mjs";
import { UA, readRenderedPage } from "../../pipeline/gate.mjs";
import { pngDiff } from "../../pipeline/png-diff.mjs";
import { layouts, mulberry32, shuffled, spearman, weightedScore } from "./batch-grading.mjs";

export const N_SITES = 40;
export const BATCH = 5;
export const JOB = "exp-grading-v3";

// The pass/fail rules, fixed before any request (written into plan.json).
export const RULES = {
  A: "v3 passes when its mean Spearman with the answer key (over its 2 runs) is higher than v2's, and its run-1 vs run-2 Spearman is no more than 0.05 below v2's.",
  B: "Batches of 5 pass when (1) the mean per-site distance between a batch grade and a solo grade (quality, 1-5) is no more than solo-vs-solo distance + 0.05, and (2) the batch runs' mean Spearman with the key is no more than max(0.03, the gap between the two solo runs' Spearman) below the solo runs' mean.",
  C: "Richer evidence passes when its mean Spearman with the key is higher than v3 solo's by more than the gap between v3 solo's two runs (so the gain is larger than run-to-run noise), and its Kendall tau is higher too.",
};

const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const storedScore = (g) => weightedScore(qualityScore(g), typeof g?.checks_score === "number" ? g.checks_score : null);

// ---------------------------------------------------------------- sample
async function sample({ db, ACTIVE, OUT, SEED, SHOTS }) {
  const res = await db.execute(
    `SELECT url, name, shot_key, ai_rubric, page_text, facts FROM portfolios
     WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
       AND json_valid(ai_rubric) AND json_extract(ai_rubric, '$.error') IS NULL
     ORDER BY url`
  );
  const rows = res.rows.map((r) => ({ ...r, grade: parseJson(r.ai_rubric) }));
  const eligible = rows
    .filter((r) => versionOf(r.grade) === 2 && r.grade?.is_portfolio !== false && r.page_text != null && parseJson(r.facts) && typeof storedScore(r.grade) === "number")
    .map((r) => ({ ...r, stored_score: storedScore(r.grade) }))
    .sort((a, b) => b.stored_score - a.stored_score || String(a.url).localeCompare(String(b.url)));
  console.log(`graded rows ${rows.length}; eligible v2 portfolios with text, facts and a screenshot: ${eligible.length}`);
  const rnd = mulberry32(SEED);
  const used = new Set();
  const slots = [];
  for (let k = 0; k < N_SITES; k++) {
    const at = (k + 0.5) / N_SITES;
    const centre = Math.floor(at * eligible.length);
    const window = shuffled(eligible.slice(Math.max(0, centre - 4), centre + 5), rnd).filter((r) => !used.has(String(r.url)));
    const candidates = [];
    for (const r of window) {
      if (candidates.length >= 4) break;
      const ok = await fetch(`${SHOTS}/${r.shot_key}/hero.jpg`, { method: "HEAD", signal: AbortSignal.timeout(15000) }).then((x) => x.ok).catch(() => false);
      if (!ok) continue;
      used.add(String(r.url));
      candidates.push({
        url: String(r.url),
        name: String(r.name ?? ""),
        shot_key: String(r.shot_key),
        stored: r.grade,
        stored_quality: qualityScore(r.grade),
        stored_score: r.stored_score,
        checks_score: typeof r.grade.checks_score === "number" ? r.grade.checks_score : checksScore(codeChecks(parseJson(r.facts))),
        stored_text: String(r.page_text),
        facts: parseJson(r.facts),
      });
    }
    slots.push({ slot: k + 1, at: Math.round(at * 1000) / 10, candidates });
    process.stdout.write(`slot ${k + 1}: ${candidates.length} candidates\n`);
  }
  fs.writeFileSync(path.join(OUT, "candidates.json"), `${JSON.stringify({ created_at: new Date().toISOString(), seed: SEED, eligible: eligible.length, library_scores: eligible.map((r) => r.stored_score), slots }, null, 1)}\n`);
}

// ---------------------------------------------------------------- capture
async function captureOne(browser, site, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    await page.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const first = await page.evaluate(readRenderedPage);
    if (first.text.trim().length < 30 && !first.media) throw new Error("renders blank");
    // Settle like the production capture: two quiet polls, at most 6.
    let prev = await page.screenshot({ type: "png" });
    let quiet = 0;
    for (let i = 0; i < 6 && quiet < 2; i++) {
      await page.waitForTimeout(2000);
      const cur = await page.screenshot({ type: "png" });
      quiet = pngDiff(prev, cur) < 0.01 ? quiet + 1 : 0;
      prev = cur;
    }
    fs.writeFileSync(path.join(dir, "hero.jpg"), await page.screenshot({ type: "jpeg", quality: 75 }));
    // Scroll through the page so scroll-triggered sections render, then back.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < Math.min(height, 20000); y += 700) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(800);
    const outline = await page.evaluate(readPageOutline, OUTLINE_ARGS);
    const target = outline.projects?.top ?? 900;
    await page.evaluate((v) => window.scrollTo(0, v), target);
    await page.waitForTimeout(1500);
    fs.writeFileSync(path.join(dir, "projects.jpg"), await page.screenshot({ type: "jpeg", quality: 75 }));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
    const full = await page.screenshot({ type: "jpeg", quality: 60, fullPage: true }).catch(() => null);
    if (full) fs.writeFileSync(path.join(dir, "full.jpg"), full);
    fs.writeFileSync(path.join(dir, "outline.json"), `${JSON.stringify({ ...outline, final_url: page.url() }, null, 1)}\n`);
  } finally {
    await ctx.close().catch(() => {});
  }
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", ignoreHTTPSErrors: true });
  try {
    const m = await mctx.newPage();
    await m.goto(site.url, { waitUntil: "load", timeout: 30000 });
    await m.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    await m.waitForTimeout(3000);
    fs.writeFileSync(path.join(dir, "mobile.jpg"), await m.screenshot({ type: "jpeg", quality: 75 }));
  } finally {
    await mctx.close().catch(() => {});
  }
}

/** Redo only the outline and the projects screenshot (after a change to the projects finder). */
async function reoutline({ OUT }) {
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, "plan.json"), "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const queue = [...plan.sites];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const dir = path.join(OUT, "sites", s.shot_key);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ignoreHTTPSErrors: true });
      try {
        const page = await ctx.newPage();
        await page.goto(s.url, { waitUntil: "load", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(4000);
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0; y < Math.min(height, 20000); y += 700) {
          await page.evaluate((v) => window.scrollTo(0, v), y);
          await page.waitForTimeout(120);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);
        const outline = await page.evaluate(readPageOutline, OUTLINE_ARGS);
        await page.evaluate((v) => window.scrollTo(0, v), outline.projects?.top ?? 900);
        await page.waitForTimeout(1500);
        fs.writeFileSync(path.join(dir, "projects.jpg"), await page.screenshot({ type: "jpeg", quality: 75 }));
        fs.writeFileSync(path.join(dir, "outline.json"), `${JSON.stringify({ ...outline, final_url: page.url() }, null, 1)}\n`);
        console.log(`slot ${s.slot}: ${s.url} (${outline.text.length} chars, projects ${outline.projects ? JSON.stringify(outline.projects.heading) : "not found"})`);
      } catch (e) {
        console.log(`slot ${s.slot}: ${s.url} kept the first outline: ${String(e?.message ?? e).slice(0, 120)}`);
      } finally {
        await ctx.close().catch(() => {});
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  await browser.close();
}

async function capture({ OUT }) {
  const cand = JSON.parse(fs.readFileSync(path.join(OUT, "candidates.json"), "utf8"));
  const planPath = path.join(OUT, "plan.json");
  const state = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, "utf8")) : { sites: [], failures: [] };
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const done = new Set(state.sites.map((s) => s.slot));
  const queue = cand.slots.filter((s) => !done.has(s.slot));
  const worker = async () => {
    for (let slot = queue.shift(); slot; slot = queue.shift()) {
      for (const c of slot.candidates) {
        if (state.failures.some((f) => f.url === c.url)) continue;
        const dir = path.join(OUT, "sites", c.shot_key);
        try {
          await captureOne(browser, c, dir);
          const outline = JSON.parse(fs.readFileSync(path.join(dir, "outline.json"), "utf8"));
          if (normalizePageText(outline.text).length < 30) throw new Error("no text");
          state.sites.push({ slot: slot.slot, at: slot.at, ...c, stored_text: undefined, stored_text_length: c.stored_text.length });
          console.log(`slot ${slot.slot}: ${c.url} ok (${outline.text.length} chars, projects ${outline.projects ? JSON.stringify(outline.projects.heading) : "not found"})`);
          break;
        } catch (e) {
          state.failures.push({ slot: slot.slot, url: c.url, why: String(e?.message ?? e).slice(0, 200) });
          console.log(`slot ${slot.slot}: ${c.url} failed: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
      state.sites.sort((a, b) => a.slot - b.slot);
      fs.writeFileSync(planPath, `${JSON.stringify(state, null, 1)}\n`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await browser.close();
  console.log(`captured ${state.sites.length} of ${cand.slots.length} slots`);
}

// ---------------------------------------------------------------- evidence
function evidence(OUT, s) {
  const dir = path.join(OUT, "sites", s.shot_key);
  const img = (f) => (fs.existsSync(path.join(dir, f)) ? { inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(path.join(dir, f)).toString("base64") } } : null);
  const outline = JSON.parse(fs.readFileSync(path.join(dir, "outline.json"), "utf8"));
  const ex = buildExcerpt(outline);
  return {
    name: s.name,
    url: s.url,
    facts: s.facts,
    pageText: normalizePageText(outline.text), // v2: the first 4,000 characters, as production stores it
    excerpt: ex.text,
    excerptInfo: { parts: ex.parts, full_length: ex.full_length, projects_found: ex.projects_found },
    projectsFound: Boolean(outline.projects),
    image: img("hero.jpg"),
    mobile: img("mobile.jpg"),
    projectsShot: img("projects.jpg"),
  };
}

// ---------------------------------------------------------------- sheets
async function sheets({ OUT }) {
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, "plan.json"), "utf8"));
  const sharp = (await import("sharp")).default;
  const outDir = path.join(OUT, "sheets");
  fs.mkdirSync(outDir, { recursive: true });
  // Sheets are numbered in a shuffled order so the stored score never shows.
  const order = shuffled(plan.sites.map((s) => s.url), mulberry32(77));
  const index = [];
  for (const [i, url] of order.entries()) {
    const s = plan.sites.find((x) => x.url === url);
    const dir = path.join(OUT, "sites", s.shot_key);
    const n = String(i + 1).padStart(2, "0");
    const hero = await sharp(path.join(dir, "hero.jpg")).resize(960, 600).toBuffer();
    const proj = await sharp(path.join(dir, "projects.jpg")).resize(960, 600).toBuffer();
    const mob = await sharp(path.join(dir, "mobile.jpg")).resize(390, 844, { fit: "contain", background: "#888" }).resize(277, 600).toBuffer();
    await sharp({ create: { width: 960 + 277 + 10, height: 1210, channels: 3, background: "#888888" } })
      .composite([
        { input: hero, left: 0, top: 0 },
        { input: proj, left: 0, top: 610 },
        { input: mob, left: 970, top: 0 },
      ])
      .jpeg({ quality: 70 })
      .toFile(path.join(outDir, `${n}.jpg`));
    if (fs.existsSync(path.join(dir, "full.jpg"))) {
      const meta = await sharp(path.join(dir, "full.jpg")).metadata();
      const h = Math.min(meta.height, 9000);
      await sharp(path.join(dir, "full.jpg")).extract({ left: 0, top: 0, width: meta.width, height: h }).resize(Math.round(meta.width / 4)).jpeg({ quality: 60 }).toFile(path.join(outDir, `${n}-full.jpg`));
    }
    const outline = JSON.parse(fs.readFileSync(path.join(dir, "outline.json"), "utf8"));
    const ex = buildExcerpt(outline);
    fs.writeFileSync(path.join(outDir, `${n}.txt`), `${s.name}\n${s.url}\nfull text ${ex.full_length} chars; projects ${outline.projects ? JSON.stringify(outline.projects.heading) : "not found"}\n\n${normalizePageText(outline.text, 7000)}\n`);
    index.push({ sheet: n, url });
  }
  fs.writeFileSync(path.join(outDir, "index.json"), `${JSON.stringify(index, null, 1)}\n`);
  console.log(`${index.length} sheets in ${outDir}`);
}

// ---------------------------------------------------------------- run
export function jobsFor(plan, seed) {
  const urls = plan.sites.map((s) => s.url);
  const rnd = mulberry32(seed);
  const b5 = layouts(urls, BATCH, 2, rnd);
  const jobs = [];
  for (const run of [1, 2]) {
    for (const u of shuffled(urls, rnd)) {
      jobs.push({ id: `v2:${run}:${u}`, kind: "v2", run, urls: [u] });
      jobs.push({ id: `v3:${run}:${u}`, kind: "v3", run, urls: [u] });
      jobs.push({ id: `rich:${run}:${u}`, kind: "rich", run, urls: [u] });
      // Follow-up after A, B and C (not one of the pre-set rules): the
      // audit's open question, thinking "low" against "minimal".
      jobs.push({ id: `v3low:${run}:${u}`, kind: "v3low", run, urls: [u] });
    }
    b5[run - 1].forEach((batch, b) => jobs.push({ id: `b5:${run}:${b}`, kind: "b5", run, batch: b, urls: batch }));
    // Follow-up: the same batches with thinking "low".
    b5[run - 1].forEach((batch, b) => jobs.push({ id: `b5low:${run}:${b}`, kind: "b5low", run, batch: b, urls: batch }));
  }
  return { jobs, b5 };
}

async function run({ db, OUT, MODEL, SEED, RPM, MAX_REQUESTS, DAY_CAP }) {
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, "plan.json"), "utf8"));
  if (plan.sites.length !== N_SITES) throw new Error(`plan has ${plan.sites.length} sites, expected ${N_SITES}`);
  plan.rules ??= RULES;
  const { jobs, b5 } = jobsFor(plan, SEED);
  plan.b5 ??= b5;
  fs.writeFileSync(path.join(OUT, "plan.json"), `${JSON.stringify(plan, null, 1)}\n`);
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
  const statePath = path.join(OUT, "results.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { model: MODEL, http_requests: 0, requests: [], items: {} };
  const save = () => fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  const byUrl = new Map(plan.sites.map((s) => [s.url, s]));
  const ev = new Map();
  const evOf = (u) => {
    if (!ev.has(u)) ev.set(u, evidence(OUT, byUrl.get(u)));
    return ev.get(u);
  };
  if (!process.env.GEMINI_API_KEY) throw new Error("Needs GEMINI_API_KEY (run through pass-env).");
  await ensureGeminiLog(db);
  const usedToday = async () => (await dailyTotals(db)).used.get(MODEL)?.n ?? 0;
  const todo = jobs.filter((j) => !state.items[j.id]?.grades && (!only || only.includes(j.kind)));
  console.log(`${MODEL}: ${await usedToday()} used today; day cap ${DAY_CAP}; ${todo.length} jobs to do; this run may send up to ${MAX_REQUESTS - state.http_requests}`);
  const requestLog = createRequestLog({ db, job: JOB });
  const counted = async (url, init) => {
    if (state.http_requests >= MAX_REQUESTS) throw new Error(`hard stop: ${MAX_REQUESTS} requests used`);
    const used = await usedToday();
    if (used >= DAY_CAP) throw new Error(`hard stop: ${MODEL} has ${used} requests today (cap ${DAY_CAP})`);
    state.http_requests++;
    save();
    return fetch(url, init);
  };
  const gemini = createGemini({
    apiKey: process.env.GEMINI_API_KEY,
    models: [MODEL],
    limiter: createLimiter({ rpm: RPM }),
    onRequest: (r) => {
      state.requests.push(r);
      return requestLog.record(r);
    },
    onDailyQuota: "stop",
    retryBudget: 40,
    fetchImpl: counted,
  });
  let n = 0;
  for (const job of todo) {
    const sites = job.urls.map(evOf);
    const req =
      job.kind === "v2"
        ? { ...buildRubricRequest(sites[0]), schema: RESPONSE_SCHEMA }
        : job.kind === "v3"
          ? buildV3Request(sites[0])
          : job.kind === "rich"
            ? buildV3Request(sites[0], { rich: true })
            : job.kind === "v3low"
              ? (({ parts, schema, options }) => ({ parts, schema, options: { ...options, thinkingLevel: "low", prompt: "grade-v3-think-low" } }))(buildV3Request(sites[0]))
              : job.kind === "b5low"
                ? (({ parts, schema, options }) => ({ parts, schema, options: { ...options, thinkingLevel: "low", prompt: "grade-v3-batch-think-low" } }))(buildV3BatchRequest(sites))
                : buildV3BatchRequest(sites);
    const item = { ...job, at: new Date().toISOString(), prompt: req.options.prompt };
    try {
      const { result, usage } = await gemini.generate(req.parts, req.schema, req.options);
      item.usage = usage;
      item.raw = result;
      try {
        if (job.kind === "v2") item.grades = { [job.urls[0]]: parseRubricResponse(result) };
        else if (job.kind === "b5" || job.kind === "b5low") {
          const p = parseV3BatchResponse(result, job.urls.length);
          const ids = batchIds(job.urls.length);
          item.grades = Object.fromEntries(Object.entries(p.grades).map(([id, g]) => [job.urls[ids.indexOf(id)], g]));
          item.order = p.order.map((id) => job.urls[ids.indexOf(id)]);
        } else item.grades = { [job.urls[0]]: parseV3Response(result) };
      } catch (e) {
        item.broken = String(e?.message ?? e).slice(0, 300);
      }
    } catch (e) {
      item.error = `${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}`;
      state.items[job.id] = item;
      save();
      if (/hard stop|GeminiQuotaError|GeminiAuthError|RetryBudget/.test(item.error)) {
        console.log(`${job.id}: ${item.error}; stopping`);
        break;
      }
      continue;
    }
    state.items[job.id] = item;
    save();
    n++;
    console.log(`[${n}/${todo.length}] ${job.id} ${item.broken ? `BROKEN ${item.broken}` : `ok in ${item.usage?.inputTokens} out ${item.usage?.outputTokens} think ${item.usage?.thoughtsTokens ?? 0}`} (http ${state.http_requests})`);
  }
  console.log(`requests this run: ${gemini.summary()}; request log write errors: ${requestLog.writeErrors}; used today now ${await usedToday()}`);
}

// ---------------------------------------------------------------- analysis
function ranksOf(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
/** Kendall tau-b (ties handled). */
export function kendall(a, b) {
  let c = 0;
  let d = 0;
  let ta = 0;
  let tb = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const x = Math.sign(a[i] - a[j]);
      const y = Math.sign(b[i] - b[j]);
      if (x === 0 && y === 0) continue;
      if (x === 0) ta++;
      else if (y === 0) tb++;
      else if (x === y) c++;
      else d++;
    }
  }
  const den = Math.sqrt((c + d + ta) * (c + d + tb));
  return den ? (c - d) / den : null;
}
/** Overlap of the top (or bottom) k by value with the key's top (or bottom) k. */
function overlap(values, keyScore, k, top) {
  const urls = Object.keys(keyScore);
  const pick = (f) => [...urls].sort((x, y) => (top ? f(y) - f(x) : f(x) - f(y)) || x.localeCompare(y)).slice(0, k);
  // Ties at the edge: a site tied with the k-th counts when the key's pick includes it.
  const kk = new Set(pick((u) => keyScore[u]));
  const sorted = [...urls].sort((x, y) => (top ? values[y] - values[x] : values[x] - values[y]));
  const edge = values[sorted[k - 1]];
  const inMine = sorted.filter((u, i) => i < k || values[u] === edge);
  const hits = inMine.filter((u) => kk.has(u)).length;
  return Math.min(k, hits);
}
function agreement(values, keyScore) {
  const urls = Object.keys(keyScore).filter((u) => typeof values[u] === "number");
  const a = urls.map((u) => values[u]);
  const b = urls.map((u) => keyScore[u]);
  const v = Object.fromEntries(urls.map((u) => [u, values[u]]));
  const ks = Object.fromEntries(urls.map((u) => [u, keyScore[u]]));
  return { n: urls.length, spearman: spearman(a, b), kendall: kendall(a, b), top10: overlap(v, ks, 10, true), bottom10: overlap(v, ks, 10, false) };
}
/** Paired bootstrap over sites of spearman(x, key) - spearman(y, key): mean, 90% interval, share > 0. */
function bootDiff(x, y, keyScore, iters = 4000, seed = 9) {
  const urls = Object.keys(keyScore).filter((u) => typeof x[u] === "number" && typeof y[u] === "number");
  const rnd = mulberry32(seed);
  const ds = [];
  for (let t = 0; t < iters; t++) {
    const s = urls.map(() => urls[Math.floor(rnd() * urls.length)]);
    const k = s.map((u) => keyScore[u]);
    const dx = spearman(s.map((u) => x[u]), k);
    const dy = spearman(s.map((u) => y[u]), k);
    if (dx != null && dy != null) ds.push(dx - dy);
  }
  ds.sort((a, b) => a - b);
  return { mean: mean(ds), lo: ds[Math.floor(0.05 * ds.length)], hi: ds[Math.floor(0.95 * ds.length)], p_gt0: ds.filter((d) => d > 0).length / ds.length };
}

export function analyze(OUT) {
  const plan = JSON.parse(fs.readFileSync(path.join(OUT, "plan.json"), "utf8"));
  const state = JSON.parse(fs.readFileSync(path.join(OUT, "results.json"), "utf8"));
  const key = JSON.parse(fs.readFileSync(path.join(OUT, "answer-key.json"), "utf8"));
  const urls = plan.sites.map((s) => s.url);
  // Key score: higher is better (41 - place).
  const place = Object.fromEntries(key.ranking.map((r) => [r.url, r.place]));
  const keyScore = Object.fromEntries(urls.map((u) => [u, N_SITES + 1 - place[u]]));
  const items = Object.values(state.items).filter((i) => i.grades);
  // q[mode][run][url] = quality score
  const q = {};
  const axes = {};
  for (const i of items) {
    for (const [u, g] of Object.entries(i.grades)) {
      ((q[i.kind] ??= {})[i.run] ??= {})[u] = qualityScore(g);
      ((axes[i.kind] ??= {})[i.run] ??= {})[u] = Object.fromEntries(AI_CRITERIA.map((c) => [c.id, g[c.id].score]));
    }
  }
  const modes = ["v2", "v3", "b5", "rich", "v3low", "b5low"];
  const label = { stored: "Production v2 (stored grade)", v2: "v2 solo", v3: "v3 solo", b5: "v3 batch of 5", rich: "v3 solo, richer evidence", v3low: "v3 solo, thinking low (follow-up)", b5low: "v3 batch of 5, thinking low (follow-up)" };
  const meanOf = (m) => Object.fromEntries(urls.map((u) => {
    const xs = [1, 2].map((r) => q[m]?.[r]?.[u]).filter((x) => typeof x === "number");
    return [u, xs.length ? mean(xs) : null];
  }));
  const stored = Object.fromEntries(plan.sites.map((s) => [s.url, s.stored_quality]));
  const res = { modes: {}, rules: plan.rules ?? RULES };
  res.modes.stored = { runs: { 1: agreement(stored, keyScore) } };
  for (const m of modes) {
    if (!q[m]) continue;
    const runs = Object.fromEntries([1, 2].filter((r) => q[m][r]).map((r) => [r, agreement(q[m][r], keyScore)]));
    const both = urls.filter((u) => typeof q[m][1]?.[u] === "number" && typeof q[m][2]?.[u] === "number");
    const retest = both.length > 2 ? {
      n: both.length,
      spearman: spearman(both.map((u) => q[m][1][u]), both.map((u) => q[m][2][u])),
      mean_abs_diff: mean(both.map((u) => Math.abs(q[m][1][u] - q[m][2][u]))),
      axis_exact: mean(both.flatMap((u) => AI_CRITERIA.map((c) => (axes[m][1][u][c.id] === axes[m][2][u][c.id] ? 1 : 0)))),
    } : null;
    const all = [1, 2].flatMap((r) => Object.values(axes[m][r] ?? {}));
    const spread = Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { fives: mean(all.map((a) => (a[c.id] === 5 ? 1 : 0))), mean: mean(all.map((a) => a[c.id])), dist: [1, 2, 3, 4, 5].map((v) => all.filter((a) => a[c.id] === v).length) }]));
    const qs = [1, 2].flatMap((r) => Object.values(q[m][r] ?? {}));
    res.modes[m] = {
      runs,
      mean_of_runs: agreement(meanOf(m), keyScore),
      mean_spearman: mean(Object.values(runs).map((r) => r.spearman)),
      mean_kendall: mean(Object.values(runs).map((r) => r.kendall)),
      spearman_gap: runs[1] && runs[2] ? Math.abs(runs[1].spearman - runs[2].spearman) : null,
      retest,
      spread,
      quality_sd: qs.length > 1 ? Math.sqrt(mean(qs.map((x) => (x - mean(qs)) ** 2))) : null,
      quality_range: qs.length ? [Math.min(...qs), Math.max(...qs)] : null,
    };
  }
  // A: v3 vs v2.
  const M = res.modes;
  const verdicts = {};
  if (M.v2 && M.v3) {
    const better = M.v3.mean_spearman > M.v2.mean_spearman;
    const steady = M.v3.retest && M.v2.retest && M.v3.retest.spearman >= M.v2.retest.spearman - 0.05;
    verdicts.A = { pass: Boolean(better && steady), better, steady, boot: bootDiff(meanOf("v3"), meanOf("v2"), keyScore) };
  }
  // B: batch drift and agreement.
  if (M.v3 && M.b5) {
    const soloSolo = mean(urls.filter((u) => q.v3[1]?.[u] != null && q.v3[2]?.[u] != null).map((u) => Math.abs(q.v3[1][u] - q.v3[2][u])));
    const batchSolo = mean(urls.flatMap((u) => [1, 2].flatMap((rb) => [1, 2].map((rs) => (q.b5[rb]?.[u] != null && q.v3[rs]?.[u] != null ? Math.abs(q.b5[rb][u] - q.v3[rs][u]) : null)))).filter((x) => x != null));
    const shift = mean(urls.flatMap((u) => [1, 2].map((rb) => (q.b5[rb]?.[u] != null && meanOf("v3")[u] != null ? q.b5[rb][u] - meanOf("v3")[u] : null))).filter((x) => x != null));
    const tol = Math.max(0.03, M.v3.spearman_gap ?? 0);
    const drift = batchSolo <= soloSolo + 0.05;
    const agree = M.b5.mean_spearman >= M.v3.mean_spearman - tol;
    // The batch's own order: share of within-batch pairs it orders like the key, and the same for the solo and batch scores.
    const pairsIn = (scoreOf) => {
      let ok = 0;
      let n = 0;
      for (const i of items.filter((x) => x.kind === "b5" && x.order)) {
        for (let a = 0; a < i.urls.length; a++) for (let b = a + 1; b < i.urls.length; b++) {
          const [x, y] = [i.urls[a], i.urls[b]];
          const s = Math.sign(scoreOf(i, x) - scoreOf(i, y));
          const k = Math.sign(keyScore[x] - keyScore[y]);
          n++;
          ok += s === 0 ? 0.5 : s === k ? 1 : 0;
        }
      }
      return n ? ok / n : null;
    };
    const orderShare = pairsIn((i, u) => i.urls.length - i.order.indexOf(u));
    const batchScoreShare = pairsIn((i, u) => qualityScore(i.grades[u]));
    const soloScoreShare = pairsIn((i, u) => meanOf("v3")[u]);
    const position = Array.from({ length: BATCH }, (_, p) => {
      const offs = items.filter((x) => x.kind === "b5").map((i) => {
        const u = i.urls[p];
        return meanOf("v3")[u] != null ? qualityScore(i.grades[u]) - meanOf("v3")[u] : null;
      }).filter((x) => x != null);
      const firsts = items.filter((x) => x.kind === "b5" && x.order).filter((i) => i.order[0] === i.urls[p]).length;
      return { shown: p + 1, mean_offset: mean(offs), ordered_first: firsts, n: offs.length };
    });
    verdicts.B = { pass: Boolean(drift && agree), drift_ok: drift, agree_ok: agree, solo_vs_solo: soloSolo, batch_vs_solo: batchSolo, mean_shift: shift, tolerance: tol, order_pairs_like_key: orderShare, batch_scores_pairs_like_key: batchScoreShare, solo_scores_pairs_like_key: soloScoreShare, position };
  }
  // C: richer evidence.
  if (M.v3 && M.rich) {
    const gain = M.rich.mean_spearman - M.v3.mean_spearman;
    const pass = gain > (M.v3.spearman_gap ?? 0) && M.rich.mean_kendall > M.v3.mean_kendall;
    verdicts.C = { pass, gain, noise: M.v3.spearman_gap, boot: bootDiff(meanOf("rich"), meanOf("v3"), keyScore) };
  }
  res.verdicts = verdicts;
  // The answer key's own consistency: pass 2 against pass 1 on the same sites.
  if (key.second_pass?.ranking?.length) {
    const sp = key.second_pass.ranking;
    const us = sp.map((r) => r.url);
    const firstOrder = [...us].sort((a, b) => place[a] - place[b]);
    const p1 = us.map((u) => firstOrder.indexOf(u) + 1);
    const p2 = us.map((u) => sp.find((r) => r.url === u).place);
    res.key_consistency = { n: us.length, spearman: spearman(p1.map((x) => -x), p2.map((x) => -x)), kendall: kendall(p1.map((x) => -x), p2.map((x) => -x)), max_place_move: Math.max(...us.map((_, i) => Math.abs(p1[i] - p2[i]))) };
    // The models on the same 15, for scale.
    res.key_consistency.models_on_same = Object.fromEntries(["v2", "v3", "b5", "rich", "v3low", "b5low"].filter((m) => q[m]).map((m) => {
      const v = meanOf(m);
      return [m, spearman(us.map((u) => v[u]), us.map((u) => keyScore[u]))];
    }));
  }
  // Per site, for the report.
  res.sites = plan.sites.map((s) => ({
    url: s.url,
    name: s.name,
    key_place: place[s.url],
    stored_quality: s.stored_quality,
    ...Object.fromEntries(modes.filter((m) => q[m]).map((m) => [m, [1, 2].map((r) => q[m][r]?.[s.url] ?? null)])),
  }));
  // Requests and tokens.
  const reqs = state.requests ?? [];
  const byPrompt = {};
  for (const i of Object.values(state.items)) {
    const b = (byPrompt[i.prompt ?? i.kind] ??= { requests: 0, ok: 0, broken: 0, errors: 0, input: 0, output: 0, thoughts: 0 });
    b.requests++;
    if (i.grades) b.ok++;
    if (i.broken) b.broken++;
    if (i.error) b.errors++;
    b.input += i.usage?.inputTokens ?? 0;
    b.output += i.usage?.outputTokens ?? 0;
    b.thoughts += i.usage?.thoughtsTokens ?? 0;
  }
  res.requests = { http: state.http_requests, logged: reqs.length, non200: reqs.filter((r) => r.status !== 200).length, by_status: reqs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] ?? 0) + 1 }), {}), by_prompt: byPrompt };
  res.labels = label;
  fs.writeFileSync(path.join(OUT, "analysis.json"), `${JSON.stringify(res, null, 1)}\n`);
  return res;
}

// ---------------------------------------------------------------- main
async function main() {
  const args = process.argv.slice(2);
  const step = args[0];
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const OUT = flag("out", "");
  if (!OUT || !step) {
    console.error("usage: grading-v3.mjs <sample|capture|sheets|run|analyze> --out DIR");
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const o = {
    OUT,
    MODEL: flag("model", PRIMARY_MODEL),
    SEED: Number(flag("seed", "3")),
    RPM: Number(flag("rpm", "10")),
    MAX_REQUESTS: Number(flag("max-requests", "300")),
    DAY_CAP: Number(flag("day-cap", "430")),
    SHOTS: flag("shots", "https://portfoliorank.n8builds.dev/shots").replace(/\/+$/, ""),
  };
  if (step === "capture") return capture(o);
  if (step === "reoutline") return reoutline(o);
  if (step === "sheets") return sheets(o);
  if (step === "analyze") return console.log(JSON.stringify(analyze(OUT).verdicts, null, 1));
  const { pipelineDb, ACTIVE } = await import("../../pipeline/roster.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  if (step === "sample") return sample({ ...o, db, ACTIVE });
  if (step === "usage") return console.log(`${o.MODEL}: ${(await dailyTotals(db)).used.get(o.MODEL)?.n ?? 0} requests this Pacific quota day`);
  if (step === "run") return run({ ...o, db });
  console.error(`unknown step ${step}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
