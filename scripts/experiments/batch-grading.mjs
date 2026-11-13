#!/usr/bin/env node
// Experiment: does a site's grade vary more when several portfolios are
// graded in one Gemini request than when it is graded alone? Labelled
// experiment, owner-approved on 3.5 Flash-Lite (2026-11-12, round 1). It
// never writes a grade, rating or tier: results go to local files in --out.
// The only database write is the request log (gemini_requests, job
// "exp-batch-grading"), so the quota day counts the calls.
//
// Round 1 design (owner, 2026-11-12):
//   - 8 sites already graded with rubric v2 in production, spread across
//     stored score levels, with the stored top-of-page screenshot, page text
//     and facts: exactly rubric v2's evidence, through pipeline/rubric.mjs
//     buildRubricRequest. No re-capture.
//   - Solo: each site alone twice (16), plus 2 more repeats of the 2 sites
//     whose stored score sits closest to a tier-family boundary (4): 20.
//   - Batch of 4: the 8 sites as 2 batches of 4, 3 rounds with shuffled
//     order and neighbours: 6.
//   - Batch of 8: all 8 in one request, 3 rounds shuffled: 3.
// Ranking, the same 8 sites and the same evidence, with the ranking prompts
// (pipeline/compare-prompts.mjs):
//   - One on one: 10 pairs (a ring through the 8 sites plus 2 chords), each
//     asked in both orders (20), for position bias and stability.
//   - Batches of 4 ranked best to worst: 2 groups x 3 shuffles (6).
//   - All 8 ranked at once: 3 shuffles (3).
//   58 requests; a hard stop at --max-requests HTTP requests (70, retries
//   included, counted across restarts), and no request once the model's
//   count for the quota day reaches --day-cap (430). A finished request is
//   never repeated on a restart.
//
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY \
//     -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- npm run exp:batch-grading -- --out DIR [--plan-only] [--analyze-only]
//
// Flags: --out DIR (required) --model M (gemini-3.5-flash-lite) --seed S (1)
//        --rpm R (8) --max-requests N (35) --day-cap N (430) --shots URL
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { PRIMARY_MODEL, createGemini, createLimiter } from "../../pipeline/gemini.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { PAIR_SCHEMA, buildBatchRequest as buildRankRequest, buildPairRequest, parseBatchAnswer as parseRankAnswer, parsePairAnswer } from "../../pipeline/compare-prompts.mjs";
import {
  AI_CRITERIA,
  MAX_OUTPUT_TOKENS,
  RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION,
  buildRubricRequest,
  checksScore,
  codeChecks,
  parseRubricResponse,
  qualityScore,
  versionOf,
} from "../../pipeline/rubric.mjs";

const WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight" };
export const idsFor = (n) => Array.from({ length: n }, (_, i) => `site_${i + 1}`);

/** Today's system instruction word for word, plus the batch rules for `n` sites. */
export function batchSystemInstruction(n) {
  const w = WORDS[n] ?? String(n);
  return `${SYSTEM_INSTRUCTION}\nYou get ${n} portfolios at once, labelled site_1 to site_${n}. Grade each one on its own, exactly as if it were the only site you saw. Do not compare them, rank them or spread the scores out: ${w} excellent sites may all get 5s and ${w} weak ones may all get 1s. Each site has its own screenshot, given right before its <site_data> block with the same label. Never use one site's screenshot or text to judge another.`;
}

/** { sites: [n objects with id + the v2 fields] }. */
export function batchSchema(n) {
  return {
    type: "OBJECT",
    properties: {
      sites: {
        type: "ARRAY",
        minItems: n,
        maxItems: n,
        items: {
          type: "OBJECT",
          properties: { id: { type: "STRING", enum: idsFor(n) }, ...RESPONSE_SCHEMA.properties },
          required: ["id", ...RESPONSE_SCHEMA.required],
          propertyOrdering: ["id", ...RESPONSE_SCHEMA.propertyOrdering],
        },
      },
    },
    required: ["sites"],
  };
}

/** The batch request: per site a label, its screenshot, then its labelled <site_data> block (from buildRubricRequest). */
export function buildBatchRequest(sites) {
  const ids = idsFor(sites.length);
  const parts = [];
  sites.forEach((s, i) => {
    const [, ...rest] = buildRubricRequest(s).parts; // drop the solo caption, keep image and data
    parts.push({ text: `${ids[i]}: screenshot of the top of the home page:` });
    for (const p of rest) parts.push(p.text ? { text: `${ids[i]}:\n${p.text}` } : p);
  });
  const solo = buildRubricRequest(sites[0]).options;
  return {
    parts,
    schema: batchSchema(sites.length),
    options: { ...solo, systemInstruction: batchSystemInstruction(sites.length), maxOutputTokens: MAX_OUTPUT_TOKENS * sites.length },
  };
}

