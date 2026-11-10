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
//   GEMINI_GRADING_BUDGET  JSON {model: requests per day} the rubric may use;
//                       the rest of each quota is left for the vote job.
//   GEMINI_CATCHUP      "true" (default) or "false": catch-up mode, see judge.mjs.

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
// What grading may spend per model per day: 3.5 keeps 100 of its 500 for the
// daily vote job (30 votes plus retries), which falls back to 3.1.
export const DEFAULT_GRADING_BUDGET = {
  "gemini-3.5-flash-lite": 400,
  "gemini-3.1-flash-lite": 450,
};

const parseJsonEnv = (name, fallback) => {
  try {
    return process.env[name] ? { ...fallback, ...JSON.parse(process.env[name]) } : fallback;
  } catch {
    return fallback;
  }
};
export const dailyQuota = () => parseJsonEnv("GEMINI_DAILY_QUOTA", DEFAULT_DAILY_QUOTA);
export const prices = () => parseJsonEnv("GEMINI_PRICES", DEFAULT_PRICES);
export const gradingBudget = () => parseJsonEnv("GEMINI_GRADING_BUDGET", DEFAULT_GRADING_BUDGET);
/** Catch-up mode: on unless GEMINI_CATCHUP is "false". */
export const catchUpMode = () => String(process.env.GEMINI_CATCHUP ?? "true").toLowerCase() !== "false";

export async function ensureGeminiLog(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS gemini_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    run_id TEXT,
    job TEXT,
    model TEXT NOT NULL,
    status INTEGER,
    reason TEXT,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    retry INTEGER NOT NULL DEFAULT 0,
    fallback INTEGER NOT NULL DEFAULT 0,
    thoughts_tokens INTEGER
  )`);
  await db.execute("CREATE INDEX IF NOT EXISTS gemini_requests_at_idx ON gemini_requests (at)");
  // Thinking tokens (billed as output) came later; add the column to older tables.
  const cols = new Set((await db.execute("PRAGMA table_info(gemini_requests)")).rows.map((r) => String(r.name)));
  if (!cols.has("thoughts_tokens")) {
    try {
      await db.execute("ALTER TABLE gemini_requests ADD COLUMN thoughts_tokens INTEGER");
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message))) throw e;
    }
  }
}

/**
 * A request recorder for one run. `record` is the gemini client's onRequest:
 * it keeps the request in memory (for the run summary) and inserts it into
 * gemini_requests; a failed insert is counted, never thrown.
 */
export function createRequestLog({ db, job, runId = process.env.GITHUB_RUN_ID ?? null }) {
  const rows = [];
  let writeErrors = 0;
  return {
    rows,
    get writeErrors() {
      return writeErrors;
    },
    async record(r) {
      rows.push(r);
      if (!db) return;
      try {
        await db.execute({
          sql: `INSERT INTO gemini_requests (at, run_id, job, model, status, reason, latency_ms,
                                             input_tokens, output_tokens, thoughts_tokens, retry, fallback)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            r.at,
            runId,
            job,
            r.model,
            r.status ?? 0,
            r.reason ?? "",
            r.latencyMs ?? null,
            r.inputTokens ?? null,
            r.outputTokens ?? null,
            r.thoughtsTokens ?? null,
            r.retry ? 1 : 0,
            r.fallback ? 1 : 0,
          ],
        });
      } catch {
        writeErrors++;
      }
    },
  };
}

const usd = (n) => `$${n.toFixed(4)}`;

/** Markdown summary of one run's requests. */
export function runSummary(rows, priceTable = prices()) {
  const by = new Map();
  for (const r of rows) {
    const m = by.get(r.model) ?? { requests: 0, ok: 0, s5xx: 0, s429: 0, network: 0, retries: 0, fallbacks: 0, inTok: 0, outTok: 0, thinkTok: 0 };
    m.requests++;
    if (r.status === 200) m.ok++;
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
    "| Model | Requests | OK | 5xx | 429 | Network | Retries | Fallback | Input tokens | Output tokens | Thinking tokens | Est. cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  let total = 0;
  for (const [model, m] of by) {
    const p = priceTable[model] ?? { in: 0, out: 0 };
    const cost = (m.inTok * p.in + (m.outTok + m.thinkTok) * p.out) / 1e6;
    total += cost;
    lines.push(
      `| ${model} | ${m.requests} | ${m.ok} | ${m.s5xx} | ${m.s429} | ${m.network} | ${m.retries} | ${m.fallbacks} | ${m.inTok} | ${m.outTok} | ${m.thinkTok} | ${usd(cost)} |`
    );
  }
  if (!by.size) lines.push("| (none) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | $0.0000 |");
  lines.push(
    "",
    `Estimated cost at paid rates: ${usd(total)} (thinking billed as output; rates from GEMINI_PRICES, else Google's published rates on 2026-11-10).`,
    ""
  );
  return lines.join("\n");
}

/**
 * Today's (UTC) requests per model against the daily free quota, as Markdown,
 * with a warning at 80%. Returns { markdown, warnings }.
 */
export async function dailyTotals(db, { now = new Date(), quota = dailyQuota() } = {}) {
  const day = now.toISOString().slice(0, 10);
  const res = await db.execute({
    sql: `SELECT model, COUNT(*) AS n,
                 SUM(CASE WHEN status = 200 THEN 1 ELSE 0 END) AS ok
          FROM gemini_requests WHERE at >= ? AND at < ? GROUP BY model ORDER BY model`,
    args: [`${day}T00:00:00`, `${day}T99`],
  });
  const used = new Map(res.rows.map((r) => [String(r.model), { n: Number(r.n), ok: Number(r.ok) }]));
  const models = [...new Set([...Object.keys(quota), ...used.keys()])];
  const warnings = [];
  const lines = [
    `### Gemini today (${day} UTC)`,
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
