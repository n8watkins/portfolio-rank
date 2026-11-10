#!/usr/bin/env node
// Offline eval of rubric v2 (pipeline/rubric.mjs) against the grades already
// stored. Read-only: it never writes a grade.
//
//   npm run eval:rubric -- --sample 30            estimate only, no Gemini
//   npm run eval:rubric -- --sample 30 --live     also grade the sample with v2
//
// Without --live it makes no Gemini call: it builds the v1 and v2 requests
// for a seeded random sample of graded sites and estimates tokens offline
// (text at ~4 characters per token, 1,120 tokens per image), and, when the
// request log has them, shows the measured v1 averages from gemini_requests.
// With --live it grades the same sample with v2 on 3.5 Flash-Lite only (no
// fallback), records every request in gemini_requests (job "eval-rubric", so
// the nightly budget sees them), refuses to start when today's quota left is
// smaller than the sample, and compares v2 with the stored grades (tier
// agreement, per-axis difference, is_portfolio) using real token usage.
//
// Sites come from the database (Turso with TURSO_*, else the local file); a
// database without grades falls back to data/feed.json entries that have a
// local capture (--captures DIR, default captures/). Page text and facts come
// from the row, else are measured over plain HTTP (free; --no-fetch skips it).
//
// Flags: --sample N (30) --seed S (1) --live --model M --rpm R --out FILE
//        --captures DIR --no-fetch --no-browser
//        --v1-before ISO (2026-11-11, the v2 cutover)
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createGemini, createLimiter, DEFAULT_RPM, PRIMARY_MODEL } from "../pipeline/gemini.mjs";
import { createRequestLog, dailyQuota, dailyTotals, ensureGeminiLog, prices } from "../pipeline/gemini-log.mjs";
import {
  AI_CRITERIA,
  IMAGE_TOKENS,
  RESPONSE_SCHEMA,
  RUBRIC_VERSION,
  buildRubricRequest,
  estimateInputTokens,
  estimateOutputTokens,
  normalizePageText,
  parseRubricResponse,
  versionOf,
} from "../pipeline/rubric.mjs";
import { measurePage } from "../pipeline/facts.mjs";
import { httpGate, UA, visibleText } from "../pipeline/gate.mjs";
import { ACTIVE, pipelineDb } from "../pipeline/roster.mjs";
import { createRenderer } from "../pipeline/render.mjs";
import { compareGrades } from "./grade-compare.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SAMPLE = Number(flag("sample", "30"));
const SEED = Number(flag("seed", "1"));
const LIVE = args.includes("--live");
const MODEL = flag("model", PRIMARY_MODEL);
const RPM = Number(flag("rpm", process.env.GEMINI_RPM || String(DEFAULT_RPM)));
const OUT = flag("out", "");
const CAPTURES = path.resolve(flag("captures", path.join(ROOT, "captures")));
const FETCH = !args.includes("--no-fetch");
// Like judge.mjs: client-rendered pages are loaded in a browser.
const renderer = FETCH && !args.includes("--no-browser") ? createRenderer() : null;
const V1_BEFORE = flag("v1-before", "2026-11-11T00:00:00Z");

