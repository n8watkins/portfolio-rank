#!/usr/bin/env node
// The Gemini side of "Grading test (two sets)": every request of
// experiments/grading-two-sets/groupings.json, in its fixed order, built only
// from the input bundles (~/research/.../grading-two-sets/bundles) and the
// locked prompts (experiments/grading-two-sets/prompts).
//
// Budget and safety:
// - a hard stop at 120 HTTP requests, retries included, across restarts;
// - at most 8 requests a minute (one shared limiter, kept across restarts);
// - a 503, timeout or other busy answer is retried after 30 s, 60 s, 120 s
//   and 300 s (5 tries); a site is never dropped: when a request still
//   fails, the run pauses and a later run resumes at that request;
// - every request goes out with temperature 0.2 and thinking "low"; a
//   request without that thinking level is a hard stop (the shared client
//   would otherwise retry without thinking);
// - every HTTP attempt is saved under raw/ (request minus image bytes, which
//   are referenced by bundle path and SHA-256, and the response) and logged
//   in gemini_requests as job "exp-grading-two-sets".
//
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY \
//     -e TURSO_DATABASE_URL=portfolio-rank/TURSO_DATABASE_URL \
//     -e TURSO_AUTH_TOKEN=portfolio-rank/TURSO_AUTH_TOKEN \
//     -- node scripts/experiments/grading-two-sets-run.mjs run
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { GEMINI_API_BASE, GeminiAuthError, GeminiIncompleteError, createGemini, createLimiter } from "../../pipeline/gemini.mjs";
import { createRequestLog, dailyTotals, ensureGeminiLog } from "../../pipeline/gemini-log.mjs";
import { EXP, JOB, RES, readJson, sha256, writeJson } from "./grading-two-sets-lib.mjs";

export const SETTINGS = {
  model: "gemini-3.5-flash-lite",
  temperature: 0.2,
  thinkingLevel: "low",
  maxOutputTokens: { solo: 8192, batch: 32768 },
  rpm: 8,
  hard_stop: 120,
  retry_delays_ms: [30000, 60000, 120000, 300000],
  max_tries: 5,
  broken_answer_retries: 1,
  // Raised from 430 to 485 on 2026-11-13 (amendment): production had sent no
  // Gemini request since 2026-11-12T23:18Z (the freeze), checked at query time,
  // so 485 still leaves 15 of the free 500 for this Pacific quota day.
  day_cap: 485,
  prompt_ids: { solo: "grade-two-sets-solo", solo_freetext: "grade-two-sets-solo-freetext", batch: "grade-two-sets-batch" },
  // Amendment 2026-11-13: the batch schema (and the solo_freetext control
  // step) take level_line as free text; the enum version was refused with
  // HTTP 400 INVALID_ARGUMENT on the first batch request.
  amendments: ["2026-11-13: batch schema level_line is free text; 10 solo-freetext control requests added"],
  job: JOB,
};

export const PARTS = ["visual_design", "project_presentation", "writing"];
export const CHECKS = ["name", "clear_role", "way_forward", "notable"];
export const batchLabels = (n) => Array.from({ length: n }, (_, i) => `site_${i + 1}`);

export function loadPrompts(dir = path.join(EXP, "prompts")) {
  const schema = readJson(path.join(dir, "schema.json"));
  return { solo: fs.readFileSync(path.join(dir, "solo.txt"), "utf8"), batch: fs.readFileSync(path.join(dir, "batch.txt"), "utf8"), schema };
}

export function loadBundle(id, root = path.join(RES, "bundles")) {
  const set = id[0];
  const dir = path.join(root, set, id);
  const img = (f) => {
    const buf = fs.readFileSync(path.join(dir, f));
    return { data: buf.toString("base64"), ref: { bundle_file: path.join("bundles", set, id, f), sha256: sha256(buf) } };
  };
  return {
    id,
    desktop: img("desktop.jpg"),
    phone: img("phone.jpg"),
    text: fs.readFileSync(path.join(dir, "text.txt"), "utf8").trim(),
    facts: readJson(path.join(dir, "facts.json")),
  };
}

/** The <site_data> block of one site: the facts, then the page text. Bundle files are already cleaned and redacted. */
export function siteBlock(b, label = null) {
  return [
    label ? `<site_data id="${label}">` : "<site_data>",
    "facts (measured by code, JSON):",
    JSON.stringify(b.facts, null, 1),
    "page_text:",
    b.text || "(none: the page shows no text, or draws it as images or on a canvas)",
    "</site_data>",
  ].join("\n");
}

