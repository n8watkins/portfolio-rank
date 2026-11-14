#!/usr/bin/env node
// The screenshot check of recheck-543 (owner plan, 2026-11-13): the captures
// that were never graded because they stayed blocked (almost empty, a bot
// check, a gate or dialog still on top). One site per request, only the
// desktop and phone first screens plus the page's word count, with the prompt
// experiments/recheck-543/prompts/screen.txt (logged in prompt-log.md as
// "recheck-543-screen"). Each answer: a class (portfolio, intro_gate,
// loading, blank, bot_check, not_portfolio), what to click, a confidence and
// a one-line reason.
//
//   haiku    Claude Haiku 5.5, run by the owner (one `!` command; a hard stop
//            at $1, about 5 cents expected). Resumable.
//   gemini   Gemini 3.1 Flash-Lite on GitHub (free), the same prompt and
//            images, for the sites Haiku called a portfolio or not a
//            portfolio with high confidence: the both-model rule.
//
//   pass-env run -e ANTHROPIC_API_KEY=portfolio-rank/ANTHROPIC_API_KEY -- \
//     node scripts/experiments/recheck-543-screen.mjs haiku
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { HAIKU } from "./grading-two-sets-claude.mjs";
import { readJson, sha256, writeJson } from "./grading-two-sets-lib.mjs";
import { DIR, JOB, SET } from "./recheck-543.mjs";

