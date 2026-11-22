#!/usr/bin/env node
// Phase 1 AI bootstrap (GRADING_CRITERIA.md §6): Gemini Flash-Lite judges
// captured portfolios with 3.5 Flash-Lite only (no fallback to a lower model;
// see pipeline/gemini.mjs).
//
//   rubric   - 1 call/site, rubric v2 (pipeline/rubric.mjs): the top-of-page
//              screenshot, the facts measured by code (pipeline/facts.mjs)
//              and the page's visible text -> tier, is_portfolio and five 1-5
//              quality scores with one short clause each, stored as JSON in
//              portfolios.ai_rubric with the rubric version, the model, the
//              token usage, the facts and the code checks.
//
// The ELO-era AI votes ("pairwise") were removed by the owner on 2026-11-21;
// AI comparisons are ranking v2's (pipeline/compare.mjs, the night's
// "compare" stage).
//
// Usage:
//   node pipeline/judge.mjs rubric   [--limit N] [--only substr] [--force] [--rpm R] [--model M] [--no-browser]
//
// Budget: every Gemini request is recorded in gemini_requests and summarized
// per run (pipeline/gemini-log.mjs). All requests share one pace: --rpm, else
// GEMINI_RPM, else 8 per minute. A site is graded once and never re-graded
// automatically (owner, 2026-11-21); --force grades again by hand, keeping
// each old grade in rubric_history.
import fs from "fs";
import path from "path";
import {
  createGemini,
  createLimiter,
  DEFAULT_RPM,
  fallbackEnabled,
  GeminiAuthError,
  GeminiQuotaError,
  GeminiUnavailableError,
  judgeModels,
  PRIMARY_MODEL,
} from "./gemini.mjs";
import { createRequestLog, dailyQuota, dailyTotals, ensureGeminiLog, runSummary } from "./gemini-log.mjs";
import { backgroundAllowance, budgetPlan, usageToday } from "./budget.mjs";
import { ensureRubricHistory, replaceGradeStatements } from "./rubric-history.mjs";
import { rankForWrite } from "../lib/tiers-store.mjs";
import { ensureReviewSchema } from "../lib/reviews/store.mjs";
import { atTheDoor, setAsideCapture, withCaptureColumns } from "../lib/reviews/door.mjs";
import { freshGradeDue } from "../lib/reviews/store.mjs";
import { parseObject, storedCaptureBlocked } from "../lib/reviews/stored-capture.mjs";
import {
  RESPONSE_SCHEMA,
  RUBRIC_VERSION,
  buildRubricRequest,
  gradeRecord,
  parseRubricResponse,
} from "./rubric.mjs";
import { pageEvidence } from "./evidence.mjs";
import { createRenderer } from "./render.mjs";
import { judgeOutcome } from "./judge-outcome.mjs";
import { AI_WORK, loadFeed, pipelineDb, syncRoster } from "./roster.mjs";

const ROOT = path.join(import.meta.dirname, "..");

