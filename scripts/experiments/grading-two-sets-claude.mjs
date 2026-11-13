#!/usr/bin/env node
// Amendment (owner-approved, 2026-11-13) to "Grading test (two sets)": Set
// A's 20 one-at-a-time requests sent to the Claude API (claude-sonnet-5-5),
// with exactly the Gemini solo prompt (prompts/solo.txt), the same bundle
// inputs (desktop and phone screenshots, then the <site_data> block) and the
// same answer shape (prompts/schema.json "solo", converted to JSON Schema
// for output_config.format). Raw fetch, no SDK. Default effort and thinking
// (both omitted, so the model's defaults apply; recorded as such).
//
// Safety:
// - the key comes from ANTHROPIC_API_KEY and is never printed or saved;
// - one request at a time, in the Set A solo order of groupings.json;
// - a hard stop at $0.75: before each request, the exact input is counted
//   (count_tokens, free) and the output estimated from the largest output so
//   far; the run stops when the running total would pass the stop;
// - 429, 529 and 5xx are retried after 30 s, 60 s, 120 s and 300 s (5 tries);
//   any other 4xx stops the run;
// - every request (images referenced by bundle path) and response is saved
//   under raw/claude-sonnet-api/, answers under claude-sonnet-api/solo/;
// - resumable: a site with an answer file is never sent again, and the
//   running total is kept in claude-sonnet-api/state.json.
//
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- \
//     node scripts/experiments/grading-two-sets-claude.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EXP, RES, readJson, writeJson } from "./grading-two-sets-lib.mjs";
import { loadBundle, loadPrompts, parseAnswer, siteBlock } from "./grading-two-sets-run.mjs";

export const CLAUDE = {
  model: "claude-sonnet-5-5",
  api: "https://api.anthropic.com/v1",
  version: "2026-10-21",
  max_tokens: 16000,
  effort: "default (output_config.effort omitted)",
  thinking: "default (thinking omitted: adaptive)",
  price_per_mtok: { input: 2, output: 10 },
  hard_stop_usd: 0.75,
  first_output_estimate: 6000,
  retry_delays_ms: [30000, 60000, 120000, 300000],
  retry_statuses: [429, 529],
};

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

const cost = (input, output) => (input * CLAUDE.price_per_mtok.input + output * CLAUDE.price_per_mtok.output) / 1e6;
const inputOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);

/** The request body for one site: the same parts as the Gemini solo request, in the same order. */
export function claudeBody(bundle, prompts) {
  const img = (x) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: x.data } });
  return {
    model: CLAUDE.model,
    max_tokens: CLAUDE.max_tokens,
    system: prompts.solo,
    output_config: { format: { type: "json_schema", schema: toJsonSchema(prompts.schema.solo) } },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "desktop screenshot (1440x900), top of the home page:" },
          img(bundle.desktop),
          { type: "text", text: "phone screenshot (390x844), top of the home page:" },
          img(bundle.phone),
          { type: "text", text: siteBlock(bundle) },
        ],
      },
    ],
  };
}

class Stop extends Error {}

