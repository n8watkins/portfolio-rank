// Monitoring for Gemini use: every HTTP request the judge makes is recorded in
// the gemini_requests table (Turso), and each run writes a summary to the job
// summary: requests per model, 5xx and 429 answers, fallbacks, tokens, an
// estimated cost at paid rates, and today's totals per model against the
// daily free quota (warning at 80%).
//
// Configurable through the environment (repository variables in Actions):
//   GEMINI_DAILY_QUOTA  JSON {model: requests per day}; default below
//                       (the owner's numbers, 2026-11-10).
//   GEMINI_PRICES       JSON {model: {in, out}} in USD per 1M tokens, for the
//                       cost estimate. The defaults are Google's published
//                       paid rates on 2026-11-10; thinking is billed as output.
// What each job may spend is decided by the budget accountant
// (pipeline/budget.mjs, GEMINI_BUDGET), which reads this table. "Today" is
// the Gemini quota day: midnight to midnight Pacific, when the free quota
// resets.
// GEMINI_CATCHUP (catch-up mode on 3.1) was removed on 2026-11-10: grades and
// votes come from 3.5 only (GEMINI_FALLBACK, pipeline/gemini.mjs).

import { GEMINI_LOG_COLUMNS, GEMINI_LOG_TABLES, applyTables } from "../lib/pipeline-schema.mjs";
import { quotaDay } from "./quota-day.mjs";

export const DEFAULT_DAILY_QUOTA = {
  "gemini-3.5-flash-lite": 500,
  "gemini-3.1-flash-lite": 500,
};
// Paid Standard rates per 1M tokens (ai.google.dev pricing, 2026-11-10):
// input text/image, and output including thinking.
export const DEFAULT_PRICES = {
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
};
export const WARN_SHARE = 0.8;