const jpeg = (img) => ({ inline_data: { mime_type: "image/jpeg", data: img.data } });

/** Request parts, schema and options for one request, plus the image references for the raw log. */
export function buildRequest(kind, bundles, prompts = loadPrompts(), schemaKey = kind) {
  const parts = [];
  const refs = new Map();
  const labels = batchLabels(bundles.length);
  bundles.forEach((b, i) => {
    const pre = kind === "batch" ? `${labels[i]}: ` : "";
    parts.push({ text: `${pre}desktop screenshot (1440x900), top of the home page:` }, jpeg(b.desktop));
    parts.push({ text: `${pre}phone screenshot (390x844), top of the home page:` }, jpeg(b.phone));
    parts.push({ text: siteBlock(b, kind === "batch" ? labels[i] : null) });
    refs.set(b.desktop.data, b.desktop.ref);
    refs.set(b.phone.data, b.phone.ref);
  });
  return {
    parts,
    refs,
    schema: prompts.schema[schemaKey],
    options: {
      prompt: SETTINGS.prompt_ids[schemaKey],
      systemInstruction: prompts[kind],
      thinkingLevel: SETTINGS.thinkingLevel,
      temperature: SETTINGS.temperature,
      maxOutputTokens: SETTINGS.maxOutputTokens[kind],
    },
  };
}

// ---------------------------------------------------------------- parsing
/** Validate one answer. Throws on a missing or mistyped field; notes a level line that does not match the score. */
export function parseAnswer(a, levels) {
  if (!a || typeof a !== "object") throw new Error("answer is not an object");
  const out = { five_second: {}, notes: [] };
  for (const q of CHECKS) {
    const c = a.five_second?.[q];
    if (!c || typeof c.desktop !== "boolean" || typeof c.phone !== "boolean") throw new Error(`five_second.${q} missing`);
    out.five_second[q] = { seen: String(c.seen ?? ""), desktop: c.desktop, phone: c.phone };
  }
  for (const p of PARTS) {
    const s = Number(a[p]?.score);
    if (!Number.isInteger(s) || s < 1 || s > 5) throw new Error(`${p}.score missing or out of range`);
    const line = String(a[p].level_line ?? "");
    // Free-text level lines (batch schema) may add a "5:" prefix, quotes or spacing.
    const norm = (t) => t.toLowerCase().replace(/^\W*[1-5]\s*[:.)-]\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
    const lineLevel = 5 - levels[p].map(norm).indexOf(norm(line));
    if (lineLevel !== s) out.notes.push(`${p}: level line ${lineLevel === 6 ? "not in the rubric" : lineLevel} but score ${s}`);
    out[p] = { evidence: String(a[p].evidence ?? ""), level_line: line, score: s };
  }
  if (typeof a.is_portfolio?.answer !== "boolean") throw new Error("is_portfolio missing");
  out.is_portfolio = { reason: String(a.is_portfolio.reason ?? ""), answer: a.is_portfolio.answer };
  out.tips = Object.fromEntries(PARTS.map((p) => [p, String(a.tips?.[p] ?? "")]));
  return out;
}

/** Answers keyed by bundle id. */
export function parseResult(kind, result, ids, levels) {
  if (kind === "solo") return { [ids[0]]: parseAnswer(result, levels) };
  const list = result?.sites;
  const labels = batchLabels(ids.length);
  if (!Array.isArray(list) || list.length !== ids.length) throw new Error(`batch answer has ${Array.isArray(list) ? list.length : "no"} sites, expected ${ids.length}`);
  const got = list.map((s) => s?.id);
  if (new Set(got).size !== ids.length || !labels.every((l) => got.includes(l))) throw new Error(`batch answer ids ${JSON.stringify(got)}`);
  return Object.fromEntries(list.map((s) => [ids[labels.indexOf(s.id)], parseAnswer(s, levels)]));
}

// ---------------------------------------------------------------- run
class Pause extends Error {
  constructor(m) {
    super(m);
    this.name = "Pause";
  }
}

class BrokenAnswer extends Error {
  constructor(m) {
    super(m);
    this.name = "BrokenAnswer";
  }
}

const HARDSTOP = "HARDSTOP";

/**
 * Run every request not done yet. Options exist for the mocked test
 * (tests/grading-two-sets.test.mjs): apiBase, sleep, db, out, root, now.
 */
