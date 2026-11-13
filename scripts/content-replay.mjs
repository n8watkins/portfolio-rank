// The content writer's replay harness (docs/audits/blog-engine.md, action 1):
// runs the writer (pipeline/content/compose.mjs) on the recorded fact sheets
// in tests/fixtures/content-replay and reports, per sheet and in total, the
// pass rate, the requests spent and the words, and writes each draft as
// Markdown for grading.
//
//   node scripts/content-replay.mjs [--length short|standard|medium|long] [--out DIR]
//       mock: a deterministic stand-in answers (pipeline/content/mock-writer.mjs); no network
//   node scripts/content-replay.mjs --replay DIR
//       answers recorded by an earlier --record run, in order; no network
//   CONTENT_REPLAY_LIVE=1 node scripts/content-replay.mjs --record DIR
//       live Gemini (GEMINI_API_KEY), saving every answer to DIR; refuses
//       without CONTENT_REPLAY_LIVE=1, so it never spends quota by accident
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeDraft } from "../pipeline/content/compose.mjs";
import { mockAnswer } from "../pipeline/content/mock-writer.mjs";
import { fill } from "../pipeline/content/writer.mjs";
import { assembleBody } from "../pipeline/content/writer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const fixtures = opt("--fixtures") ?? path.join(here, "../tests/fixtures/content-replay");
const out = opt("--out");
const length = opt("--length");
const replay = opt("--replay");
const record = opt("--record");
const budget = Number(opt("--budget") ?? 6);

let live = null;
if (record) {
  if (process.env.CONTENT_REPLAY_LIVE !== "1") throw new Error("--record calls Gemini: set CONTENT_REPLAY_LIVE=1 to confirm");
  const { createGemini, createLimiter } = await import("../pipeline/gemini.mjs");
  const { CONTENT_GEMINI } = await import("../pipeline/content/busy.mjs");
  live = createGemini({ apiKey: process.env.GEMINI_API_KEY, ...CONTENT_GEMINI, limiter: createLimiter({ rpm: 8 }), onDailyQuota: "stop", retryBudget: 2, log: (l) => console.log(l) });
  fs.mkdirSync(record, { recursive: true });
}

const rows = [];
for (const file of fs.readdirSync(fixtures).filter((f) => f.endsWith(".json")).sort()) {
  const base = JSON.parse(fs.readFileSync(path.join(fixtures, file), "utf8"));
  const sheet = { ...base, ...(length ? { length } : {}) };
  const key = file.replace(/\.json$/, "");
  const recorded = replay ? JSON.parse(fs.readFileSync(path.join(replay, `${key}.json`), "utf8")) : null;
  const answers = [];
  let used = 0;
  const generate = async (req) => {
    if (used >= budget) throw new Error(`budget of ${budget} requests used`);
    used++;
    let answer;
    if (recorded) answer = recorded.shift();
    else if (live) answer = (await live.generate(req.parts, req.schema, req.options)).result;
    else answer = mockAnswer(req);
    answers.push(answer);
    return answer;
  };
  let r;
  try {
    r = await composeDraft(sheet, { generate, left: () => budget - used, roster: [], log: () => {} });
  } catch (e) {
    r = { passed: false, failures: [String(e.message)], requests: used, words: 0 };
  }
  if (record) fs.writeFileSync(path.join(record, `${key}.json`), JSON.stringify(answers, null, 1));
  if (out && r.draft) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, `${key}.md`), `# ${fill(r.draft.title, sheet.facts)}\n\n_${fill(r.draft.subtitle, sheet.facts)}_\n\n${fill(assembleBody(r.draft), sheet.facts)}\n`);
  }
  rows.push({ key, length: sheet.length ?? "standard", passed: r.passed, requests: r.requests, words: r.words, failures: r.failures ?? [] });
}

const pad = (s, n) => String(s).padEnd(n);
for (const r of rows) console.log(`${pad(r.key, 42)} ${pad(r.length, 9)} ${r.passed ? "pass" : "FAIL"}  ${pad(r.requests, 3)} req  ${pad(r.words, 5)} words  ${r.failures.slice(0, 2).join(" | ").slice(0, 160)}`);
const passed = rows.filter((r) => r.passed).length;
const avg = (k) => (rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length)).toFixed(1);
console.log(`\n${passed} of ${rows.length} passed; ${avg("requests")} requests and ${avg("words")} words a draft on average`);
if (out) fs.writeFileSync(path.join(out, "summary.json"), JSON.stringify(rows, null, 1));