// Optional: in CI (GitHub Actions) there's no .env.local — vars come from the
// runner env/secrets instead.
if (fs.existsSync(path.join(ROOT, ".env.local"))) {
  for (const line of fs
    .readFileSync(path.join(ROOT, ".env.local"), "utf8")
    .split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY missing from .env.local");
  process.exit(1);
}

const args = process.argv.slice(2);
const MODE = args[0];
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
// Owner decision (2026-11-10): grades come from 3.5 Flash-Lite
// only. When 3.5 stays busy after its retries, or its daily quota or grading
// budget is used up, the item waits for the next run; nothing falls back to
// 3.1. GEMINI_FALLBACK=on brings back the 3.5 -> 3.1 chain for labelled
// experiments only (every workflow pins it "off"); --model M uses only M.
const FALLBACK = !flag("model") && fallbackEnabled();
const MODELS = flag("model") ? [flag("model")] : judgeModels();
const LIMIT = Number(flag("limit", "0")) || Infinity;
const ONLY = flag("only", "");
const FORCE = args.includes("--force");
// One pace for every Gemini request in the run, retries included: --rpm,
// else the GEMINI_RPM repository variable, else DEFAULT_RPM.
const RPM = Number(flag("rpm", process.env.GEMINI_RPM || String(DEFAULT_RPM)));
// Public R2 base (no trailing slash): screenshots are fetched from here in CI
// when this machine has no capture of the site. Same env var lib/shots.ts uses.
const SHOTS_BASE = (process.env.SHOTS_BASE_URL || "").replace(/\/+$/, "");

if (MODE !== "rubric") {
  console.error(MODE === "pairwise" ? "pairwise (the ELO-era AI votes) was removed on 2026-11-21; ranking v2's AI comparisons are pipeline/compare.mjs" : "usage: node pipeline/judge.mjs rubric [flags]");
  process.exit(1);
}

const db = pipelineDb(ROOT);

// ---------------------------------------------------------------------------
// Gemini client (key in the x-goog-api-key header; see pipeline/gemini.mjs)
// ---------------------------------------------------------------------------
// Every request is recorded in gemini_requests (pipeline/gemini-log.mjs).
await ensureGeminiLog(db);
// Logged as the budget's job name for new grades.
const requestLog = createRequestLog({ db, job: "grade-new" });
const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY,
  models: MODELS,
  limiter: createLimiter({ rpm: RPM }),
  onRequest: (r) => requestLog.record(r),
  // A spent 3.5 quota ends the run; the rest waits for tomorrow. Only an
  // experiment (GEMINI_FALLBACK=on) moves to 3.1 instead.
  onDailyQuota: FALLBACK ? "fallback" : "stop",
});
if (FALLBACK) {
  console.log(
    `::warning::GEMINI_FALLBACK is on: experiment mode, ${MODELS.join(" > ")}. Answers from a lower model are labelled with it; never use this for production grades or votes.`
  );
}
// Why a run stopped early, for the job summary: a spent quota is planned
// waiting; anything else is an error.
const NO_FALLBACK = FALLBACK ? "" : " (no fallback to a lower model: GEMINI_FALLBACK is off)";

// Inline image part; skips files that would blow the request size cap.
function imagePart(file, budgetBytes = 5 * 1024 * 1024) {
  if (!fs.existsSync(file) || fs.statSync(file).size > budgetBytes) return null;
  return {
    inline_data: {
      mime_type: file.endsWith(".jpg") ? "image/jpeg" : "image/png",
      data: fs.readFileSync(file).toString("base64"),
    },
  };
}

