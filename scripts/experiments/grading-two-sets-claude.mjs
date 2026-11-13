#!/usr/bin/env node
// Amendments (owner-approved, 2026-11-13) to "Grading test (two sets)":
// Claude Sonnet 5.5 (claude-sonnet-5-5) through the Claude API, with
// exactly Gemini's prompts, inputs and answer shapes. Raw fetch, no SDK.
// Default effort and thinking (both omitted, so the model's defaults apply;
// recorded as such). No refusal fallback, so every answer is Sonnet's own.
//
// Steps, in this order (a finished request is never sent again):
//   solo A        Set A one at a time (the first run, $0.4980)
//   solo B        Set B one at a time
//   pass1 A, B    the locked pass-1 batches of 5 (prompts/batch.txt, the
//                 free-text batch schema of the 2026-11-13 amendment)
//   solo-repeat   the 10 solo-repeat sites, each an identical repeat of
//                 this model's own first solo request for that site
// The request content is Gemini's (buildRequest), converted part for part:
// text stays text, each screenshot becomes a base64 image block.
// Schemas go to output_config.format as JSON Schema (toJsonSchema).
//
// Safety:
// - the key comes from ANTHROPIC_API_KEY and is never printed or saved;
// - one request at a time;
// - a HARD STOP at a cumulative $2.00 across all runs (state.json keeps the
//   total): before each request the exact input is counted (count_tokens,
//   free) and the output estimated from the largest output so far of that
//   kind; the run stops when the total would pass the stop;
// - 429, 529 and 5xx are retried after 30 s, 60 s, 120 s and 300 s (5 tries);
//   a 4xx that mentions a spend or usage limit or credit stops the run as a
//   distinct "spend limit" outcome (status, error type, message and the
//   running total are printed and kept); any other 4xx stops the run;
// - every request (images referenced by bundle path) and response is saved
//   under raw/claude-sonnet-api/, answers under claude-sonnet-api/<step>/.
//
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- \
//     node scripts/experiments/grading-two-sets-claude.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EXP, RES, readJson, sha256, writeJson } from "./grading-two-sets-lib.mjs";
import { buildRequest, loadBundle, loadPrompts, parseResult } from "./grading-two-sets-run.mjs";

export const CLAUDE = {
  model: "claude-sonnet-5-5",
  folder: "claude-sonnet-api",
  api: "https://api.anthropic.com/v1",
  version: "2026-10-21",
  max_tokens: { solo: 16000, batch: 32000 },
  effort: "default (output_config.effort omitted)",
  thinking: "default (thinking omitted: adaptive)",
  price_per_mtok: { input: 2, output: 10 },
  hard_stop_usd: 2.0,
  first_output_estimate: { solo: 6000, batch: 30000 },
  retry_delays_ms: [30000, 60000, 120000, 300000],
  retry_statuses: [429, 529],
};

// Amendment (owner-approved, 2026-11-13): Claude Haiku 5.5 runs the same 58
// requests in the same order, with its own folders, state, prices and stop.
export const HAIKU = {
  ...CLAUDE,
  model: "claude-haiku-5-5",
  folder: "claude-haiku-api",
  price_per_mtok: { input: 0.1, output: 0.5 },
  hard_stop_usd: 0.5,
};

export const MODELS = { [CLAUDE.model]: CLAUDE, [HAIKU.model]: HAIKU };

const SPEND = /spend|usage limit|credit|billing|quota|limit.*(reached|exceeded)/i;

/** Gemini's OpenAPI-style schema as JSON Schema for structured outputs (no numeric or array-size constraints, closed objects). */
export function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["minimum", "maximum", "minItems", "maxItems", "propertyOrdering"].includes(k)) continue;
    if (k === "type") out.type = String(v).toLowerCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([p, x]) => [p, toJsonSchema(x)]));
    else out[k] = toJsonSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

const costWith = (settings) => (input, output) => (input * settings.price_per_mtok.input + output * settings.price_per_mtok.output) / 1e6;
const inputOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

/** The Claude request body for Gemini's request: the same system text, the same parts in order, the same schema. */
export function claudeBodyFor(kind, bundles, prompts, schemaKey = kind, settings = CLAUDE) {
  const built = buildRequest(kind, bundles, prompts, schemaKey);
  const content = built.parts.map((p) =>
    p.inline_data ? { type: "image", source: { type: "base64", media_type: p.inline_data.mime_type, data: p.inline_data.data } } : { type: "text", text: p.text }
  );
  return {
    body: {
      model: settings.model,
      max_tokens: settings.max_tokens[kind],
      system: built.options.systemInstruction,
      output_config: { format: { type: "json_schema", schema: toJsonSchema(built.schema) } },
      messages: [{ role: "user", content }],
    },
    refs: built.refs,
  };
}

