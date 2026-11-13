#!/usr/bin/env node
// The Claude Haiku 5.5 pass of "recheck-543" (scripts/experiments/
// recheck-543.mjs), run by the owner on their machine: every gradable site
// in the same batches of 5 as Gemini 3.1 (the plan's seed and order), then
// every gradable site one at a time. Exactly the locked grading-two-sets
// prompts, inputs and answer shapes, through the Claude API request of the
// two-sets test (claudeBodyFor: raw fetch, default effort and thinking).
//
// Safety:
// - the key comes from ANTHROPIC_API_KEY and is never printed or saved;
// - one request at a time;
// - a HARD STOP at a cumulative $3.00 across all runs (state.json keeps the
//   total): before each request the exact input is counted (count_tokens,
//   free) and the output estimated from the largest so far of that kind;
// - 429, 529 and 5xx are retried after 30 s, 60 s, 120 s and 300 s; a 4xx
//   that mentions a spend or usage limit stops the run as "spend limit",
//   any other 4xx stops it;
// - an answer that doesn't validate is asked again once, then recorded as
//   broken and the run goes on;
// - a finished request is never sent again: run it again to resume.
//
// Bundles: `node scripts/experiments/recheck-543.mjs fetch --capture-run N`
// first (gh run download, no secrets). Then:
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- \
//     node scripts/experiments/recheck-543-haiku.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { HAIKU, claudeBodyFor } from "./grading-two-sets-claude.mjs";
import { readJson, sha256, writeJson } from "./grading-two-sets-lib.mjs";
import { loadBundle, loadPrompts, parseResult } from "./grading-two-sets-run.mjs";
import { DIR, capturedIds, makePlan } from "./recheck-543.mjs";

export const SETTINGS = { ...HAIKU, folder: "haiku", hard_stop_usd: 3.0, first_output_estimate: { solo: 6000, batch: 30000 } };
const SPEND = /spend|usage limit|credit|billing|quota|limit.*(reached|exceeded)/i;

/** Batches (the Gemini plan's) first, then every site alone. */
export function haikuRequests(sites, ids) {
  const plan = makePlan(sites, ids);
  return [
    ...plan.requests.filter((r) => r.kind === "batch"),
    ...ids.map((id) => ({ key: `solo/${id}`, step: "solo", set: id[0], kind: "solo", ids: [id] })),
  ];
}

class Stop extends Error {
  constructor(message, outcome = "stopped") {
    super(message);
    this.outcome = outcome;
  }
}