/** Validate a batch answer: exactly the n ids, each once, each a valid v2 answer. Throws otherwise. */
export function parseBatchResponse(raw, n) {
  const r = typeof raw === "string" ? JSON.parse(raw) : raw;
  const ids = idsFor(n);
  const list = r?.sites;
  if (!Array.isArray(list)) throw new Error("batch answer: sites missing");
  if (list.length !== n) throw new Error(`batch answer: ${list.length} sites, expected ${n}`);
  const seen = new Set(list.map((s) => s?.id));
  if (seen.size !== n || !ids.every((id) => seen.has(id))) {
    throw new Error(`batch answer: ids ${JSON.stringify(list.map((s) => s?.id))}, expected ${ids.join(", ")}`);
  }
  const out = {};
  for (const s of list) {
    const { id, ...rest } = s;
    out[id] = parseRubricResponse(rest);
  }
  return out;
}

// The 0-100 rank score and tier families of the tiers-by-rank work
// (lib/tiers.mjs on feat/rank-tiers, owner decisions 2026-11-12), copied so
// the experiment does not depend on an unmerged branch: quality (1-5 on
// 0-100) counts 80%, code checks 20%; families by place in the library.
const CHECKS_WHEN_UNKNOWN = 85;
const FAMILY_CUTS = [
  ["S", 1],
  ["A", 15],
  ["B", 70],
  ["C", 85],
  ["D", 100],
];
export function weightedScore(quality, checks) {
  if (typeof quality !== "number") return null;
  const q = Math.min(100, Math.max(0, (quality - 1) * 25));
  const c = typeof checks === "number" ? Math.min(100, Math.max(0, checks)) : CHECKS_WHEN_UNKNOWN;
  return Math.round((0.8 * q + 0.2 * c) * 100) / 100;
}
/** The tier family a score gets among `others` (sorted descending); "X" when not a portfolio. */
export function familyIn(score, others, isPortfolio = true) {
  if (!isPortfolio || typeof score !== "number") return "X";
  let above = 0;
  while (above < others.length && others[above] > score) above++;
  const share = (100 * (above + 0.5)) / (others.length + 1);
  return FAMILY_CUTS.find(([, top]) => share <= top)[0];
}
/** The score distance to the nearest family boundary in a library sorted descending. */
function boundaryDistance(score, sorted) {
  return Math.min(
    ...FAMILY_CUTS.slice(0, -1).map(([, top]) => {
      const at = Math.min(sorted.length - 1, Math.max(0, Math.round((top / 100) * sorted.length) - 1));
      return Math.abs(sorted[at] - score);
    })
  );
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
export function shuffled(xs, rnd) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * `rounds` orders of `urls` cut into batches of `size`, each round chosen
 * (best of 500 random shuffles) to repeat as few earlier positions and
 * batch-mates as possible. Returns [[[url x size] x batches] x rounds].
 */
export function layouts(urls, size, rounds, rnd) {
  const out = [];
  for (let r = 0; r < rounds; r++) {
    let best = null;
    let bestCost = Infinity;
    for (let t = 0; t < 500; t++) {
      const order = shuffled(urls, rnd);
      const batches = Array.from({ length: urls.length / size }, (_, b) => order.slice(b * size, (b + 1) * size));
      let cost = 0;
      for (const prev of out) {
        for (const [b, batch] of batches.entries()) {
          for (const [p, u] of batch.entries()) {
            if (prev[b]?.[p] === u || prev.some((pb) => pb.indexOf(u) === p)) cost += 10; // same position again
            const prevMates = prev.find((pb) => pb.includes(u));
            cost += batch.filter((m) => m !== u && prevMates.includes(m)).length; // same neighbour again
          }
        }
      }
      if (cost < bestCost) {
        best = batches;
        bestCost = cost;
      }
    }
    out.push(best);
  }
  return out;
}

/** 10 pairs over the sites: a ring through them in random order (every site in 2 pairs) plus 2 chords across it. */
export function pairPlan(urls, rnd) {
  const ring = shuffled(urls, rnd);
  const n = ring.length;
  const pairs = ring.map((u, i) => [u, ring[(i + 1) % n]]);
  pairs.push([ring[0], ring[n / 2]], [ring[n / 4], ring[(3 * n) / 4]]);
  return pairs.map((p) => (rnd() < 0.5 ? p : [p[1], p[0]]));
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
function ranks(xs) {
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
/** Spearman rank correlation (ties share the mean rank); null when either side is constant. */
export function spearman(a, b) {
  if (a.length < 2) return null;
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : null;
}
const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};
const storedScore = (g) => weightedScore(qualityScore(g), typeof g?.checks_score === "number" ? g.checks_score : null);

/** Where the 8 sites are picked: evenly across the eligible pool by stored score, best to worst. */
export const SPREAD = [0.02, 0.15, 0.3, 0.45, 0.6, 0.75, 0.88, 0.98];
export const SOLO_RUNS = 2;
export const SOLO_EXTRA_SITES = 2;
export const SOLO_EXTRA_RUNS = 2;
export const BATCH_ROUNDS = 3;

async function main() {
  const { pipelineDb, ACTIVE } = await import("../../pipeline/roster.mjs");
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const OUT = flag("out", "");
  if (!OUT) {
    console.error("--out DIR is required (results stay local).");
    process.exit(1);
  }
  const MODEL = flag("model", PRIMARY_MODEL);
  const SEED = Number(flag("seed", "1"));
  const RPM = Number(flag("rpm", "8"));
  const MAX_REQUESTS = Number(flag("max-requests", "70"));
  const DAY_CAP = Number(flag("day-cap", "430"));
  const SHOTS = flag("shots", "https://portfoliorank.n8builds.dev/shots").replace(/\/+$/, "");
  const PLAN_ONLY = args.includes("--plan-only");
  const ANALYZE_ONLY = args.includes("--analyze-only");
  fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
  const file = (n) => path.join(OUT, n);
  const writeJson = (n, v) => fs.writeFileSync(file(n), `${JSON.stringify(v, null, 2)}\n`);
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));

  // ---- 1. The sample (read-only) ----
  let plan = fs.existsSync(file("plan.json")) ? JSON.parse(fs.readFileSync(file("plan.json"), "utf8")) : null;
  if (!plan) {
    const res = await db.execute(
      `SELECT url, name, shot_key, ai_rubric, page_text, facts FROM portfolios
       WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
         AND json_valid(ai_rubric) AND json_extract(ai_rubric, '$.error') IS NULL
         AND json_extract(ai_rubric, '$.tier') IS NOT NULL
       ORDER BY url`
    );
    const rows = res.rows.map((r) => ({ ...r, grade: parseJson(r.ai_rubric) }));
    const library = rows
      .filter((r) => r.grade?.is_portfolio !== false)
      .map((r) => storedScore(r.grade))
      .filter((x) => typeof x === "number")
      .sort((a, b) => b - a);
    const eligible = rows
      .filter((r) => versionOf(r.grade) === 2 && r.grade?.is_portfolio !== false && r.page_text != null && parseJson(r.facts) && typeof storedScore(r.grade) === "number")
      .map((r) => ({ ...r, stored_score: storedScore(r.grade) }))
      .sort((a, b) => b.stored_score - a.stored_score || String(a.url).localeCompare(String(b.url)));
    console.log(`library: ${rows.length} graded, ${library.length} rankable; eligible (rubric v2 portfolio with page text, facts, screenshot): ${eligible.length}`);
    const rnd = mulberry32(SEED);
    const sites = [];
    for (const at of SPREAD) {
      const centre = Math.min(eligible.length - 1, Math.floor(at * eligible.length));
      const window = shuffled(eligible.slice(Math.max(0, centre - 5), centre + 6), rnd);
      let picked = null;
      for (const r of window) {
        if (sites.some((s) => s.url === String(r.url))) continue;
        const key = String(r.shot_key);
        const shot = path.join(OUT, "shots", `${key}.jpg`);
        if (!fs.existsSync(shot)) {
          const resp = await fetch(`${SHOTS}/${key}/hero.jpg`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
          if (!resp?.ok) {
            console.log(`  skip ${r.url}: no screenshot (${resp?.status ?? "unreachable"})`);
            continue;
          }
          fs.writeFileSync(shot, Buffer.from(await resp.arrayBuffer()));
        }
        picked = r;
        break;
      }
      if (!picked) throw new Error(`no site with a screenshot near ${at}`);
      sites.push({
        url: String(picked.url),
        name: String(picked.name ?? ""),
        shot_key: String(picked.shot_key),
        level: `top ${Math.round(at * 100)}%`,
        stored: picked.grade,
        stored_score: picked.stored_score,
        stored_family: familyIn(picked.stored_score, library),
        boundary_distance: boundaryDistance(picked.stored_score, library),
        checks_score: typeof picked.grade.checks_score === "number" ? picked.grade.checks_score : checksScore(codeChecks(parseJson(picked.facts))),
        page_text: String(picked.page_text),
        facts: parseJson(picked.facts),
      });
    }
    const urls = sites.map((s) => s.url);
    const borderline = [...sites].sort((a, b) => a.boundary_distance - b.boundary_distance).slice(0, SOLO_EXTRA_SITES).map((s) => s.url);
    plan = {
      created_at: new Date().toISOString(),
      seed: SEED,
      model: MODEL,
      library_scores: library,
      eligible: eligible.length,
      sites,
      borderline,
      batch4: layouts(urls, 4, BATCH_ROUNDS, rnd),
      batch8: layouts(urls, 8, BATCH_ROUNDS, rnd),
      pairs: pairPlan(urls, rnd),
      rank4: layouts(urls, 4, BATCH_ROUNDS, rnd),
      rank8: layouts(urls, 8, BATCH_ROUNDS, rnd),
    };
    writeJson("plan.json", plan);
    console.log(`plan: ${sites.length} sites; borderline ${borderline.join(", ")}`);
  }
  if (args.includes("--export-evidence")) {
    exportEvidence(plan, OUT);
    return;
  }
  if (PLAN_ONLY) return;

  const jobs = [
    ...Array.from({ length: SOLO_RUNS }, (_, r) => plan.sites.map((s) => ({ id: `solo${r + 1}:${s.url}`, kind: "solo", run: r + 1, urls: [s.url] }))).flat(),
    ...plan.batch4.flatMap((round, r) => round.map((urls, b) => ({ id: `b4r${r + 1}:${b}`, kind: "batch4", run: r + 1, batch: b, urls }))),
    ...plan.batch8.flatMap((round, r) => round.map((urls, b) => ({ id: `b8r${r + 1}:${b}`, kind: "batch8", run: r + 1, batch: b, urls }))),
    ...Array.from({ length: SOLO_EXTRA_RUNS }, (_, r) => plan.borderline.map((u) => ({ id: `solo${SOLO_RUNS + r + 1}:${u}`, kind: "solo", run: SOLO_RUNS + r + 1, urls: [u] }))).flat(),
    ...plan.pairs.flatMap(([a, b], k) => [
      { id: `pair${k}:ab`, kind: "pair", run: 1, pair: k, urls: [a, b] },
      { id: `pair${k}:ba`, kind: "pair", run: 2, pair: k, urls: [b, a] },
    ]),
    ...plan.rank4.flatMap((round, r) => round.map((urls, b) => ({ id: `r4r${r + 1}:${b}`, kind: "rank4", run: r + 1, batch: b, urls }))),
    ...plan.rank8.flatMap((round, r) => round.map((urls, b) => ({ id: `r8r${r + 1}:${b}`, kind: "rank8", run: r + 1, batch: b, urls }))),
  ];

  // ---- 2. The requests ----
  const statePath = file("results.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { model: MODEL, http_requests: 0, requests: [], items: {} };
  const save = () => fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const byUrl = new Map(plan.sites.map((s) => [s.url, s]));
  const evidenceOf = (s) => ({
    name: s.name,
    url: s.url,
    pageText: s.page_text,
    facts: s.facts,
    image: { inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(path.join(OUT, "shots", `${s.shot_key}.jpg`)).toString("base64") } },
  });

  if (!ANALYZE_ONLY && jobs.some((j) => !state.items[j.id])) {
    if (!process.env.GEMINI_API_KEY) {
      console.error("Needs GEMINI_API_KEY (run through pass-env).");
      process.exit(1);
    }
    await ensureGeminiLog(db);
    const usedToday = async () => (await dailyTotals(db)).used.get(MODEL)?.n ?? 0;
    console.log(`${MODEL}: ${await usedToday()} request(s) used today; day cap ${DAY_CAP}; this run may send up to ${MAX_REQUESTS - state.http_requests}`);
    const requestLog = createRequestLog({ db, job: "exp-batch-grading" });
    // The hard stops: every HTTP request (retries included) passes here.
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
      retryBudget: Math.max(0, MAX_REQUESTS - jobs.length),
      fetchImpl: counted,
    });
    for (const job of jobs) {
      if (state.items[job.id]) continue;
      const sites = job.urls.map((u) => evidenceOf(byUrl.get(u)));
      const req =
        job.kind === "solo"
          ? { ...buildRubricRequest(sites[0]), schema: RESPONSE_SCHEMA }
          : job.kind === "pair"
            ? { ...buildPairRequest(sites), schema: PAIR_SCHEMA }
            : job.kind.startsWith("rank")
              ? buildRankRequest(sites)
              : buildBatchRequest(sites);
      const item = { ...job, at: new Date().toISOString() };
      try {
        const { result, usage } = await gemini.generate(req.parts, req.schema, req.options);
        item.raw = result;
        item.usage = usage;
        try {
          if (job.kind === "solo") item.grades = { [job.urls[0]]: parseRubricResponse(result) };
          else if (job.kind === "pair") {
            const p = parsePairAnswer(result, job.urls);
            if (!p.ranking) throw new Error("skip: a screenshot was called unusable");
            item.order = p.ranking.map((g) => g[0]);
            item.reason = p.reason;
          } else if (job.kind.startsWith("rank")) {
            const p = parseRankAnswer(result, job.urls);
            item.order = p.ranking.map((g) => g[0]);
            item.reason = p.reason;
          } else {
            const ids = idsFor(job.urls.length);
            item.grades = Object.fromEntries(Object.entries(parseBatchResponse(result, job.urls.length)).map(([id, g]) => [job.urls[ids.indexOf(id)], g]));
          }
        } catch (e) {
          item.broken = String(e?.message ?? e).slice(0, 300);
        }
      } catch (e) {
        item.error = `${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}`;
        if (/hard stop|GeminiQuotaError|GeminiAuthError/.test(item.error)) {
          console.log(`${job.id}: ${item.error}; stopping`);
          break;
        }
      }
      state.items[job.id] = item;
      save();
      console.log(
        `[${Object.keys(state.items).length}/${jobs.length}] ${job.id} ${item.error ? `ERROR ${item.error}` : item.broken ? `BROKEN ${item.broken}` : `ok in ${item.usage?.inputTokens} out ${item.usage?.outputTokens} think ${item.usage?.thoughtsTokens ?? 0}`} (http ${state.http_requests}/${MAX_REQUESTS})`
      );
    }
    console.log(`requests this run: ${gemini.summary()}; request log write errors: ${requestLog.writeErrors}`);
  }

  // ---- 3. Analysis ----
  const analysis = analyze(plan, state, jobs);
  writeJson("analysis.json", analysis);
  console.log(`\n${analysis.markdown}\nanalysis written to ${file("analysis.json")}`);
}