export async function run({
  apiKey = process.env.GEMINI_API_KEY,
  db = null,
  out = path.join(RES, "gemini"),
  rawDir = path.join(RES, "raw"),
  bundleRoot = path.join(RES, "bundles"),
  plan = readJson(path.join(EXP, "groupings.json")),
  prompts = loadPrompts(),
  apiBase = GEMINI_API_BASE,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settings = SETTINGS,
  timelinePath = path.join(EXP, "timeline.json"),
  only = null,
  log = console.log,
} = {}) {
  if (!apiKey) throw new Error("Needs GEMINI_API_KEY (run through pass-env).");
  const statePath = path.join(out, "state.json");
  const state = fs.existsSync(statePath)
    ? readJson(statePath)
    : { job: settings.job, model: settings.model, http_requests: 0, attempts: [], items: {}, pauses: [], last_request_at: null };
  const save = () => writeJson(statePath, state);
  const timeline = fs.existsSync(timelinePath) ? readJson(timelinePath) : null;
  const mark = (phase, edge) => {
    if (!timeline) return;
    const p = (timeline.phases ??= []).find((x) => x.phase === phase) ?? (timeline.phases.push({ phase }), timeline.phases.at(-1));
    if (edge === "start" && !p.start) p.start = new Date().toISOString();
    if (edge === "end") p.end = new Date().toISOString();
    writeJson(timelinePath, timeline);
  };
  if (db) await ensureGeminiLog(db);
  const requestLog = createRequestLog({ db, job: settings.job });
  let stop = null;
  let current = null;
  const fetchImpl = async (url, init) => {
    if (stop) throw new Error(`${HARDSTOP}: ${stop}`);
    const body = JSON.parse(init.body);
    // settings.thinkingLevel null means "the model's default": no thinkingConfig at all.
    const sentLevel = body.generationConfig?.thinkingConfig?.thinkingLevel ?? null;
    if (sentLevel !== (settings.thinkingLevel ?? null) || body.generationConfig?.temperature !== settings.temperature) {
      stop = `request without thinking "${settings.thinkingLevel}" and temperature ${settings.temperature}`;
      throw new Error(`${HARDSTOP}: ${stop}`);
    }
    if (state.http_requests >= settings.hard_stop) {
      stop = `hard stop: ${settings.hard_stop} requests used`;
      throw new Error(`${HARDSTOP}: ${stop}`);
    }
    if (db) {
      const used = (await dailyTotals(db)).used.get(settings.model)?.n ?? 0;
      if (used >= settings.day_cap) {
        stop = `${settings.model} has ${used} requests this quota day (cap ${settings.day_cap})`;
        throw new Error(`${HARDSTOP}: ${stop}`);
      }
    }
    state.http_requests++;
    current.tries++;
    const n = state.http_requests;
    const at = new Date().toISOString();
    state.last_request_at = Date.now();
    save();
    // The raw request, image bytes replaced by their bundle path and hash.
    for (const c of body.contents) for (const p of c.parts) if (p.inline_data) p.inline_data = { mime_type: p.inline_data.mime_type, ...current.refs.get(p.inline_data.data) };
    const base = path.join(rawDir, current.req.key.replace("/", "__"));
    writeJson(`${base}__http${String(n).padStart(3, "0")}.request.json`, { at, http_request: n, key: current.req.key, try: current.tries, url: url.replace(/key=[^&]+/, "key=REDACTED"), body_sha256: current.bodySha, body });
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      writeJson(`${base}__http${String(n).padStart(3, "0")}.response.json`, { at: new Date().toISOString(), http_request: n, error: String(e?.message ?? e) });
      throw e;
    }
    const text = await res.clone().text().catch(() => "");
    writeJson(`${base}__http${String(n).padStart(3, "0")}.response.json`, { at: new Date().toISOString(), http_request: n, status: res.status, text });
    return res;
  };
  const gemini = createGemini({
    apiKey,
    models: [settings.model],
    limiter: createLimiter({ rpm: settings.rpm, lastAt: state.last_request_at, sleep }),
    retryDelaysMs: settings.retry_delays_ms,
    jitter: () => 1,
    onDailyQuota: "stop",
    apiBase,
    fetchImpl,
    sleep: async (ms) => {
      if (stop) throw new Pause(stop);
      log(`  waiting ${Math.round(ms / 1000)} s before retrying`);
      await sleep(ms);
    },
    log,
    onRequest: (r) => {
      if (String(r.reason).includes(HARDSTOP)) return; // never sent
      const rec = { ...r, key: current?.req.key ?? null };
      state.attempts.push(rec);
      if (r.status !== 200) log(`  ${rec.key}: HTTP ${r.status} ${r.reason}${r.retry ? " (a retry)" : ""}`);
      save();
      return requestLog.record(r);
    },
  });
  const todo = plan.requests.filter((r) => !state.items[r.key]?.answers && (!only || only.includes(r.step)));
  log(`${todo.length} of ${plan.requests.length} requests to do; ${state.http_requests} HTTP requests used of ${settings.hard_stop}`);
  delete state.paused;
  let exit = "done";
  for (const req of todo) {
    const bundles = req.ids.map((id) => loadBundle(id, bundleRoot));
    const built = buildRequest(req.kind, bundles, prompts, req.schema ?? req.kind);
    // The request body without the API key, for "identical request" checks.
    const bodySha = sha256(JSON.stringify({ s: built.options.systemInstruction, p: built.parts, schema: built.schema, t: built.options.temperature, k: built.options.thinkingLevel, m: built.options.maxOutputTokens }));
    current = { req, refs: built.refs, tries: 0, bodySha };
    const item = (state.items[req.key] ??= { ...req, body_sha256: bodySha, broken: [] });
    item.started ??= new Date().toISOString();
    mark(`gemini:${req.step}`, "start");
    let answers = null;
    try {
      for (let b = 0; b <= settings.broken_answer_retries && !answers; b++) {
        try {
          let got;
          try {
            got = await gemini.generate(built.parts, built.schema, built.options);
          } catch (e) {
            if (e instanceof GeminiIncompleteError || e instanceof SyntaxError) throw new BrokenAnswer(e.message);
            throw e;
          }
          try {
            answers = parseResult(req.kind, got.result, req.ids, prompts.schema.levels);
          } catch (e) {
            throw new BrokenAnswer(e.message);
          }
          item.usage = got.usage;
          item.raw = got.result;
        } catch (e) {
          if (e instanceof BrokenAnswer) {
            item.broken.push({ at: new Date().toISOString(), why: String(e?.message ?? e).slice(0, 300) });
            log(`  ${req.key}: broken answer (${String(e?.message ?? e).slice(0, 120)})`);
            continue;
          }
          throw e;
        }
      }
      if (!answers) throw new Pause(`${req.key}: the answer was broken ${settings.broken_answer_retries + 1} times`);
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 300);
      state.paused = { at: new Date().toISOString(), key: req.key, why };
      state.pauses.push(state.paused);
      save();
      if (e instanceof GeminiAuthError) throw e;
      log(`PAUSED at ${req.key}: ${why}. Run again later to resume here.`);
      exit = "paused";
      break;
    }
    item.answers = answers;
    // The hash of the request as answered (a request re-sent after an amendment differs from its first try).
    if (item.body_sha256 !== bodySha) item.first_body_sha256 ??= item.body_sha256;
    item.body_sha256 = bodySha;
    item.finished = new Date().toISOString();
    item.http_tries = (item.http_tries ?? 0) + current.tries;
    writeJson(path.join(out, req.step, `${req.key.split("/")[1]}.json`), { step: req.step, set: req.set, kind: req.kind, ids: req.ids, answers, body_sha256: bodySha });
    save();
    log(`[${Object.values(state.items).filter((i) => i.answers).length}/${plan.requests.length}] ${req.key} ok (http ${state.http_requests}${item.answers && Object.values(answers).some((a) => a.notes.length) ? "; level/score mismatch noted" : ""})`);
    if (!plan.requests.some((r) => r.step === req.step && !state.items[r.key]?.answers)) mark(`gemini:${req.step}`, "end");
  }
  log(`HTTP requests used: ${state.http_requests}; ${gemini.summary()}; request log write errors ${requestLog.writeErrors}`);
  save();
  return { exit, state };
}

async function main() {
  const step = process.argv[2];
  if (step !== "run") {
    console.error("usage: grading-two-sets-run.mjs run [--only step,step]");
    process.exit(1);
  }
  const i = process.argv.indexOf("--only");
  const only = i > 0 ? process.argv[i + 1].split(",") : null;
  if (!process.env.TURSO_DATABASE_URL) throw new Error("run logs to gemini_requests: needs TURSO_DATABASE_URL through pass-env");
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const { exit } = await run({ db: pipelineDb(path.join(import.meta.dirname, "..", "..")), only });
  process.exit(exit === "done" ? 0 : 3);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