// Generic uncached R2 image fetcher, used by rubric grading when this machine
// has no capture of the site (the backlog).
// Returns an inline_data part on success, the string "missing" on a definitive
// 404 (object genuinely absent), or null on a transient failure (5xx/timeout/
// oversize) — so callers can sentinel only on true absence, never on a blip.
async function r2Part(key, file, budgetBytes = 5 * 1024 * 1024) {
  if (!SHOTS_BASE) return null;
  try {
    const res = await fetch(`${SHOTS_BASE}/${key}/${file}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return "missing";
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > budgetBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > budgetBytes) return null;
    return {
      inline_data: {
        mime_type: file.endsWith(".jpg") ? "image/jpeg" : "image/png",
        data: buf.toString("base64"),
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// rubric mode (rubric v2: pipeline/rubric.mjs)
// ---------------------------------------------------------------------------
// Started on first use only; --no-browser keeps grading on plain HTTP.
const renderer = args.includes("--no-browser") ? null : createRenderer();

// Grade one site. Returns { status: "ok", rubric, model } | { status:
// "skipped" } (screenshot unavailable, retried next run) | { status:
// "sentinel" } (screenshot gone for good). Throws Gemini errors and
// malformed answers.
async function gradeRow(row) {
  const url = String(row.url);
  const key = String(row.shot_key);
  // One image: the settled top of the page, from this machine's capture when
  // there is one (the nightly job captures and grades on the same runner),
  // else from R2.
  let image = imagePart(path.join(ROOT, "captures", key, "hero.jpg"));
  let source = "local";
  if (!image) {
    const hero = await r2Part(key, "hero.jpg");
    if (hero === "missing") return { status: "sentinel" };
    if (!hero) return { status: "skipped" };
    image = hero;
    source = "r2";
  }
  const { pageText, facts } = await pageEvidence(db, row, { renderer });
  const request = buildRubricRequest({ name: String(row.name ?? ""), url, pageText, facts, image });
  const { result, model, usage } = await gemini.generate(request.parts, RESPONSE_SCHEMA, request.options);
  const parsed = parseRubricResponse(result);
  const rubric = gradeRecord({ parsed, model, usage, facts, source });
  return { status: "ok", rubric, model, pageText, facts };
}

// Grading stays inside the budget accountant's "Grade new sites" share
// (pipeline/budget.mjs). Every request counts, retries included, plus what
// earlier runs spent today (gemini_requests). Rows beyond it wait for tomorrow.

async function runRubric() {
  await ensureRubricHistory(db);
  // Every grade goes through the door (lib/reviews/door.mjs), which writes the owner's review rows.
  await ensureReviewSchema(db);
  // Only sites on the current list that aren't confirmed down get graded.
  // Sites the health check flagged needs_review (little that looks like a
  // portfolio) go first, so is_portfolio confirms or clears them soon.
  const res = await db.execute(
    `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts, signals, captured_at FROM portfolios
     WHERE status = 'live' AND shot_key IS NOT NULL AND ${AI_WORK()}
       ${FORCE ? "" : "AND ai_rubric IS NULL"}
     ORDER BY needs_review DESC, captured_at DESC, url`
  );
  let queue = res.rows.filter((r) => !ONLY || String(r.url).includes(ONLY));
  queue = queue.slice(0, LIMIT === Infinity ? queue.length : LIMIT);
  console.log(`rubric: judging ${queue.length} site(s) with ${MODELS.join(" > ")}`);

  let ok = 0;
  let errors = 0;
  let skipped = 0;
  // Set aside before any request: the stored capture does not show the site (handle).
  let setAside = 0;
  let consecutiveErrors = 0;
  let stopped = null;
  let deferred = 0;

  // What the budget accountant (pipeline/budget.mjs) allows new grades right
  // now ("Grade new sites"): within its cap and the quota left minus the
  // reserve kept for people. This run's own requests count against it.
  const plan = budgetPlan();
  const usage = await usageToday(db, { plan });
  const quota = dailyQuota();
  const allowed = { grade_new: backgroundAllowance("grade_new", usage, { plan, quota }).allowed };
  const spent = () => Object.values(gemini.requests).reduce((a, b) => a + b, 0);
  const room = () => allowed.grade_new - spent();
  // Each grade can take up to 4 requests (3 retries); start one only with room for that.
  const PER_GRADE = 4;
  const budgeted = MODELS[0] === PRIMARY_MODEL;
  // A spent 3.5 budget means waiting for tomorrow, never 3.1.
  const haveRoom = (need) => room() >= need;
  // Set when 3.5's daily quota answers 429: planned waiting, not an error.
  let quotaSpent = false;

  // Returns false when the run must stop (Gemini unavailable or out of quota).
  async function handle(given, label) {
    const url = String(given.url);
    try {
      // Never grade a stored capture that does not show the site (lib/reviews/stored-capture.mjs): set
      // aside for a new capture before any request, as the night does, and not counted as judged.
      const row = await withCaptureColumns(db, given);
      const blocked = storedCaptureBlocked(row);
      if (blocked) {
        const aside = await setAsideCapture(db, { row, why: blocked, now: new Date() });
        setAside++;
        console.log(`${label} ${url} - set aside, not sent to Gemini: the stored capture does not show the site (${blocked}); ${aside.recapture === "refresh" ? "a new capture is asked for" : "captured again first"}`);
        return true;
      }
      const out = await gradeRow(row);
      if (out.status === "sentinel") {
        // The screenshot is definitively absent from R2 (404): sentinel so this
        // row stops re-qualifying every run. Transient failures are "skipped".
        // A site waiting for its one fresh grade keeps that marker (lib/reviews/store.mjs FRESH_GRADE_DUE).
        if (!freshGradeDue(parseObject(row.ai_rubric))) {
          await db.execute({
            sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
            args: [JSON.stringify({ error: "no_usable_captures", judged_at: new Date().toISOString() }), url],
          });
        }
        console.log(`${label} ${url} - no captures on R2, sentineled`);
        return true;
      }
      if (out.status === "skipped") {
        skipped++;
        console.log(`${label} ${url} - skipped (screenshot unavailable, will retry)`);
        return true;
      }
      consecutiveErrors = 0;
      // "Is it a portfolio" is decided at the door (lib/reviews/door.mjs), as in the night run: the owner's
      // own verdict holds, a "no" is written as a held grade with its review row in one write. This
      // fallback never applies a removal itself; the hourly rule on the Worker does (REVIEW_AUTO_APPLY).
      const now = new Date();
      const door = await atTheDoor(db, {
        grade: out.rubric,
        row: { ...row, page_text: out.pageText ?? row.page_text, facts: out.facts == null ? row.facts : JSON.stringify(out.facts) },
        now,
        autoApply: false,
        // Checked above, unless the page text was only measured now (the door checks that one).
        captureChecked: row.page_text != null,
        gradeStatements: async (g) => replaceGradeStatements(url, row.ai_rubric, await rankForWrite(db, g, { url }), now),
      });
      ok++;
      console.log(
        `${label} ${url} - tier ${out.rubric.tier}, portfolio=${out.rubric.is_portfolio}, door=${door.outcome}, design=${out.rubric.visual_design?.score}, checks=${out.rubric.checks_score ?? "-"} (${out.model}, v${RUBRIC_VERSION})`
      );
      return true;
    } catch (e) {
      if (e instanceof GeminiAuthError) throw e;
      if (e instanceof GeminiQuotaError) {
        // Today's quota is used up: this row and the rest wait for tomorrow.
        quotaSpent = true;
        stopped = `${e.message}${NO_FALLBACK}`;
        console.log(`${label} ${url} - waits for tomorrow: ${e.message}`);
        return false;
      }
      errors++;
      console.log(`${label} ${url} - ERROR ${String(e.message).slice(0, 160)}`);
      if (e instanceof GeminiUnavailableError) {
        // 3.5 stayed unavailable through every retry: stop cleanly; this row
        // and the rest wait for the next run.
        stopped = `${e.message}; the rest waits for the next run${NO_FALLBACK}`;
        return false;
      }
      if (++consecutiveErrors >= 5) {
        stopped = "5 consecutive errors";
        return false;
      }
      return true;
    }
  }

  for (const [i, row] of queue.entries()) {
    if (budgeted && !haveRoom(PER_GRADE)) {
      deferred = queue.length - i;
      stopped = `today's ${PRIMARY_MODEL} budget for new grades is used (${allowed.grade_new} request(s) allowed this run); ${deferred} site(s) wait for tomorrow${NO_FALLBACK}`;
      break;
    }
    if (!(await handle(row, `[${i + 1}/${queue.length}]`))) {
      if (quotaSpent) deferred = queue.length - i;
      break;
    }
  }

  if (stopped) console.log(`  stopped early: ${stopped}`);
  console.log(
    `rubric done: ${ok}/${queue.length} judged, ${skipped} skipped, ${setAside} set aside (stored capture does not show the site), ${gemini.summary()}`
  );
  // A site set aside for its stored capture was never work for Gemini: not queued, so a run of only those is not a failure.
  return { queued: queue.length - setAside, ok, errors, skipped, deferred, stopped, setAside };
}