/** Per site: every score by mode, the spread of each, position offsets, broken answers and tokens. */
export function analyze(plan, state, jobs) {
  const axes = AI_CRITERIA.map((c) => c.id);
  const lib = plan.library_scores;
  const items = jobs.map((j) => state.items[j.id]).filter(Boolean);
  const modes = ["solo", "batch4", "batch8"];
  const sites = plan.sites.map((s) => {
    const runs = Object.fromEntries(
      modes.map((m) => [
        m,
        items
          .filter((i) => i.kind === m && i.grades?.[s.url])
          .map((i) => {
            const g = i.grades[s.url];
            const q = qualityScore(g);
            const score = weightedScore(q, s.checks_score);
            return {
              run: i.run,
              position: i.urls.indexOf(s.url) + 1,
              quality: q,
              score,
              family: familyIn(score, lib, g.is_portfolio),
              tier: g.tier,
              is_portfolio: g.is_portfolio,
              axes: Object.fromEntries(axes.map((k) => [k, g[k].score])),
              notes: Object.fromEntries(axes.map((k) => [k, g[k].note])),
            };
          }),
      ])
    );
    const soloMean = mean(runs.solo.map((r) => r.quality));
    const spread = Object.fromEntries(
      modes.map((m) => {
        const qs = runs[m].map((r) => r.quality);
        // Mean absolute deviation of each axis from that mode's own mean for this site.
        const axisMad = mean(axes.map((k) => {
          const xs = runs[m].map((r) => r.axes[k]);
          const mk = mean(xs);
          return xs.length ? mean(xs.map((x) => Math.abs(x - mk))) : null;
        }).filter((x) => x != null));
        return [m, { n: qs.length, min: qs.length ? Math.min(...qs) : null, max: qs.length ? Math.max(...qs) : null, range: qs.length ? Math.max(...qs) - Math.min(...qs) : null, sd: sd(qs), mean: mean(qs), axis_mad: axisMad, families: [...new Set(runs[m].map((r) => r.family))] }];
      })
    );
    return { url: s.url, name: s.name, level: s.level, stored_quality: qualityScore(s.stored), stored_score: s.stored_score, stored_family: s.stored_family, stored_tier: s.stored.tier, checks_score: s.checks_score, borderline: plan.borderline.includes(s.url), solo_mean: soloMean, runs, spread };
  });

  // Pooled within-site spread per mode: the SD of a site's quality score around its own mean in that mode, pooled over sites.
  const pooled = (m) => {
    let ss = 0;
    let df = 0;
    for (const s of sites) {
      const qs = s.runs[m].map((r) => r.quality);
      if (qs.length < 2) continue;
      const mu = mean(qs);
      ss += qs.reduce((a, x) => a + (x - mu) ** 2, 0);
      df += qs.length - 1;
    }
    return df ? Math.sqrt(ss / df) : null;
  };
  const shift = (m) => mean(sites.flatMap((s) => s.runs[m].map((r) => r.quality - s.solo_mean)));
  const position = Object.fromEntries(
    ["batch4", "batch8"].map((m) => {
      const size = m === "batch4" ? 4 : 8;
      return [m, Array.from({ length: size }, (_, p) => {
        const xs = sites.flatMap((s) => s.runs[m].filter((r) => r.position === p + 1).map((r) => r.quality - s.solo_mean));
        return { position: p + 1, n: xs.length, mean_offset: mean(xs) };
      })];
    })
  );
  const kindStats = (kind) => {
    const xs = items.filter((i) => i.kind === kind);
    const ok = xs.filter((i) => i.grades);
    const sum = (f) => ok.reduce((t, i) => t + (i.usage?.[f] ?? 0), 0);
    const graded = ok.reduce((t, i) => t + Object.keys(i.grades).length, 0);
    return {
      planned: jobs.filter((j) => j.kind === kind).length,
      done: xs.length,
      ok: ok.length,
      broken: xs.filter((i) => i.broken).map((i) => ({ id: i.id, why: i.broken })),
      errors: xs.filter((i) => i.error).map((i) => ({ id: i.id, why: i.error })),
      grades: graded,
      tokens: { input: sum("inputTokens"), output: sum("outputTokens"), thoughts: sum("thoughtsTokens") },
      per_grade: graded ? { input: Math.round(sum("inputTokens") / graded), output: Math.round(sum("outputTokens") / graded), thoughts: Math.round(sum("thoughtsTokens") / graded) } : null,
    };
  };
  const summary = Object.fromEntries(modes.map((m) => [m, { pooled_sd_quality: pooled(m), mean_axis_mad: mean(sites.map((s) => s.spread[m].axis_mad).filter((x) => x != null)), mean_shift_vs_solo: m === "solo" ? 0 : shift(m), stats: kindStats(m) }]));

  const f2 = (x) => (x == null ? "-" : x.toFixed(2));
  const md = [
    `## Batch grading, round 1 (${state.model}, ${state.http_requests} HTTP requests)`,
    "",
    "| Site | Level | Stored q | Solo q (runs) | Batch-4 q (runs) | Batch-8 q (runs) |",
    "| --- | --- | ---: | --- | --- | --- |",
    ...sites.map((s) => `| ${s.url}${s.borderline ? " *" : ""} | ${s.level} | ${f2(s.stored_quality)} | ${s.runs.solo.map((r) => f2(r.quality)).join(", ")} | ${s.runs.batch4.map((r) => `${f2(r.quality)}@${r.position}`).join(", ")} | ${s.runs.batch8.map((r) => `${f2(r.quality)}@${r.position}`).join(", ")} |`),
    "",
    "| Mode | Pooled SD of quality within a site | Mean axis deviation | Mean shift vs solo | Broken | Tokens in/out/think per grade |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
    ...modes.map((m) => {
      const x = summary[m];
      const p = x.stats.per_grade;
      return `| ${m} | ${f2(x.pooled_sd_quality)} | ${f2(x.mean_axis_mad)} | ${f2(x.mean_shift_vs_solo)} | ${x.stats.broken.length + x.stats.errors.length} | ${p ? `${p.input}/${p.output}/${p.thoughts}` : "-"} |`;
    }),
    "",
    ...["batch4", "batch8"].map((m) => `Position offset ${m} (quality vs solo mean): ${position[m].map((p) => `${p.position}: ${f2(p.mean_offset)} (n${p.n})`).join(", ")}`),
  ].join("\n");

  const ranking = analyzeRanking(plan, items, sites);
  return { model: state.model, http_requests: state.http_requests, summary, position, sites, ranking, markdown: `${md}\n\n${ranking.markdown}` };
}