export async function runHaiku({
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  settings = SETTINGS,
  dir = DIR,
  log = console.log,
} = {}) {
  if (!apiKey) throw new Error("Needs ANTHROPIC_API_KEY (run through pass-env).");
  const sel = readJson(path.join(dir, "selection.json"));
  const requests = haikuRequests(sel.sites, capturedIds(path.join(dir, "bundles")));
  const prompts = loadPrompts();
  const out = path.join(dir, settings.folder);
  const rawDir = path.join(dir, "raw", settings.folder);
  const statePath = path.join(out, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { model: settings.model, cost_usd: 0, http_requests: 0, attempts: [], items: {} };
  state.settings = settings;
  const save = () => writeJson(statePath, state);
  const cost = (i, o) => (i * settings.price_per_mtok.input + o * settings.price_per_mtok.output) / 1e6;
  const inputOf = (u) => (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0);
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": settings.version };
  const fileOf = (r) => path.join(out, r.step, `${r.key.split("/")[1]}.json`);
  const t0 = Date.now();
  let exit = "done";
  log(`${settings.model}: ${requests.length} requests (${requests.filter((r) => r.kind === "batch").length} batches, ${requests.filter((r) => r.kind === "solo").length} solo); $${state.cost_usd.toFixed(4)} of the $${settings.hard_stop_usd.toFixed(2)} stop spent`);
  try {
    for (const req of requests) {
      if (fs.existsSync(fileOf(req)) || state.items[req.key]?.broken_final) continue;
      const bundles = req.ids.map((id) => loadBundle(id, path.join(dir, "bundles")));
      const { body, refs } = claudeBodyFor(req.kind, bundles, prompts, req.kind, settings);
      const bodySha = sha256(JSON.stringify(body));
      const rawBody = JSON.parse(JSON.stringify(body));
      for (const c of rawBody.messages[0].content) if (c.type === "image") c.source = { type: "base64", media_type: c.source.media_type, ...refs.get(c.source.data) };
      const ct = await fetchImpl(`${settings.api}/messages/count_tokens`, { method: "POST", headers, body: JSON.stringify({ model: body.model, system: body.system, messages: body.messages, output_config: body.output_config }) });
      if (!ct.ok) {
        const t = await ct.text();
        throw new Stop(`count_tokens HTTP ${ct.status}: ${t.slice(0, 300)}`, ct.status >= 400 && ct.status < 500 && SPEND.test(t) ? "spend_limit" : "stopped");
      }
      const inputEst = (await ct.json()).input_tokens;
      const outputs = Object.values(state.items).filter((i) => i.kind === req.kind).map((i) => i.usage?.output_tokens ?? 0);
      const outputEst = outputs.length ? Math.max(...outputs) : settings.first_output_estimate[req.kind];
      const est = cost(inputEst, outputEst);
      if (state.cost_usd + est > settings.hard_stop_usd) throw new Stop(`hard stop: $${state.cost_usd.toFixed(4)} spent, the next request (${req.key}) is estimated at $${est.toFixed(4)}, the stop is $${settings.hard_stop_usd.toFixed(2)}`);
      let answers = null;
      for (let b = 0; b < 2 && !answers; b++) {
        let res;
        let text;
        for (let t = 0; ; t++) {
          const n = ++state.http_requests;
          const at = new Date().toISOString();
          save();
          const base = path.join(rawDir, `${req.key.replace("/", "__")}__http${String(n).padStart(4, "0")}`);
          writeJson(`${base}.request.json`, { at, http_request: n, key: req.key, try: t + 1, body_sha256: bodySha, estimate: { input_tokens: inputEst, output_tokens: outputEst, usd: est }, body: rawBody });
          const started = Date.now();
          try {
            res = await fetchImpl(`${settings.api}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
            text = await res.text();
          } catch (e) {
            res = { status: 0 };
            text = String(e?.message ?? e);
          }
          writeJson(`${base}.response.json`, { at: new Date().toISOString(), http_request: n, status: res.status, ms: Date.now() - started, text });
          state.attempts.push({ at, key: req.key, status: res.status, retry: t > 0, ms: Date.now() - started });
          save();
          if (res.status === 200) break;
          if (!(res.status === 0 || settings.retry_statuses.includes(res.status) || res.status >= 500)) {
            let type = "";
            let message = text.slice(0, 300);
            try {
              const e = JSON.parse(text).error ?? {};
              type = e.type ?? "";
              message = e.message ?? message;
            } catch {
              /* not JSON */
            }
            throw new Stop(`${req.key}: HTTP ${res.status} ${type}: ${message}`, SPEND.test(`${type} ${message}`) ? "spend_limit" : "stopped");
          }
          if (t >= settings.retry_delays_ms.length) throw new Stop(`${req.key}: still HTTP ${res.status} after ${t + 1} tries; run again later to resume here`);
          log(`  ${req.key}: HTTP ${res.status}, retrying in ${settings.retry_delays_ms[t] / 1000} s`);
          await sleep(settings.retry_delays_ms[t]);
        }
        const msg = JSON.parse(text);
        const used = cost(inputOf(msg.usage), msg.usage?.output_tokens ?? 0);
        state.cost_usd += used;
        const item = (state.items[req.key] = { ...(state.items[req.key] ?? {}), key: req.key, step: req.step, kind: req.kind, ids: req.ids, at: new Date().toISOString(), usage: msg.usage, stop_reason: msg.stop_reason, model: msg.model, cost_usd: (state.items[req.key]?.cost_usd ?? 0) + used, body_sha256: bodySha });
        try {
          if (msg.stop_reason !== "end_turn") throw new Error(`stop_reason ${msg.stop_reason}`);
          answers = parseResult(req.kind, JSON.parse((msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")), req.ids, prompts.schema.levels);
        } catch (e) {
          (item.broken ??= []).push(String(e?.message ?? e).slice(0, 300));
          log(`  ${req.key}: broken answer (${item.broken.at(-1).slice(0, 120)})${b === 0 ? ", asking again" : ", recorded"}`);
        }
        save();
        log(`${req.key} ${answers ? "ok" : "broken"}: in ${inputOf(msg.usage)} out ${msg.usage?.output_tokens} tokens, $${used.toFixed(4)}; total $${state.cost_usd.toFixed(4)} of $${settings.hard_stop_usd.toFixed(2)}`);
      }
      if (!answers) {
        state.items[req.key].broken_final = true;
        save();
        continue;
      }
      writeJson(fileOf(req), { step: req.step, kind: req.kind, ids: req.ids, pad: req.pad ?? [], model: settings.model, body_sha256: bodySha, answers });
    }
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    exit = e.outcome;
    state.stopped = { at: new Date().toISOString(), outcome: e.outcome, why: e.message, total_usd: state.cost_usd };
    save();
    log(`${e.outcome === "spend_limit" ? "SPEND LIMIT" : "STOPPED"}: ${e.message}`);
  }
  const done = requests.filter((r) => fs.existsSync(fileOf(r))).length;
  log(`total: ${done} of ${requests.length} requests answered, ${state.http_requests} HTTP requests, $${state.cost_usd.toFixed(4)} of the $${settings.hard_stop_usd.toFixed(2)} stop, ${Math.round((Date.now() - t0) / 60000)} min this run`);
  return { exit, state };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exit } = await runHaiku();
  process.exit(exit === "done" ? 0 : exit === "spend_limit" ? 4 : 3);
}
