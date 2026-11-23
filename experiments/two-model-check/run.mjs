// Asks the models, through the cache. A cached answer is never asked again.
//
//   pass-env run -e GEMINI_API_KEY=portfolio-rank/GEMINI_API_KEY -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- \
//     node experiments/two-model-check/run.mjs --set design --prompt v1 --arms full --models gemini,haiku [--rep 1] [--limit N] [--only url,url] [--dry]
//
// --set design | heldout | stability (the 60 fixed held-out sites).
import { ASK } from "./models.mjs";
import {
  MAX_IN_FLIGHT, MAX_REQUESTS, MAX_SPEND_USD, MODELS,
  askable, buildRequest, cacheGet, cacheKey, cachePut, costOf, ledgerAdd, ledgerTotals,
  loadBench, loadSplit, savedPage, stabilitySample,
} from "./common.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(`--${name}`);

const set = opt("set");
const prompt = opt("prompt", "v1");
const arms = String(opt("arms", "full")).split(",");
const models = String(opt("models", "gemini,haiku")).split(",");
const rep = Number(opt("rep", "1"));
const limit = opt("limit") ? Number(opt("limit")) : Infinity;
const only = opt("only") ? new Set(opt("only").split(",")) : null;
const dry = has("dry");

const bench = loadBench();
const split = loadSplit();
const byUrl = new Map(bench.sites.map((s) => [s.url, s]));
let urls;
if (set === "design") urls = split.design;
else if (set === "heldout") urls = split.heldout;
else if (set === "stability") urls = stabilitySample(bench, split);
else throw new Error("--set design | heldout | stability");
if (only) urls = urls.filter((u) => only.has(u));

const jobs = [];
for (const url of urls) {
  const site = byUrl.get(url);
  const page = savedPage(site);
  if (!askable(page)) continue;
  for (const arm of arms) {
    const req = buildRequest(site, page, { arm, prompt });
    if (!req.image && arm !== "full" && arm !== "text") continue; // a picture-only arm with no picture
    for (const m of models) {
      const model = MODELS[m];
      const key = cacheKey(model, req, rep);
      if (cacheGet(key)) continue;
      jobs.push({ url, arm, m, model, req, key });
    }
  }
}
const todo = jobs.slice(0, limit);
const start = ledgerTotals();
console.log(`${set} ${prompt} arms=${arms} models=${models} rep=${rep}: ${todo.length} to ask (${jobs.length} not cached); ledger so far ${start.requests} requests, $${start.usd.toFixed(4)}`);
if (dry) {
  if (todo[0]) console.log(`--- first request (${todo[0].url}, ${todo[0].arm}) ---\n${todo[0].req.system}\n--- user ---\n[image: ${todo[0].req.image}]\n${todo[0].req.text}`);
  process.exit(0);
}

let requests = start.requests;
let usd = start.usd;
let stopped = null;
let done = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = [5_000, 20_000, 60_000];
let geminiPauseUntil = 0;

async function one(job) {
  for (let attempt = 0; ; attempt++) {
    if (stopped) return;
    if (requests >= MAX_REQUESTS) return void (stopped = `request cap ${MAX_REQUESTS} reached`);
    if (usd >= MAX_SPEND_USD) return void (stopped = `spend cap $${MAX_SPEND_USD} reached`);
    if (job.m === "gemini" && Date.now() < geminiPauseUntil) await sleep(geminiPauseUntil - Date.now());
    requests++;
    const t0 = Date.now();
    try {
      const r = await ASK[job.m](job.req);
      const cost = costOf(job.model, r.usage);
      usd += cost;
      ledgerAdd({ at: new Date().toISOString(), model: job.model, url: job.url, arm: job.arm, prompt, rep, ok: true, usage: r.usage, usd: cost, ms: Date.now() - t0 });
      cachePut(job.key, { url: job.url, arm: job.arm, prompt, rep, model: job.model, modelVersion: r.modelVersion, at: new Date().toISOString(), out: r.out, usage: r.usage, usd: cost, raw: r.raw });
      done++;
      return;
    } catch (e) {
      const cost = e.usage ? costOf(job.model, e.usage) : 0;
      usd += cost;
      ledgerAdd({ at: new Date().toISOString(), model: job.model, url: job.url, arm: job.arm, prompt, rep, ok: false, error: String(e.message).slice(0, 300), usage: e.usage ?? null, usd: cost, ms: Date.now() - t0 });
      if (/daily quota/.test(e.message)) return void (stopped = `Gemini daily quota: ${e.message}`);
      if (/not set|HTTP 40[13]|haiku 40[13]/.test(e.message)) return void (stopped = e.message);
      if (e.retry && attempt < BACKOFF.length) {
        if (job.m === "gemini" && e.status === 429) geminiPauseUntil = Date.now() + BACKOFF[attempt];
        console.log(`  retry ${attempt + 1} ${job.m} ${job.url}: ${e.message}`);
        await sleep(BACKOFF[attempt]);
        continue;
      }
      console.log(`  FAILED ${job.m} ${job.arm} ${job.url}: ${e.message}`);
      failed++;
      return;
    }
  }
}

let next = 0;
async function worker() {
  while (!stopped && next < todo.length) {
    const job = todo[next++];
    await one(job);
    if ((done + failed) % 25 === 0) console.log(`  ${done + failed}/${todo.length}, ${requests} requests in the ledger, $${usd.toFixed(4)}`);
  }
}
await Promise.all(Array.from({ length: MAX_IN_FLIGHT }, worker));
console.log(`done ${done}, failed ${failed}${stopped ? `, STOPPED: ${stopped}` : ""}; ledger ${requests} requests, $${usd.toFixed(4)}`);
if (stopped) process.exitCode = 2;