/**
 * Writes the exact evidence of the plan's sites to OUT/evidence, so another
 * model can be run on the same inputs: per site n (1-based, plan order)
 * n.jpg (the bytes sent to Gemini), n.png (the same image, losslessly
 * re-encoded, same size), n.txt (the grading <site_data> block),
 * n-rank-1v1.txt and n-rank-batch.txt (the ranking prompts' blocks); the
 * four prompt files (system instruction, user parts in order with images as
 * [IMAGE n.png], response schema, generation settings); and sites.json.
 */
export function exportEvidence(plan, out) {
  const dir = path.join(out, "evidence");
  fs.mkdirSync(dir, { recursive: true });
  const require = createRequire(import.meta.url);
  const jpeg = require("jpeg-js");
  const { PNG } = require("pngjs");
  const sites = plan.sites.map((s, i) => {
    const n = i + 1;
    const bytes = fs.readFileSync(path.join(out, "shots", `${s.shot_key}.jpg`));
    fs.writeFileSync(path.join(dir, `${n}.jpg`), bytes);
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data);
    fs.writeFileSync(path.join(dir, `${n}.png`), PNG.sync.write(png));
    return { n, image: { marker: `[IMAGE ${n}.png]` }, name: s.name, url: s.url, pageText: s.page_text, facts: s.facts, plan: s };
  });
  const textOf = (parts) => parts.map((p) => (p.marker ? p.marker : p.text)).join("\n\n");
  const withMarker = (s) => ({ ...s, image: { marker: s.image.marker } });
  for (const s of sites) {
    const solo = buildRubricRequest(withMarker(s));
    fs.writeFileSync(path.join(dir, `${s.n}.txt`), `${solo.parts.at(-1).text}\n`);
    const pair = buildPairRequest([withMarker(s), withMarker(s)]);
    fs.writeFileSync(path.join(dir, `${s.n}-rank-1v1.txt`), `${pair.parts[3].text.replace('label="A"', 'label="<A or B>"')}\n`);
    const rank = buildRankRequest([withMarker(s)]);
    fs.writeFileSync(path.join(dir, `${s.n}-rank-batch.txt`), `${rank.parts[3].text.replace('label="A"', 'label="<letter>"')}\n`);
  }
  const settings = (o) => `Generation settings: temperature ${o.temperature}, thinking level ${o.thinkingLevel}, max output tokens ${o.maxOutputTokens} (thinking included), JSON output (responseMimeType application/json) with the response schema below.`;
  const section = (title, req, schema) =>
    [
      `=== ${title} ===`,
      "",
      "--- System instruction ---",
      req.options.systemInstruction,
      "",
      "--- User message parts, in order ---",
      textOf(req.parts),
      "",
      "--- Response schema (Gemini OpenAPI subset) ---",
      JSON.stringify(schema, null, 2),
      "",
      settings(req.options),
      "",
    ].join("\n");
  const head = (what) =>
    `${what}\nModel: ${plan.model}. Images are the n.png files (1440x900, the top of the home page); Gemini got the n.jpg bytes. Each site's block is n.txt (grading) or n-rank-*.txt (ranking); the examples below use sites in plan order.\n\n`;
  const solo = buildRubricRequest(sites[0]);
  fs.writeFileSync(path.join(dir, "prompt-solo.txt"), head("Grading, one site alone (rubric v2, unchanged).") + section("Solo grade, example with site 1", solo, RESPONSE_SCHEMA));
  const b4 = buildBatchRequest(sites.slice(0, 4));
  const b8 = buildBatchRequest(sites);
  fs.writeFileSync(
    path.join(dir, "prompt-batch.txt"),
    head("Grading, several sites in one request: rubric v2's system instruction word for word plus the batch rules. Answer maps site_k back to the k-th site shown.") +
      section("Batch of 4, example with sites 1-4", b4, b4.schema) +
      "\n" +
      section("Batch of 8, example with sites 1-8", b8, b8.schema)
  );
  const p = buildPairRequest([sites[0], sites[1]]);
  fs.writeFileSync(path.join(dir, "prompt-rank-1v1.txt"), head("Ranking, one on one (pipeline/compare-prompts.mjs buildPairRequest). Each pair is asked in both orders.") + section("One on one, example with site 1 as A and site 2 as B", p, PAIR_SCHEMA));
  const r4 = buildRankRequest(sites.slice(0, 4));
  const r8 = buildRankRequest(sites);
  fs.writeFileSync(
    path.join(dir, "prompt-rank-batch.txt"),
    head("Ranking, several sites ranked best to worst in one request (pipeline/compare-prompts.mjs buildBatchRequest).") +
      section("Batch of 4, example with sites 1-4 as A-D", r4, r4.schema) +
      "\n" +
      section("All 8, example with sites 1-8 as A-H", r8, r8.schema)
  );
  const jobsOf = {
    batch4: plan.batch4,
    batch8: plan.batch8,
    pairs: plan.pairs,
    rank4: plan.rank4,
    rank8: plan.rank8,
  };
  const nOf = new Map(plan.sites.map((s, i) => [s.url, i + 1]));
  const asN = (x) => (Array.isArray(x) ? x.map(asN) : nOf.get(x));
  fs.writeFileSync(
    path.join(dir, "sites.json"),
    `${JSON.stringify(
      {
        model: plan.model,
        sites: Object.fromEntries(
          plan.sites.map((s, i) => [
            i + 1,
            { url: s.url, name: s.name, level: s.level, stored_score_0_100: s.stored_score, stored_family: s.stored_family, checks_score: s.checks_score, borderline: plan.borderline.includes(s.url), stored_grade: s.stored },
          ])
        ),
        layouts_by_site_number: { ...Object.fromEntries(Object.entries(jobsOf).map(([k, v]) => [k, asN(v)])), solo_extra_repeats: asN(plan.borderline) },
      },
      null,
      2
    )}\n`
  );
  console.log(`evidence written to ${dir}`);
}