const parseJson = (raw, fallback) => {
  try {
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
};
const env = () => globalThis.process?.env ?? {};
/** The daily free quota per model; `raw` is a GEMINI_DAILY_QUOTA JSON value (default: the environment's). */
export const dailyQuota = (raw = env().GEMINI_DAILY_QUOTA) => parseJson(raw, DEFAULT_DAILY_QUOTA);
export const prices = (raw = env().GEMINI_PRICES) => parseJson(raw, DEFAULT_PRICES);

export async function ensureGeminiLog(db) {
  await applyTables(db, GEMINI_LOG_TABLES, GEMINI_LOG_COLUMNS);
}

/**
 * A request recorder for one run. `record` is the gemini client's onRequest:
 * it keeps the request in memory (for the run summary) and inserts it into
 * gemini_requests; a failed insert is counted, never thrown.
 */
export function createRequestLog({ db, job, runId = env().GITHUB_RUN_ID ?? null }) {
  const rows = [];
  let writeErrors = 0;
  const log = {
    rows,
    // The job new requests are logged under; a run that moves from one kind
    // of work to another (new grades, then re-grades) changes it.
    job,
    get writeErrors() {
      return writeErrors;
    },
    async record(r) {
      rows.push({ ...r, job: log.job });
      if (!db) return;
      try {
        await db.execute({
          sql: `INSERT INTO gemini_requests (at, run_id, job, model, status, reason, latency_ms,
                                             input_tokens, output_tokens, thoughts_tokens, retry, fallback, finish_reason, detail, prompt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            r.at,
            runId,
            log.job,
            r.model,
            r.status ?? 0,
            r.reason ?? "",
            r.latencyMs ?? null,
            r.inputTokens ?? null,
            r.outputTokens ?? null,
            r.thoughtsTokens ?? null,
            r.retry ? 1 : 0,
            r.fallback ? 1 : 0,
            r.finishReason ?? null,
            r.detail ?? null,
            r.prompt ?? null,
          ],
        });
      } catch {
        writeErrors++;
      }
    },
  };
  return log;
}

const usd = (n) => `$${n.toFixed(4)}`;

/** Markdown summary of one run's requests. */
export function runSummary(rows, priceTable = prices()) {
  const by = new Map();
  for (const r of rows) {
    const m = by.get(r.model) ?? { requests: 0, ok: 0, cut: 0, s5xx: 0, s429: 0, network: 0, retries: 0, fallbacks: 0, inTok: 0, outTok: 0, thinkTok: 0 };
    m.requests++;
    if (r.status === 200 && r.finishReason && r.finishReason !== "STOP") m.cut++;
    else if (r.status === 200) m.ok++;
    else if (r.status >= 500) m.s5xx++;
    else if (r.status === 429) m.s429++;
    else if (!r.status) m.network++;
    if (r.retry) m.retries++;
    if (r.fallback) m.fallbacks++;
    m.inTok += r.inputTokens ?? 0;
    m.outTok += r.outputTokens ?? 0;
    m.thinkTok += r.thoughtsTokens ?? 0;
    by.set(r.model, m);
  }
  const lines = [
    "### Gemini requests this run",
    "",
    "| Model | Requests | OK | Cut off | 5xx | 429 | Network | Retries | Fallback | Input tokens | Output tokens | Thinking tokens | Est. cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  let total = 0;
  for (const [model, m] of by) {
    const p = priceTable[model] ?? { in: 0, out: 0 };
    const cost = (m.inTok * p.in + (m.outTok + m.thinkTok) * p.out) / 1e6;
    total += cost;
    lines.push(
      `| ${model} | ${m.requests} | ${m.ok} | ${m.cut} | ${m.s5xx} | ${m.s429} | ${m.network} | ${m.retries} | ${m.fallbacks} | ${m.inTok} | ${m.outTok} | ${m.thinkTok} | ${usd(cost)} |`
    );
  }
  if (!by.size) lines.push("| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $0.0000 |");
  lines.push(
    "",
    `Estimated cost at paid rates: ${usd(total)} (thinking billed as output; rates from GEMINI_PRICES, else Google's published rates on 2026-11-10). "Cut off": answered without finishing (finishReason other than STOP, such as MAX_TOKENS); never stored.`,
    ""
  );
  return lines.join("\n");
}

/**
 * The quota day's requests per model (midnight to midnight Pacific, when the
 * free quota resets) against the daily free quota, as Markdown, with a
 * warning at 80%. Returns { markdown, warnings, used }.
 */
export async function dailyTotals(db, { now = new Date(), quota = dailyQuota() } = {}) {
  const { day, start, end } = quotaDay(now);
  const res = await db.execute({
    sql: `SELECT model, COUNT(*) AS n,
                 SUM(CASE WHEN status = 200 AND COALESCE(finish_reason, 'STOP') = 'STOP' THEN 1 ELSE 0 END) AS ok
          FROM gemini_requests WHERE at >= ? AND at < ? GROUP BY model ORDER BY model`,
    args: [start.toISOString(), end.toISOString()],
  });
  const used = new Map(res.rows.map((r) => [String(r.model), { n: Number(r.n), ok: Number(r.ok) }]));
  const models = [...new Set([...Object.keys(quota), ...used.keys()])];
  const warnings = [];
  const lines = [
    `### Gemini today (${day}, Pacific quota day)`,
    "",
    "| Model | Requests | Answered | Daily quota | Used |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const model of models) {
    const u = used.get(model) ?? { n: 0, ok: 0 };
    const q = quota[model];
    const share = q ? u.n / q : 0;
    if (q && share >= WARN_SHARE) warnings.push(`${model} has used ${u.n} of ${q} requests today (${Math.round(share * 100)}%)`);
    lines.push(`| ${model} | ${u.n} | ${u.ok} | ${q ?? "-"} | ${q ? `${Math.round(share * 100)}%` : "-"} |`);
  }
  lines.push("");
  for (const w of warnings) lines.push(`> **Warning:** ${w}.`, "");
  return { markdown: lines.join("\n"), warnings, used };
}