// v1 as it ran until rubric v2 (frozen here only to estimate its size): the
// instruction text below, plus 3 images for a local capture (settled
// viewport, the same viewport 3 s later, the full page) or 2 from R2 (hero,
// full page), and six axes with a one-sentence note each.
const V1_AXES = [
  ["visual_design", "hierarchy, typography, color, use of space"],
  ["five_second_test", "is it clear who they are and what they do from the hero alone"],
  ["storytelling", "projects framed as problem/outcome vs bare tech lists"],
  ["writing", "typos, clarity, voice"],
  ["memorability", "would you remember this site tomorrow"],
  ["motion", "tasteful / gratuitous / absent — judge from the difference between the two viewport frames"],
];
function v1PromptText(name, url, images) {
  const desc =
    images === 3
      ? "Images, in order: (1) the settled desktop viewport, (2) the same viewport 3 seconds later (compare with 1 to judge motion), (3) the full page top to bottom."
      : "Images, in order: (1) the desktop hero, (2) the full page top to bottom.\nThis site appears STATIC (no motion detected).";
  return (
    `You are judging a developer's portfolio website: "${name}" at ${url}.\n${desc}` +
    `\nScore each axis 1 (poor) to 5 (excellent) with one short justification:\n` +
    V1_AXES.map(([k, d]) => `- ${k}: ${d}`).join("\n") +
    `\nAlso give an overall tier (S = exceptional, rare; A = strong; B = solid; C = weak; D = bad) ` +
    `and whether this is actually a personal portfolio site.`
  );
}
// The audit's measured v1 answer size when a row has no stored grade.
const V1_OUTPUT_FALLBACK = 400;
// A typical v2 answer for the offline output estimate: five scores with a
// ten-word clause each.
const V2_TYPICAL_ANSWER = {
  is_portfolio: true,
  tier: "B",
  ...Object.fromEntries(AI_CRITERIA.map((c) => [c.id, { score: 3, note: "Clean layout but generic hero copy and weak contrast overall" }])),
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

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(rows, n, seed) {
  const rnd = mulberry32(seed);
  const a = [...rows];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

const db = pipelineDb(ROOT);

async function gradedRows() {
  try {
    const res = await db.execute(
      `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
       WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
         AND json_valid(ai_rubric) AND json_extract(ai_rubric, '$.error') IS NULL
         AND json_extract(ai_rubric, '$.tier') IS NOT NULL
       ORDER BY url`
    );
    return res.rows.map((r) => ({ ...r }));
  } catch {
    return [];
  }
}

function captureRows() {
  const feed = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "feed.json"), "utf8"));
  const key = (url) => createHash("sha1").update(url).digest("hex").slice(0, 16);
  return feed
    .map((p) => ({ url: p.url, name: p.name, shot_key: key(p.url), meta: null, ai_rubric: null, page_text: null, facts: null }))
    .filter((r) => fs.existsSync(path.join(CAPTURES, r.shot_key, "hero.jpg")));
}

async function v1Averages() {
  try {
    const r = (
      await db.execute({
        sql: `SELECT COUNT(*) AS n, AVG(input_tokens) AS inp, AVG(output_tokens) AS outp, AVG(thoughts_tokens) AS th
              FROM gemini_requests WHERE job = 'rubric' AND status = 200 AND input_tokens IS NOT NULL AND at < ?`,
        args: [V1_BEFORE],
      })
    ).rows[0];
    return Number(r?.n) ? { n: Number(r.n), input: Number(r.inp), output: Number(r.outp), thoughts: r.th == null ? null : Number(r.th) } : null;
  } catch {
    return null;
  }
}

async function evidence(row) {
  const stored = parseJson(row.facts);
  const m = parseJson(row.meta)?.motion;
  const motion = typeof m === "boolean" ? m : null;
  if (row.page_text != null && stored) return { pageText: String(row.page_text), facts: stored, from: "stored" };
  if (!FETCH) return { pageText: "", facts: null, from: "none" };
  const gate = await httpGate(String(row.url)).catch(() => null);
  if (gate?.status !== "live") return { pageText: "", facts: null, from: "unreachable" };
  let page = { html: gate.html, text: visibleText(gate.html), finalUrl: gate.finalUrl, source: "http" };
  if (page.text.length < 200 && renderer) {
    const r = await renderer.render(String(row.url)).catch(() => null);
    if (r && r.status < 400 && String(r.text ?? "").trim().length > page.text.length) {
      page = { html: r.html, text: String(r.text), finalUrl: r.finalUrl, source: "rendered" };
    }
  }
  const facts = await measurePage(
    { html: page.html, text: page.text, url: String(row.url), finalUrl: page.finalUrl, name: String(row.name ?? ""), motion, source: page.source },
    { userAgent: UA }
  ).catch(() => null);
  return { pageText: normalizePageText(page.text), facts, from: page.source };
}