const pairId = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The ranking task: each mode's pairwise preferences (one on one, batches of
 * 4, all 8, and the grading order from solo grades), how often two modes
 * agree on a pair, how stable each mode is across its repeats, position
 * bias, and one overall order per mode.
 */
function analyzeRanking(plan, items, sites) {
  const urls = plan.sites.map((s) => s.url);
  const short = (u) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  // votes[mode][pair] = list of winners (one per answer that saw both).
  const votes = { pair: {}, rank4: {}, rank8: {} };
  const answers = { pair: [], rank4: [], rank8: [] };
  for (const i of items) {
    if (!(i.kind in votes) || !i.order) continue;
    answers[i.kind].push(i);
    for (let x = 0; x < i.order.length; x++) {
      for (let y = x + 1; y < i.order.length; y++) {
        const k = pairId(i.order[x], i.order[y]);
        (votes[i.kind][k] ??= []).push(i.order[x]);
      }
    }
  }
  // The grading order: solo mean quality (ties give no preference).
  const solo = new Map(sites.map((s) => [s.url, s.solo_mean]));
  const prefer = {};
  for (const m of Object.keys(votes)) {
    prefer[m] = {};
    for (const [k, ws] of Object.entries(votes[m])) {
      const [a, b] = k.split("|");
      const na = ws.filter((w) => w === a).length;
      const nb = ws.length - na;
      prefer[m][k] = na > nb ? a : nb > na ? b : null;
    }
  }
  prefer.grading = {};
  for (let x = 0; x < urls.length; x++) {
    for (let y = x + 1; y < urls.length; y++) {
      const [a, b] = [urls[x], urls[y]];
      const qa = solo.get(a);
      const qb = solo.get(b);
      if (qa == null || qb == null) continue;
      prefer.grading[pairId(a, b)] = qa > qb ? a : qb > qa ? b : null;
    }
  }
  const modes = ["pair", "rank4", "rank8", "grading"];
  const agreement = {};
  for (const m of modes) {
    for (const n of modes) {
      if (m >= n) continue;
      const shared = Object.keys(prefer[m]).filter((k) => prefer[m][k] && prefer[n][k]);
      const same = shared.filter((k) => prefer[m][k] === prefer[n][k]).length;
      agreement[`${m}~${n}`] = { pairs: shared.length, agree: same, share: shared.length ? same / shared.length : null };
    }
  }
  // Stability: for every pair seen more than once in a mode, how often two answers agree (over all answer pairs).
  const stability = Object.fromEntries(
    Object.keys(votes).map((m) => {
      let agree = 0;
      let total = 0;
      for (const ws of Object.values(votes[m])) {
        for (let x = 0; x < ws.length; x++) for (let y = x + 1; y < ws.length; y++) {
          total++;
          if (ws[x] === ws[y]) agree++;
        }
      }
      return [m, { comparisons: total, agree, share: total ? agree / total : null }];
    })
  );
  // Position bias: the mean place given (1 = best) by the position shown.
  const posBias = Object.fromEntries(
    Object.keys(answers).map((m) => {
      const size = m === "pair" ? 2 : m === "rank4" ? 4 : 8;
      return [m, Array.from({ length: size }, (_, p) => {
        const places = answers[m].map((i) => i.order.indexOf(i.urls[p]) + 1);
        return { shown: p + 1, n: places.length, mean_place: mean(places), first: places.filter((x) => x === 1).length };
      })];
    })
  );
  // One overall order per mode: share of its pairwise votes each site won (grading: solo mean).
  const winShare = (m) =>
    Object.fromEntries(urls.map((u) => {
      let won = 0;
      let seen = 0;
      for (const [k, ws] of Object.entries(votes[m])) {
        if (!k.split("|").includes(u)) continue;
        seen += ws.length;
        won += ws.filter((w) => w === u).length;
      }
      return [u, seen ? won / seen : null];
    }));
  const value = { pair: winShare("pair"), rank4: winShare("rank4"), rank8: winShare("rank8"), grading: Object.fromEntries(urls.map((u) => [u, solo.get(u)])) };
  const orders = Object.fromEntries(modes.map((m) => [m, [...urls].filter((u) => value[m][u] != null).sort((a, b) => value[m][b] - value[m][a])]));
  const rho = {};
  for (const m of modes) for (const n of modes) {
    if (m >= n) continue;
    const both = urls.filter((u) => value[m][u] != null && value[n][u] != null);
    rho[`${m}~${n}`] = spearman(both.map((u) => value[m][u]), both.map((u) => value[n][u]));
  }
  const pct = (x) => (x == null ? "-" : `${Math.round(100 * x)}%`);
  const f2 = (x) => (x == null ? "-" : x.toFixed(2));
  const label = { pair: "1 on 1", rank4: "Batch of 4", rank8: "All 8", grading: "Grading (solo mean)" };
  const md = [
    "## Ranking",
    "",
    `| Place | ${modes.map((m) => label[m]).join(" | ")} |`,
    `| ---: | ${modes.map(() => "---").join(" | ")} |`,
    ...urls.map((_, p) => `| ${p + 1} | ${modes.map((m) => (orders[m][p] ? `${short(orders[m][p])} (${m === "grading" ? f2(value[m][orders[m][p]]) : pct(value[m][orders[m][p]])})` : "-")).join(" | ")} |`),
    "",
    "| Modes | Pairs both decide | Same winner | Spearman of the orders |",
    "| --- | ---: | ---: | ---: |",
    ...Object.entries(agreement).map(([k, a]) => `| ${k.split("~").map((m) => label[m]).join(" vs ")} | ${a.pairs} | ${a.agree} (${pct(a.share)}) | ${f2(rho[k])} |`),
    "",
    "| Mode | Repeat comparisons of the same pair | Same winner |",
    "| --- | ---: | ---: |",
    ...Object.entries(stability).map(([m, s]) => `| ${label[m]} | ${s.comparisons} | ${s.agree} (${pct(s.share)}) |`),
    "",
    ...Object.entries(posBias).map(([m, ps]) => `Position bias ${label[m]} (mean place by position shown, 1 = best): ${ps.map((p) => `${p.shown}: ${f2(p.mean_place)}`).join(", ")}`),
  ].join("\n");
  const broken = items.filter((i) => i.kind in votes && (i.broken || i.error)).map((i) => ({ id: i.id, why: i.broken ?? i.error }));
  const tokens = Object.fromEntries(Object.keys(answers).map((m) => {
    const xs = items.filter((i) => i.kind === m && i.usage);
    const s = (f) => xs.reduce((t, i) => t + (i.usage?.[f] ?? 0), 0);
    return [m, { requests: xs.length, input: s("inputTokens"), output: s("outputTokens"), thoughts: s("thoughtsTokens") }];
  }));
  return { orders, value, agreement, spearman: rho, stability, position: posBias, broken, tokens, markdown: md };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