export const PROMPT_ID = "recheck-543-screen";
export const PROMPT_FILE = path.join(import.meta.dirname, "..", "..", "experiments", "recheck-543", "prompts", "screen.txt");
export const CLASSES = ["portfolio", "intro_gate", "loading", "blank", "bot_check", "not_portfolio"];
export const SCHEMA = {
  type: "object",
  properties: {
    class: { type: "string", enum: CLASSES },
    click: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string" },
  },
  required: ["class", "click", "confidence", "reason"],
};
// The same schema in Gemini's OpenAPI form (upper-case types, as pipeline/gemini.mjs sends responseSchema).
export const GEMINI_SCHEMA = {
  type: "OBJECT",
  properties: {
    class: { type: "STRING", enum: CLASSES },
    click: { type: "STRING" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    reason: { type: "STRING" },
  },
  required: ["class", "click", "confidence", "reason"],
  propertyOrdering: ["class", "click", "confidence", "reason"],
};
const SETTINGS = { ...HAIKU, folder: "screen-haiku", hard_stop_usd: 1.0, max_tokens: 1000 };
const SPEND = /spend|usage limit|credit|billing|quota|limit.*(reached|exceeded)/i;

/** The blocked captures to check (from results.json): never graded, never a duplicate. */
export function screenIds(results) {
  return results.filter((r) => r.path === "capture_blocked").map((r) => r.id);
}

/** One site's inputs: the two first screens (base64) and the word count. */
export function screenInput(id, dir = DIR) {
  const b = path.join(dir, "bundles", SET, id);
  const meta = readJson(path.join(b, "meta.json"));
  const img = (f) => fs.readFileSync(path.join(b, f)).toString("base64");
  return { id, desktop: img("desktop.jpg"), phone: img("phone.jpg"), words: Number(meta.words ?? 0) };
}

/** Validates an answer; throws on a missing or unknown field. */
export function parseScreen(a) {
  if (!a || typeof a !== "object") throw new Error("answer is not an object");
  if (!CLASSES.includes(a.class)) throw new Error(`class ${JSON.stringify(a.class)}`);
  if (!["high", "medium", "low"].includes(a.confidence)) throw new Error(`confidence ${JSON.stringify(a.confidence)}`);
  return { class: a.class, click: String(a.click ?? ""), confidence: a.confidence, reason: String(a.reason ?? "") };
}

const userText = (x) => `Words of text on the page: ${x.words}.`;

// ---------------------------------------------------------------- Haiku

async function haiku({ apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  if (!apiKey) throw new Error("Needs ANTHROPIC_API_KEY (run through pass-env).");
  const system = fs.readFileSync(PROMPT_FILE, "utf8");
  const ids = screenIds(readJson(path.join(DIR, "results.json")));
  const out = path.join(DIR, SETTINGS.folder);
  const statePath = path.join(out, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { model: SETTINGS.model, prompt: PROMPT_ID, cost_usd: 0, http_requests: 0, attempts: [], answers: {} };
  const save = () => writeJson(statePath, state);
  const headers = { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": SETTINGS.version };
  const cost = (u) => (((u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)) * SETTINGS.price_per_mtok.input + (u?.output_tokens ?? 0) * SETTINGS.price_per_mtok.output) / 1e6;
  log(`${SETTINGS.model}: ${ids.length} sites, ${ids.filter((id) => !state.answers[id]).length} to do; $${state.cost_usd.toFixed(4)} of the $${SETTINGS.hard_stop_usd.toFixed(2)} stop spent`);
  for (const id of ids) {
    if (state.answers[id]) continue;
    if (state.cost_usd >= SETTINGS.hard_stop_usd * 0.98) {
      log(`hard stop: $${state.cost_usd.toFixed(4)} spent`);
      break;
    }
    const x = screenInput(id);
    const body = {
      model: SETTINGS.model,
      max_tokens: SETTINGS.max_tokens,
      system,
      output_config: { format: { type: "json_schema", schema: { ...SCHEMA, additionalProperties: false } } },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Desktop screenshot (1440x900), top of the home page:" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: x.desktop } },
            { type: "text", text: "Phone screenshot (390x844), top of the home page:" },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: x.phone } },
            { type: "text", text: userText(x) },
          ],
        },
      ],
    };
    let answer = null;
    for (let t = 0; t <= SETTINGS.retry_delays_ms.length && !answer; t++) {
      state.http_requests++;
      const at = new Date().toISOString();
      let res;
      let text;
      try {
        res = await fetchImpl(`${SETTINGS.api}/messages`, { method: "POST", headers, body: JSON.stringify(body) });
        text = await res.text();
      } catch (e) {
        res = { status: 0 };
        text = String(e?.message ?? e);
      }
      state.attempts.push({ at, id, status: res.status, retry: t > 0 });
      save();
      if (res.status === 200) {
        const msg = JSON.parse(text);
        const used = cost(msg.usage);
        state.cost_usd += used;
        try {
          answer = parseScreen(JSON.parse((msg.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")));
          state.answers[id] = { ...answer, usage: msg.usage, cost_usd: used, body_sha256: sha256(JSON.stringify(body)) };
          log(`${id}: ${answer.class} (${answer.confidence})${answer.click ? `, click "${answer.click}"` : ""}: ${answer.reason} [$${used.toFixed(4)}, total $${state.cost_usd.toFixed(4)}]`);
        } catch (e) {
          state.attempts.at(-1).broken = String(e?.message ?? e).slice(0, 200);
          log(`${id}: broken answer (${state.attempts.at(-1).broken})${t < 1 ? ", asking again" : ""}`);
          if (t >= 1) break;
        }
        save();
        continue;
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        log(`STOPPED at ${id}: HTTP ${res.status}${SPEND.test(text) ? " (spend limit)" : ""}: ${text.slice(0, 200)}`);
        save();
        return 3;
      }
      if (t >= SETTINGS.retry_delays_ms.length) break;
      log(`  ${id}: HTTP ${res.status}, retrying in ${SETTINGS.retry_delays_ms[t] / 1000} s`);
      await sleep(SETTINGS.retry_delays_ms[t]);
    }
  }
  save();
  const done = ids.filter((id) => state.answers[id]).length;
  log(`done: ${done} of ${ids.length} sites, ${state.http_requests} HTTP requests, $${state.cost_usd.toFixed(4)}`);
  return done === ids.length ? 0 : 3;
}

// ---------------------------------------------------------------- Gemini

async function gemini({ ids, log = console.log }) {
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const { createGemini, createLimiter } = await import("../../pipeline/gemini.mjs");
  const { createRequestLog, dailyTotals, ensureGeminiLog } = await import("../../pipeline/gemini-log.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  await ensureGeminiLog(db);
  const model = "gemini-3.1-flash-lite";
  const used = (await dailyTotals(db)).used.get(model)?.n ?? 0;
  const job = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM gemini_requests WHERE job = ?", args: [JOB] })).rows[0].n);
  const cap = Math.min(230 - job, 440 - used, ids.length * 2);
  log(`${model}: ${ids.length} sites; job ${JOB} has used ${job} of 230; ${used} today (cap 440); this run may send ${cap}`);
  if (cap <= 0) return 3;
  let sent = 0;
  const requestLog = createRequestLog({ db, job: JOB });
  const g = createGemini({
    apiKey: process.env.GEMINI_API_KEY,
    models: [model],
    limiter: createLimiter({ rpm: 8 }),
    retryDelaysMs: [30000, 60000],
    onDailyQuota: "stop",
    fetchImpl: async (url, init) => {
      if (sent >= cap) throw new Error(`HARDSTOP: ${cap} requests`);
      sent++;
      return fetch(url, init);
    },
    onRequest: (r) => requestLog.record(r),
    log,
  });
  const system = fs.readFileSync(PROMPT_FILE, "utf8");
  const outPath = path.join(DIR, "screen-gemini", "answers.json");
  const answers = fs.existsSync(outPath) ? readJson(outPath) : {};
  for (const id of ids) {
    if (answers[id]) continue;
    const x = screenInput(id);
    const parts = [
      { text: "Desktop screenshot (1440x900), top of the home page:" },
      { inline_data: { mime_type: "image/jpeg", data: x.desktop } },
      { text: "Phone screenshot (390x844), top of the home page:" },
      { inline_data: { mime_type: "image/jpeg", data: x.phone } },
      { text: userText(x) },
    ];
    try {
      const got = await g.generate(parts, GEMINI_SCHEMA, { prompt: PROMPT_ID, systemInstruction: system, thinkingLevel: "low", temperature: 0.2, maxOutputTokens: 2048 });
      answers[id] = { ...parseScreen(got.result), usage: got.usage };
      log(`${id}: ${answers[id].class} (${answers[id].confidence}): ${answers[id].reason}`);
    } catch (e) {
      log(`${id}: failed (${String(e?.message ?? e).slice(0, 160)})`);
      if (/HARDSTOP|quota/i.test(String(e?.message))) break;
    }
    writeJson(outPath, answers);
  }
  writeJson(outPath, answers);
  log(`${g.summary()}; ${sent} HTTP requests`);
  return ids.every((id) => answers[id]) ? 0 : 3;
}

/** Ids Haiku settled with high confidence as a portfolio or not: the ones Gemini checks too. */
export function geminiIds(haikuAnswers) {
  return Object.entries(haikuAnswers)
    .filter(([, a]) => a.confidence === "high" && (a.class === "portfolio" || a.class === "not_portfolio"))
    .map(([id]) => id)
    .sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const step = process.argv[2];
  if (step === "haiku") process.exit(await haiku());
  else if (step === "gemini") {
    const ids = process.argv[3] ? process.argv[3].split(",") : geminiIds(readJson(path.join(DIR, SETTINGS.folder, "state.json")).answers);
    process.exit(await gemini({ ids }));
  } else {
    console.error("usage: recheck-543-screen.mjs <haiku|gemini [ids]>");
    process.exit(1);
  }
}