function localImage(key) {
  const f = path.join(CAPTURES, key, "hero.jpg");
  return fs.existsSync(f) ? { inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(f).toString("base64") } } : null;
}
async function r2Image(key) {
  const base = (process.env.SHOTS_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${key}/hero.jpg`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return { inline_data: { mime_type: "image/jpeg", data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
  } catch {
    return null;
  }
}

const usd = (n) => `$${n.toFixed(5)}`;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n) => Math.round(n);

async function main() {
  let rows = await gradedRows();
  let source = "database";
  if (!rows.length) {
    rows = captureRows();
    source = `data/feed.json with local captures in ${path.relative(ROOT, CAPTURES) || CAPTURES}`;
  }
  if (!rows.length) {
    console.error("No graded sites in the database and no local captures: nothing to evaluate.");
    process.exit(1);
  }
  const picked = sample(rows, SAMPLE, SEED);
  console.log(`eval: ${picked.length} site(s) from ${source} (seed ${SEED})${LIVE ? `, grading live with ${MODEL}` : ", offline estimate only"}`);

  let gemini = null;
  let requestLog = null;
  if (LIVE) {
    if (!process.env.GEMINI_API_KEY) {
      console.error("--live needs GEMINI_API_KEY (run through pass-env).");
      process.exit(1);
    }
    await ensureGeminiLog(db);
    const { used } = await dailyTotals(db);
    const left = (dailyQuota()[MODEL] ?? 0) - (used.get(MODEL)?.n ?? 0);
    if (left < picked.length * 2) {
      console.error(`Today's ${MODEL} quota has ${left} request(s) left; the eval needs up to ${picked.length * 2}. Try tomorrow or a smaller --sample.`);
      process.exit(1);
    }
    requestLog = createRequestLog({ db, job: "eval-rubric" });
    gemini = createGemini({
      apiKey: process.env.GEMINI_API_KEY,
      models: [MODEL],
      limiter: createLimiter({ rpm: RPM }),
      onRequest: (r) => requestLog.record(r),
      onDailyQuota: "stop",
    });
  }

  const results = [];
  for (const [i, row] of picked.entries()) {
    const url = String(row.url);
    const old = parseJson(row.ai_rubric);
    const ev = await evidence(row);
    const v1Images = old?.grading_source === "r2" ? 2 : 3;
    const v1In = estimateInputTokens({
      parts: [{ text: v1PromptText(String(row.name ?? ""), url, v1Images) }, ...Array.from({ length: v1Images }, () => ({ inline_data: {} }))],
    }).total;
    const v1Out = old
      ? estimateOutputTokens(Object.fromEntries(["is_portfolio", "tier", ...V1_AXES.map(([k]) => k)].map((k) => [k, old[k]])))
      : V1_OUTPUT_FALLBACK;
    const image = LIVE ? localImage(String(row.shot_key)) ?? (await r2Image(String(row.shot_key))) : { inline_data: {} };
    const req = buildRubricRequest({ name: String(row.name ?? ""), url, pageText: ev.pageText, facts: ev.facts, image });
    const v2In = estimateInputTokens({ parts: req.parts, systemInstruction: req.options.systemInstruction }).total;
    const r = { url, from: ev.from, textChars: ev.pageText.length, v1Images, v1In, v1Out, v2In, v2Out: estimateOutputTokens(V2_TYPICAL_ANSWER), old };
    if (LIVE) {
      if (!image) {
        r.error = "no screenshot";
      } else {
        try {
          const { result, usage } = await gemini.generate(req.parts, RESPONSE_SCHEMA, req.options);
          r.v2 = parseRubricResponse(result);
          r.usage = usage;
        } catch (e) {
          r.error = String(e?.message ?? e).slice(0, 120);
          if (e?.name === "GeminiQuotaError" || e?.name === "GeminiAuthError") {
            results.push(r);
            console.log(`[${i + 1}/${picked.length}] ${url} - ${r.error}; stopping`);
            break;
          }
        }
      }
    }
    results.push(r);
    console.log(
      `[${i + 1}/${picked.length}] ${url} - text ${r.textChars} chars (${r.from}), est. in v1 ${r.v1In} / v2 ${r.v2In}` +
        (r.v2 ? `, tier ${old?.tier ?? "-"} -> ${r.v2.tier}, used in ${r.usage?.inputTokens} out ${r.usage?.outputTokens} thinking ${r.usage?.thoughtsTokens ?? 0}` : "") +
        (r.error ? ` - ERROR ${r.error}` : "")
    );
  }

  const price = prices()[MODEL] ?? { in: 0, out: 0 };
  const cost = (inp, out) => (inp * price.in + out * price.out) / 1e6;
  const e = {
    v1In: avg(results.map((r) => r.v1In)),
    v1Out: avg(results.map((r) => r.v1Out)),
    v2In: avg(results.map((r) => r.v2In)),
    v2Out: avg(results.map((r) => r.v2Out)),
  };
  const measured = await v1Averages();
  const live = results.filter((r) => r.usage);
  const a = live.length
    ? {
        in: avg(live.map((r) => r.usage.inputTokens ?? 0)),
        out: avg(live.map((r) => r.usage.outputTokens ?? 0)),
        th: avg(live.map((r) => r.usage.thoughtsTokens ?? 0)),
      }
    : null;
  const pct = (before, after) => (before ? `${Math.round((100 * (before - after)) / before)}%` : "-");
  const md = [
    `## Rubric v${RUBRIC_VERSION} eval`,
    "",
    `${results.length} site(s) from ${source}, seed ${SEED}. ${LIVE ? `Graded live with ${MODEL}.` : "Offline: no Gemini calls."}`,
    `Requests per grade stay at 1 (the free quota counts requests); tokens matter at paid rates and for per-minute token limits.`,
    `Prices: ${MODEL} $${price.in} in / $${price.out} out per 1M tokens (thinking billed as output).`,
    "",
    "| Per grade (average) | Input tokens | Output tokens | Thinking tokens | Cost |",
    "| --- | ---: | ---: | ---: | ---: |",
    measured
      ? `| v1 measured (gemini_requests, ${measured.n} grade(s) before ${V1_BEFORE.slice(0, 10)}) | ${round(measured.input)} | ${round(measured.output)} | ${measured.thoughts == null ? "not logged" : round(measured.thoughts)} | ${usd(cost(measured.input, measured.output + (measured.thoughts ?? 0)))} |`
      : "| v1 measured | - | - | - | no rubric requests in gemini_requests |",
    `| v1 estimate (${IMAGE_TOKENS} per image, ~4 chars per token) | ${round(e.v1In)} | ${round(e.v1Out)} | - | ${usd(cost(e.v1In, e.v1Out))} |`,
    `| v2 estimate | ${round(e.v2In)} | ${round(e.v2Out)} | - | ${usd(cost(e.v2In, e.v2Out))} |`,
    a ? `| v2 measured (${live.length} live grade(s)) | ${round(a.in)} | ${round(a.out)} | ${round(a.th)} | ${usd(cost(a.in, a.out + a.th))} |` : null,
    "",
    `Estimated savings per grade: input ${pct(e.v1In, e.v2In)}, output ${pct(e.v1Out, e.v2Out)}, cost ${pct(cost(e.v1In, e.v1Out), cost(e.v2In, e.v2Out))}.`,
    `Average page text sent: ${round(avg(results.map((r) => r.textChars)))} characters; ${results.filter((r) => !r.textChars).length} site(s) without text.`,
    "",
  ].filter((l) => l !== null);

  if (live.length) {
    const pairs = live.filter((r) => r.old).map((r) => ({ url: r.url, a: r.old, b: { ...r.v2, model: MODEL } }));
    const c = compareGrades(pairs);
    const share = (n) => (c.pairs ? `${((100 * n) / c.pairs).toFixed(0)}%` : "-");
    md.push(
      "### v2 against the stored grades",
      "",
      `${c.pairs} pair(s): tier exact ${share(c.exact)}, within one tier ${share(c.withinOne)}, is_portfolio disagrees ${share(c.portfolioDisagree)}.`,
      "",
      "| Axis | Mean absolute difference |",
      "| --- | ---: |",
      ...AI_CRITERIA.map((k) => `| ${k.id} | ${c.mae[k.id] == null ? "-" : c.mae[k.id].toFixed(2)} |`),
      "",
      "| Site | Stored | v2 | Stored rubric |",
      "| --- | --- | --- | --- |",
      ...live.map((r) => `| ${r.url} | ${r.old?.tier ?? "-"} | ${r.v2.tier} | v${r.old ? versionOf(r.old) : "-"} ${r.old?.model ?? ""} |`),
      ""
    );
  }
  const errors = results.filter((r) => r.error);
  if (errors.length) md.push(`${errors.length} error(s): ${errors.map((r) => `${r.url} (${r.error})`).join("; ")}`, "");

  const out = md.join("\n");
  console.log(`\n${out}`);
  if (OUT) fs.writeFileSync(OUT, `${out}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
}

try {
  await main();
} finally {
  await renderer?.close();
}