/** One site alone, as in the first run (kept for the tests and the identical repeats). */
export const claudeBody = (bundle, prompts) => claudeBodyFor("solo", [bundle], prompts).body;

/** This model's request list, in order. Keys match the Gemini and expert files. */
export function claudeRequests(plan) {
  const out = [];
  const solo = (set, step, ids) => ids.forEach((id) => out.push({ key: `${step}/${id}`, step, set, kind: "solo", ids: [id], legacy: step === "solo" ? id : null }));
  solo("A", "solo", plan.sets.A.solo_order);
  solo("B", "solo", plan.sets.B.solo_order);
  for (const set of ["A", "B"]) plan.sets[set].passes.pass1.forEach((ids, b) => out.push({ key: `pass1/${set}-b${b + 1}`, step: "pass1", set, kind: "batch", ids }));
  for (const set of ["A", "B"]) solo(set, "solo-repeat", plan.sets[set].solo_repeat);
  return out;
}

class Stop extends Error {
  constructor(message, outcome = "stopped") {
    super(message);
    this.outcome = outcome;
  }
}

export async function runClaude({
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settings = CLAUDE,
  out = path.join(RES, settings.folder),
  rawDir = path.join(RES, "raw", settings.folder),
  bundleRoot = path.join(RES, "bundles"),
  plan = readJson(path.join(EXP, "groupings.json")),
  prompts = loadPrompts(),
  timelinePath = path.join(EXP, "timeline.json"),
  log = console.log,
} = {}) {
  if (!apiKey) throw new Error("Needs ANTHROPIC_API_KEY (run through pass-env).");
  const cost = costWith(settings);
  const statePath = path.join(out, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { model: settings.model, cost_usd: 0, http_requests: 0, attempts: [], items: {} };
  state.settings = settings;
  const save = () => writeJson(statePath, state);
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": settings.version };
  const requests = claudeRequests(plan);
  // Timeline: read fresh before each write, so another process's entries survive.
  const mark = (name, edge, extra = {}) => {
    if (!fs.existsSync(timelinePath)) return;
    const timeline = readJson(timelinePath);
    const p = timeline.phases.find((x) => x.phase === name) ?? (timeline.phases.push({ phase: name }), timeline.phases.at(-1));
    if (edge === "start" && !p.start) p.start = new Date().toISOString();
    if (edge === "end") p.end = new Date().toISOString();
    Object.assign(p, extra);
    writeJson(timelinePath, timeline);
  };
  const fileOf = (r) => path.join(out, r.step, `${r.key.split("/")[1]}.json`);
  const phaseOf = (r) => `${settings.folder}:${r.step} (Set ${r.set})`;
  let exit = "done";
  try {
    for (const req of requests) {
      if (fs.existsSync(fileOf(req))) continue;
      mark(phaseOf(req), "start");
      const bundles = req.ids.map((id) => loadBundle(id, bundleRoot));
      const { body, refs } = claudeBodyFor(req.kind, bundles, prompts, req.kind === "batch" ? "batch" : "solo", settings);
      const bodySha = sha256(JSON.stringify(body));
      const rawBody = JSON.parse(JSON.stringify(body));
      for (const c of rawBody.messages[0].content) if (c.type === "image") c.source = { type: "base64", media_type: c.source.media_type, ...refs.get(c.source.data) };
      // Budget check: the exact input (count_tokens is free) and the largest output so far of this kind.
      const ct = await fetchImpl(`${settings.api}/messages/count_tokens`, { method: "POST", headers, body: JSON.stringify({ model: body.model, system: body.system, messages: body.messages, output_config: body.output_config }) });
      if (!ct.ok) {
        const t = await ct.text();
        throw new Stop(`count_tokens HTTP ${ct.status}: ${t.slice(0, 300)}`, ct.status >= 400 && ct.status < 500 && SPEND.test(t) ? "spend_limit" : "stopped");
      }
      const inputEst = (await ct.json()).input_tokens;
      const outputs = Object.values(state.items).filter((i) => (i.kind ?? "solo") === req.kind).map((i) => i.usage?.output_tokens ?? 0);
      const outputEst = outputs.length ? Math.max(...outputs) : settings.first_output_estimate[req.kind];
      const est = cost(inputEst, outputEst);
      if (state.cost_usd + est > settings.hard_stop_usd) throw new Stop(`hard stop: $${state.cost_usd.toFixed(4)} spent, the next request (${req.key}) is estimated at $${est.toFixed(4)}, the stop is $${settings.hard_stop_usd.toFixed(2)}`);
      let res;
      let text;
      for (let t = 0; ; t++) {
        const n = ++state.http_requests;
        const at = new Date().toISOString();
        save();
        const base = path.join(rawDir, `${req.key.replace("/", "__")}__http${String(n).padStart(3, "0")}`);
        writeJson(`${base}.request.json`, { at, http_request: n, key: req.key, try: t + 1, body_sha256: bodySha, estimate: { input_tokens: inputEst, output_tokens: outputEst, usd: est }, body: rawBody });
        try {
          res = await fetchImpl(`${settings.api}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
          text = await res.text();
        } catch (e) {
          res = { status: 0 };
          text = String(e?.message ?? e);
        }
        writeJson(`${base}.response.json`, { at: new Date().toISOString(), http_request: n, status: res.status, text });
        state.attempts.push({ at, key: req.key, id: req.ids.join(","), status: res.status, retry: t > 0 });
        save();
        if (res.status === 200) break;
        const retryable = res.status === 0 || settings.retry_statuses.includes(res.status) || res.status >= 500;
        if (!retryable) {
          let type = "";
          let message = text.slice(0, 300);
          try {
            const e = JSON.parse(text).error ?? {};
            type = e.type ?? "";
            message = e.message ?? message;
          } catch {
            /* not JSON */
          }
          const spend = res.status >= 400 && res.status < 500 && SPEND.test(`${type} ${message}`);
          throw new Stop(`${req.key}: HTTP ${res.status} ${type}: ${message}`, spend ? "spend_limit" : "stopped");
        }
        log(`  ${req.key}: HTTP ${res.status}${t < settings.retry_delays_ms.length ? `, retrying in ${settings.retry_delays_ms[t] / 1000} s` : ""}`);
        if (t >= settings.retry_delays_ms.length) throw new Stop(`${req.key}: still HTTP ${res.status} after ${t + 1} tries; run again later to resume here`);
        await sleep(settings.retry_delays_ms[t]);
      }
      const msg = JSON.parse(text);
      const used = cost(inputOf(msg.usage), msg.usage?.output_tokens ?? 0);
      state.cost_usd += used;
      const item = (state.items[req.legacy ?? req.key] = { key: req.key, step: req.step, set: req.set, kind: req.kind, ids: req.ids, at: new Date().toISOString(), usage: msg.usage, stop_reason: msg.stop_reason, model: msg.model, cost_usd: used, body_sha256: bodySha });
      save();
      if (msg.stop_reason !== "end_turn") throw new Stop(`${req.key}: stop_reason ${msg.stop_reason}${msg.stop_details ? ` (${JSON.stringify(msg.stop_details)})` : ""}`);
      const answerText = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      let answers;
      try {
        answers = parseResult(req.kind, JSON.parse(answerText), req.ids, prompts.schema.levels);
      } catch (e) {
        item.broken = String(e?.message ?? e).slice(0, 300);
        save();
        throw new Stop(`${req.key}: the answer did not validate (${item.broken})`);
      }
      writeJson(fileOf(req), { step: req.step, set: req.set, kind: req.kind, ids: req.ids, model: settings.model, effort: settings.effort, thinking: settings.thinking, body_sha256: bodySha, answers });
      log(`${req.key} ok: HTTP 200, in ${inputOf(msg.usage)} out ${msg.usage?.output_tokens} tokens, $${used.toFixed(4)}; total $${state.cost_usd.toFixed(4)}`);
      if (!requests.some((r) => r.step === req.step && r.set === req.set && !fs.existsSync(fileOf(r)))) mark(phaseOf(req), "end");
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    exit = e.outcome;
    state.stopped = { at: new Date().toISOString(), outcome: e.outcome, why: e.message, total_usd: state.cost_usd };
    save();
    if (e.outcome === "spend_limit") {
      log(`SPEND LIMIT: ${e.message}`);
      log(`running total at that moment: $${state.cost_usd.toFixed(4)}`);
      mark(`event: ${settings.model} spend-limit stop (${e.message.slice(0, 200)}) at a running total of $${state.cost_usd.toFixed(4)}`, "start");
    } else log(`STOPPED: ${e.message}`);
  }
  const done = requests.filter((r) => fs.existsSync(fileOf(r))).length;
  log(`total: ${done} of ${requests.length} requests answered, ${state.http_requests} HTTP requests, $${state.cost_usd.toFixed(4)} of the $${settings.hard_stop_usd.toFixed(2)} stop`);
  return { exit, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--model");
  const model = i > 0 ? process.argv[i + 1] : CLAUDE.model;
  if (!MODELS[model]) {
    console.error(`--model must be one of ${Object.keys(MODELS).join(", ")}`);
    process.exit(1);
  }
  console.log(`${model}: answers in ${path.join(RES, MODELS[model].folder)}, hard stop $${MODELS[model].hard_stop_usd.toFixed(2)}`);
  const { exit } = await runClaude({ settings: MODELS[model] });
  process.exit(exit === "done" ? 0 : exit === "spend_limit" ? 4 : 3);
}