// The job summary: the judge's counts, this run's Gemini requests (per model,
// 5xx, 429, fallbacks, tokens, estimated cost) and today's totals against
// the daily quota, with a warning from 80%.
async function writeSummary(outcome, stopped) {
  let today = { markdown: "", warnings: [] };
  try {
    today = await dailyTotals(db);
  } catch {
    /* the request log is optional */
  }
  const md = [
    outcome.summary,
    stopped ? `Stopped early: ${stopped}. The next run continues where this one stopped.\n` : "",
    runSummary(requestLog.rows),
    today.markdown,
    requestLog.writeErrors ? `${requestLog.writeErrors} request(s) could not be written to gemini_requests.\n` : "",
  ].join("\n");
  for (const w of today.warnings) console.log(`::warning::${w}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  else console.log(md);
}

// ---------------------------------------------------------------------------
// Exit non-zero when the key is rejected, when there was work and nothing was
// judged, or when most of the work was skipped (pipeline/judge-outcome.mjs),
// so the workflow's "Notify on failure" step files an issue instead of the
// run passing green with nothing done (July-November 2026).
// Running out of daily quota after some successes still exits 0.
try {
  // Mark rows that left the list, so only roster sites are judged.
  const roster = await syncRoster(db, await loadFeed(ROOT));
  if (roster.delisted || roster.relisted) {
    console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
  }
  const counts = await runRubric().finally(() => renderer?.close());
  const outcome = judgeOutcome({ mode: MODE, ...counts });
  await writeSummary(outcome, counts.stopped);
  console.log(outcome.verdict);
  if (outcome.exitCode) {
    console.error(`::error::${MODE}: ${outcome.verdict} (${gemini.summary()})`);
    process.exit(1);
  }
} catch (e) {
  if (!(e instanceof GeminiAuthError)) throw e;
  await writeSummary({ summary: `## AI judge: ${MODE}\n\nFAILED: the API key was rejected.\n` }, null);
  console.error(`${e.message}\nCheck the GEMINI_API_KEY secret (${gemini.summary()}).`);
  process.exit(1);
}