export async function runClaude({
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  out = path.join(RES, "claude-sonnet-api"),
  rawDir = path.join(RES, "raw", "claude-sonnet-api"),
  bundleRoot = path.join(RES, "bundles"),
  plan = readJson(path.join(EXP, "groupings.json")),
  prompts = loadPrompts(),
  settings = CLAUDE,
  timelinePath = path.join(EXP, "timeline.json"),
  log = console.log,
} = {}) {
  if (!apiKey) throw new Error("Needs ANTHROPIC_API_KEY (run through pass-env).");
  const statePath = path.join(out, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { model: settings.model, settings, cost_usd: 0, http_requests: 0, attempts: [], items: {} };
  const save = () => writeJson(statePath, state);
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": settings.version };
  const ids = plan.sets.A.solo_order;
  const timeline = fs.existsSync(timelinePath) ? readJson(timelinePath) : null;
  const mark = (edge) => {
    if (!timeline) return;
    const name = "claude-sonnet-api:solo (Set A)";
    const p = timeline.phases.find((x) => x.phase === name) ?? (timeline.phases.push({ phase: name }), timeline.phases.at(-1));
    if (edge === "start" && !p.start) p.start = new Date().toISOString();
    if (edge === "end") p.end = new Date().toISOString();
    writeJson(timelinePath, timeline);
  };
  let exit = "done";
  try {
    for (const id of ids) {
      const answerPath = path.join(out, "solo", `${id}.json`);
      if (fs.existsSync(answerPath)) continue;
      mark("start");
      const bundle = loadBundle(id, bundleRoot);
      const body = claudeBody(bundle, prompts);
      const refs = new Map([[bundle.desktop.data, bundle.desktop.ref], [bundle.phone.data, bundle.phone.ref]]);
      const rawBody = JSON.parse(JSON.stringify(body));
      for (const c of rawBody.messages[0].content) if (c.type === "image") c.source = { type: "base64", media_type: c.source.media_type, ...refs.get(c.source.data) };
      // Budget check: the exact input (count_tokens is free) and the largest output so far.
      const ct = await fetchImpl(`${settings.api}/messages/count_tokens`, { method: "POST", headers, body: JSON.stringify({ model: body.model, system: body.system, messages: body.messages, output_config: body.output_config }) });
      if (!ct.ok) throw new Stop(`count_tokens HTTP ${ct.status}: ${(await ct.text()).slice(0, 300)}`);
      const inputEst = (await ct.json()).input_tokens;
      const outputs = Object.values(state.items).map((i) => i.usage?.output_tokens ?? 0);
      const outputEst = outputs.length ? Math.max(...outputs) : settings.first_output_estimate;
      const est = cost(inputEst, outputEst);
      if (state.cost_usd + est > settings.hard_stop_usd) throw new Stop(`hard stop: $${state.cost_usd.toFixed(4)} spent, the next request is estimated at $${est.toFixed(4)}, the stop is $${settings.hard_stop_usd}`);
      let res;
      let text;
      for (let t = 0; ; t++) {
        const n = ++state.http_requests;
        const at = new Date().toISOString();
        save();
        const base = path.join(rawDir, `solo__${id}__http${String(n).padStart(3, "0")}`);
        writeJson(`${base}.request.json`, { at, http_request: n, id, try: t + 1, estimate: { input_tokens: inputEst, output_tokens: outputEst, usd: est }, body: rawBody });
        try {
          res = await fetchImpl(`${settings.api}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
          text = await res.text();
        } catch (e) {
          res = { status: 0 };
          text = String(e?.message ?? e);
        }
        writeJson(`${base}.response.json`, { at: new Date().toISOString(), http_request: n, status: res.status, text });
        state.attempts.push({ at, id, status: res.status, retry: t > 0 });
        save();
        if (res.status === 200) break;
        const retryable = res.status === 0 || settings.retry_statuses.includes(res.status) || res.status >= 500;
        log(`  ${id}: HTTP ${res.status}${retryable && t < settings.retry_delays_ms.length ? `, retrying in ${settings.retry_delays_ms[t] / 1000} s` : ""}`);
        if (!retryable) throw new Stop(`${id}: HTTP ${res.status}: ${text.slice(0, 300)}`);
        if (t >= settings.retry_delays_ms.length) throw new Stop(`${id}: still HTTP ${res.status} after ${t + 1} tries; run again later to resume here`);
        await sleep(settings.retry_delays_ms[t]);
      }
      const msg = JSON.parse(text);
      const used = cost(inputOf(msg.usage), msg.usage?.output_tokens ?? 0);
      state.cost_usd += used;
      const item = (state.items[id] = { id, at: new Date().toISOString(), usage: msg.usage, stop_reason: msg.stop_reason, model: msg.model, cost_usd: used });
      save();
      if (msg.stop_reason !== "end_turn") throw new Stop(`${id}: stop_reason ${msg.stop_reason}${msg.stop_details ? ` (${JSON.stringify(msg.stop_details)})` : ""}`);
      const answerText = (msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
      let answer;
      try {
        answer = parseAnswer(JSON.parse(answerText), prompts.schema.levels);
      } catch (e) {
        item.broken = String(e?.message ?? e).slice(0, 300);
        save();
        throw new Stop(`${id}: the answer did not validate (${item.broken})`);
      }
      writeJson(answerPath, { step: "solo", set: "A", kind: "solo", ids: [id], model: settings.model, effort: settings.effort, thinking: settings.thinking, answers: { [id]: answer } });
      log(`${id} ok: HTTP 200, in ${inputOf(msg.usage)} out ${msg.usage?.output_tokens} tokens, $${used.toFixed(4)}; total $${state.cost_usd.toFixed(4)}`);
    }
    if (ids.every((id) => fs.existsSync(path.join(out, "solo", `${id}.json`)))) mark("end");
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    exit = "stopped";
    state.stopped = { at: new Date().toISOString(), why: e.message };
    save();
    log(`STOPPED: ${e.message}`);
  }
  const done = ids.filter((id) => fs.existsSync(path.join(out, "solo", `${id}.json`))).length;
  log(`total: ${done} of ${ids.length} sites, ${state.http_requests} HTTP requests, $${state.cost_usd.toFixed(4)} of the $${settings.hard_stop_usd} stop`);
  return { exit, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exit } = await runClaude();
  process.exit(exit === "done" ? 0 : 3);
}
