#!/usr/bin/env node
// Phase 1 AI bootstrap (GRADING_CRITERIA.md §6): Gemini Flash-Lite judges
// captured portfolios (3.5 Flash-Lite, falling back to 3.1 Flash-Lite; see
// pipeline/gemini.mjs and pipeline/ai-votes.mjs).
//
//   rubric   - 1 call/site, rubric v2 (pipeline/rubric.mjs): the top-of-page
//              screenshot, the facts measured by code (pipeline/facts.mjs)
//              and the page's visible text -> tier, is_portfolio and five 1-5
//              quality scores with one short clause each, stored as JSON in
//              portfolios.ai_rubric with the rubric version, the model, the
//              token usage, the facts and the code checks.
//   pairwise — 1 call = 2 sites: "which is better overall?" on hero shots →
//              a vote in the `votes` table (rater_type='ai') that moves ELO,
//              same math and pair_key convention as human votes.
//
// Usage:
//   node pipeline/judge.mjs rubric   [--limit N] [--only substr] [--force] [--rpm R] [--model M]
//   node pipeline/judge.mjs pairwise [--votes N] [--rpm R] [--model M]
//
// Budget: every Gemini request is recorded in gemini_requests and summarized
// per run (pipeline/gemini-log.mjs). All requests share one pace: --rpm, else
// GEMINI_RPM, else 8 per minute. The rubric re-grades grades not made by
// 3.5 Flash-Lite with whatever room today's quota has left (low priority;
// --no-regrade turns it off), then, only when RUBRIC_REGRADE is "true",
// 3.5 grades from an older rubric version (lowest priority), keeping each
// old grade in rubric_history.
import fs from "fs";
import path from "path";
import {
  createGemini,
  createLimiter,
  DEFAULT_RPM,
  FLASH_LITE_CHAIN,
  GeminiAuthError,
  GeminiUnavailableError,
  PRIMARY_MODEL,
} from "./gemini.mjs";
import { catchUpMode, createRequestLog, dailyTotals, ensureGeminiLog, gradingBudget, runSummary } from "./gemini-log.mjs";
import { ensureRubricHistory, regradeQueue, replaceGradeStatements, versionRegradeQueue } from "./rubric-history.mjs";
import {
  RESPONSE_SCHEMA,
  RUBRIC_VERSION,
  buildRubricRequest,
  gradeRecord,
  normalizePageText,
  parseRubricResponse,
} from "./rubric.mjs";
import { measurePage } from "./facts.mjs";
import { httpGate, UA, visibleText } from "./gate.mjs";
import { prepareAiVotes, FLASH_LITE_RATER_ID, raterIdFor } from "./ai-votes.mjs";
import { judgeOutcome } from "./judge-outcome.mjs";
import { ACTIVE, NOT_PORTFOLIO, loadFeed, pipelineDb, syncRoster } from "./roster.mjs";

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
// flash-lite has the biggest free-tier daily budget. The default is the
// flash-lite chain (3.5, then 3.1 when 3.5 is rate limited, overloaded or
// unreachable); --model M uses only M, with no fallback.
const MODELS = flag("model") ? [flag("model")] : FLASH_LITE_CHAIN;
const RATER_ID = raterIdFor(MODELS);
const LIMIT = Number(flag("limit", "0")) || Infinity;
const VOTES = Number(flag("votes", "20"));
const ONLY = flag("only", "");
const FORCE = args.includes("--force");
// One pace for every Gemini request in the run, retries included: --rpm,
// else the GEMINI_RPM repository variable, else DEFAULT_RPM.
const RPM = Number(flag("rpm", process.env.GEMINI_RPM || String(DEFAULT_RPM)));
// Catch-up mode (repository variable GEMINI_CATCHUP, on unless "false"):
// while the backlog and the one-time full re-grade are being worked through,
// grading uses 3.5's daily budget first and then 3.1's, so both quotas work.
// Every 3.1 grade goes on the re-grade queue for 3.5 afterwards.
const CATCHUP = catchUpMode();
// Re-grade 3.5 grades from an older rubric version (lowest priority, inside
// the grading budget). Off unless the RUBRIC_REGRADE repository variable is
// "true": the owner decides when the one-time re-grade starts.
const RUBRIC_REGRADE = String(process.env.RUBRIC_REGRADE ?? "").toLowerCase() === "true";
// pairwise: concentrate votes on these graded tiers (NULL/other tiers excluded).
const TIERS = (flag("tiers", "S,A,B") || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
// Public R2 base (no trailing slash) — heroes are fetched from here in CI where
// there are no local captures. Same env var lib/shots.ts uses.
const SHOTS_BASE = (process.env.SHOTS_BASE_URL || "").replace(/\/+$/, "");

if (MODE === "pairwise") {
  if (RATER_ID !== FLASH_LITE_RATER_ID && !args.includes("--allow-model")) {
    console.error("pairwise voting is flash-lite only (pass --allow-model to override)");
    process.exit(1);
  }
  if (!SHOTS_BASE) {
    console.error("SHOTS_BASE_URL required for pairwise (heroes are fetched from R2)");
    process.exit(1);
  }
  if (!TIERS.length) {
    console.error("--tiers must name at least one tier (e.g. S,A,B)");
    process.exit(1);
  }
}

const db = pipelineDb(ROOT);

// Same direction-independent key as lib/elo.ts pairKey() — "\n" separator on
// purpose (can't appear in a URL; NUL would be truncated by SQLite).
const pairKey = (a, b) => [a, b].sort().join("\n");
const BASE_ELO = 1200;
// Zero-sum like lib/elo.ts eloUpdate(): the loser loses exactly what the winner gains.
function eloUpdate(winnerElo, loserElo, k = 32) {
  const expectedWin = 1 / (1 + 10 ** ((loserElo - winnerElo) / 400));
  const gain = Math.round(k * (1 - expectedWin));
  return { winner: winnerElo + gain, loser: loserElo - gain };
}

// ---------------------------------------------------------------------------
// Gemini client (key in the x-goog-api-key header; see pipeline/gemini.mjs)
// ---------------------------------------------------------------------------
// Every request is recorded in gemini_requests (pipeline/gemini-log.mjs).
await ensureGeminiLog(db);
const requestLog = createRequestLog({ db, job: MODE });
const gemini = createGemini({
  apiKey: process.env.GEMINI_API_KEY,
  models: MODELS,
  limiter: createLimiter({ rpm: RPM }),
  onRequest: (r) => requestLog.record(r),
  // Outside catch-up mode, grading waits for tomorrow's 3.5 quota rather
  // than spending 3.1 (whose grades would be re-graded by 3.5 later anyway);
  // a single grade that keeps failing on 3.5 after the retries still goes to
  // 3.1. In catch-up mode, and for votes, a spent 3.5 quota moves to 3.1.
  onDailyQuota: MODE === "rubric" && !CATCHUP ? "stop" : "fallback",
});

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

// Fetch a hero from R2 as an inline image part (pairwise runs on CI with no
// local captures). Only SUCCESS and a definitive 404 are cached — transient
// failures (timeout/5xx/network) return null WITHOUT caching, so a brief R2
// blip can't blacklist a site for the whole run (it retries on a later round).
const heroCache = new Map(); // shot_key -> inline_data | null
async function heroPart(key, budgetBytes = 5 * 1024 * 1024) {
  if (heroCache.has(key)) return heroCache.get(key);
  try {
    const res = await fetch(`${SHOTS_BASE}/${key}/hero.jpg`, {
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) {
      heroCache.set(key, null); // genuinely absent — cache the miss
      return null;
    }
    if (res.ok) {
      const len = Number(res.headers.get("content-length") || 0);
      if (len && len > budgetBytes) {
        heroCache.set(key, null);
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > budgetBytes) {
        heroCache.set(key, null);
        return null;
      }
      const part = { inline_data: { mime_type: "image/jpeg", data: buf.toString("base64") } };
      heroCache.set(key, part);
      return part;
    }
    return null; // transient (5xx, etc.) — not cached, retry later
  } catch {
    return null; // network/timeout — not cached, retry later
  }
}

// Generic uncached R2 image fetcher, used by rubric grading when this machine
// has no capture of the site (re-grades, the backlog).
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

// Batch-load cached objective signals (PSI/Lighthouse + inspect polish) for a
// set of URLs from the generic `cache` table. Keys mirror the API routes
// (`psi:<url>` 30d TTL, `inspect:<url>` 7d TTL); stale/unparseable/!ok rows are
// dropped. Wrapped so a missing `cache` table (cold DB) degrades to empty maps
// rather than throwing and killing the whole run.
const PSI_TTL = 30 * 24 * 3600 * 1000;
const INSPECT_TTL = 7 * 24 * 3600 * 1000;
async function loadSignals(urls) {
  const psi = new Map();
  const insp = new Map();
  try {
    const keys = [];
    for (const u of urls) keys.push(`psi:${u}`, `inspect:${u}`);
    if (!keys.length) return { psi, insp };
    const ph = keys.map(() => "?").join(",");
    const res = await db.execute({
      sql: `SELECT k, v, at FROM cache WHERE k IN (${ph})`,
      args: keys,
    });
    for (const row of res.rows) {
      const k = String(row.k);
      const age = Date.now() - Number(row.at);
      let v;
      try {
        v = JSON.parse(String(row.v));
      } catch {
        continue;
      }
      if (k.startsWith("psi:") && age < PSI_TTL && v.ok) psi.set(k.slice(4), v);
      else if (k.startsWith("inspect:") && age < INSPECT_TTL && v.ok) insp.set(k.slice(8), v);
    }
  } catch {
    /* no cache table / DB hiccup — judge on visuals alone */
  }
  return { psi, insp };
}

// Format a site's objective signals for the prompt, omitting any absent field so
// the prompt never asserts data it lacks (missing == unknown, not bad).
function signalLines(label, url, sig) {
  const lines = [];
  const p = sig.psi.get(url);
  if (p?.scores) {
    const s = p.scores;
    const parts = [];
    if (s.performance != null) parts.push(`perf ${s.performance}`);
    if (s.accessibility != null) parts.push(`a11y ${s.accessibility}`);
    if (s["best-practices"] != null) parts.push(`best-practices ${s["best-practices"]}`);
    if (s.seo != null) parts.push(`seo ${s.seo}`);
    if (parts.length) lines.push(`Lighthouse (mobile, 0-100): ${parts.join(", ")}`);
    if (p.metrics?.length)
      lines.push(`Core Web Vitals: ${p.metrics.map((m) => `${m.label} ${m.value}`).join(", ")}`);
  }
  const i = sig.insp.get(url);
  if (i) {
    const flags = [];
    if (i.customDomain) flags.push("custom domain");
    else if (i.customDomain === false) flags.push("on free hosting subdomain");
    if (i.hasGithubLink) flags.push("links GitHub");
    if (i.hasResume) flags.push("has resume/CV");
    if (i.hasContact) flags.push("has contact/LinkedIn");
    if (i.ogImageLoads) flags.push("working social preview image");
    if (i.favicon) flags.push("favicon");
    if (typeof i.copyrightYear === "number") flags.push(`copyright ${i.copyrightYear}`);
    if (flags.length) lines.push(`Polish signals: ${flags.join(", ")}`);
  }
  return lines.length ? `${label} metrics:\n  ${lines.join("\n  ")}` : `${label} metrics: none available`;
}

// ---------------------------------------------------------------------------
// rubric mode (rubric v2: pipeline/rubric.mjs)
// ---------------------------------------------------------------------------
const parseJson = (v) => {
  if (v == null) return null;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

// The page text and measured facts for a grade: stored by capture.mjs, or,
// for rows captured before facts existed, measured now over plain HTTP (free)
// and stored. Motion always comes from the capture (meta.motion).
async function pageEvidence(row) {
  const url = String(row.url);
  const m = parseJson(row.meta)?.motion;
  const motion = typeof m === "boolean" ? m : null;
  const stored = parseJson(row.facts);
  if (row.page_text != null && stored) {
    return { pageText: String(row.page_text), facts: stored.motion == null && motion != null ? { ...stored, motion } : stored };
  }
  const gate = await httpGate(url).catch(() => null);
  if (gate?.status !== "live") {
    return { pageText: "", facts: motion == null ? null : { source: "capture", motion } };
  }
  const text = visibleText(gate.html);
  const facts = await measurePage(
    { html: gate.html, text, url, finalUrl: gate.finalUrl, name: String(row.name ?? ""), motion, source: "http" },
    { userAgent: UA }
  );
  const pageText = normalizePageText(text);
  try {
    await db.execute({
      sql: "UPDATE portfolios SET page_text = ?, facts = ?, facts_at = ? WHERE url = ?",
      args: [pageText, JSON.stringify(facts), facts.measured_at, url],
    });
  } catch {
    /* the grade still uses them; the next grade measures again */
  }
  return { pageText, facts };
}

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
  const { pageText, facts } = await pageEvidence(row);
  const request = buildRubricRequest({ name: String(row.name ?? ""), url, pageText, facts, image });
  const { result, model, usage } = await gemini.generate(request.parts, RESPONSE_SCHEMA, request.options);
  const parsed = parseRubricResponse(result);
  const rubric = gradeRecord({ parsed, model, usage, facts, source });
  return { status: "ok", rubric, model };
}

// Grading stays inside a daily budget per model (GEMINI_GRADING_BUDGET;
// 3.5's leaves room in its 500 for the daily vote job). Every request counts,
// retries included, plus what earlier runs spent today (gemini_requests).
// Rows beyond the budget wait for tomorrow.

async function runRubric() {
  await ensureRubricHistory(db);
  // Only sites on the current list that aren't confirmed down get graded.
  // Sites the health check flagged needs_review (little that looks like a
  // portfolio) go first, so is_portfolio confirms or clears them soon.
  const res = await db.execute(
    `SELECT url, name, shot_key, meta, ai_rubric, page_text, facts FROM portfolios
     WHERE status = 'live' AND shot_key IS NOT NULL AND ${ACTIVE()}
       ${FORCE ? "" : "AND ai_rubric IS NULL"}
     ORDER BY needs_review DESC, captured_at DESC, url`
  );
  let queue = res.rows.filter((r) => !ONLY || String(r.url).includes(ONLY));
  queue = queue.slice(0, LIMIT === Infinity ? queue.length : LIMIT);
  console.log(`rubric: judging ${queue.length} site(s) with ${MODELS.join(" > ")}`);

  let ok = 0;
  let errors = 0;
  let skipped = 0;
  let regraded = 0;
  let consecutiveErrors = 0;
  let stopped = null;
  let deferred = 0;

  // Today's requests per model before this run, plus this run's own, against
  // the grading budget.
  const budget = gradingBudget();
  const { used } = await dailyTotals(db);
  const room = (model = gemini.activeModel) =>
    (budget[model] ?? 0) - (used.get(model)?.n ?? 0) - (gemini.requests[model] ?? 0);
  // Each grade can take up to 4 requests (3 retries); start one only with room for that.
  const PER_GRADE = 4;
  const budgeted = MODELS[0] === PRIMARY_MODEL;
  // In catch-up mode a spent 3.5 budget moves grading to 3.1; otherwise it waits.
  const haveRoom = (need) => {
    if (room() >= need) return true;
    if (CATCHUP && gemini.activeModel === PRIMARY_MODEL) {
      const next = gemini.useNextModel();
      if (next) {
        console.log(`  ${PRIMARY_MODEL} grading budget used; catch-up mode continues on ${next}`);
        return room() >= need;
      }
    }
    return false;
  };

  // Returns false when the run must stop (Gemini unavailable or out of quota).
  async function handle(row, label, { regrade = false } = {}) {
    const url = String(row.url);
    try {
      const out = await gradeRow(row);
      if (out.status === "sentinel") {
        // The screenshot is definitively absent from R2 (404): sentinel so this
        // row stops re-qualifying every run. Transient failures are "skipped".
        if (!regrade) {
          await db.execute({
            sql: "UPDATE portfolios SET ai_rubric = ? WHERE url = ?",
            args: [JSON.stringify({ error: "no_usable_captures", judged_at: new Date().toISOString() }), url],
          });
        }
        console.log(`${label} ${url} - no captures on R2${regrade ? "" : ", sentineled"}`);
        return true;
      }
      if (out.status === "skipped") {
        skipped++;
        console.log(`${label} ${url} - skipped (screenshot unavailable, will retry)`);
        return true;
      }
      consecutiveErrors = 0;
      if (regrade && out.model !== PRIMARY_MODEL) {
        // A re-grade only helps when the primary model makes it.
        console.log(`${label} ${url} - answered by ${out.model}, not ${PRIMARY_MODEL}; re-grading stops`);
        return false;
      }
      await db.batch(replaceGradeStatements(url, row.ai_rubric, out.rubric), "write");
      if (regrade) regraded++;
      else ok++;
      console.log(
        `${label} ${url} - tier ${out.rubric.tier}, portfolio=${out.rubric.is_portfolio}, design=${out.rubric.visual_design?.score}, checks=${out.rubric.checks_score ?? "-"} (${out.model}, v${RUBRIC_VERSION})${regrade ? " [re-grade]" : ""}`
      );
      return true;
    } catch (e) {
      if (e instanceof GeminiAuthError) throw e;
      errors++;
      console.log(`${label} ${url} - ERROR ${String(e.message).slice(0, 160)}`);
      if (e instanceof GeminiUnavailableError) {
        // Out of quota, or the models stayed unavailable through every retry:
        // stop cleanly; the next run picks up the rest.
        stopped = e.message;
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
      stopped = `today's grading budget is used (${JSON.stringify(budget)}); ${deferred} site(s) wait for tomorrow`;
      break;
    }
    if (!(await handle(row, `[${i + 1}/${queue.length}]`))) break;
  }

  // Re-grade queues, after new and ungraded sites: first grades not made by
  // 3.5 (3.1 -> 3.5), then, lowest priority and only with RUBRIC_REGRADE,
  // 3.5 grades from an older rubric version. Both run only on 3.5, within
  // its grading budget.
  let regradeQueued = 0;
  const regradeOn = () =>
    !stopped && !FORCE && !ONLY && !args.includes("--no-regrade") && budgeted && gemini.activeModel === PRIMARY_MODEL;
  const slots = () => {
    const left = room(PRIMARY_MODEL);
    return Math.max(0, Math.min(LIMIT === Infinity ? left : LIMIT - queue.length - regradeQueued, left));
  };
  const queues = [
    ["re-grade", () => regradeQueue(db, { primary: PRIMARY_MODEL, limit: slots() }), `grade(s) not made by ${PRIMARY_MODEL}`],
    ...(RUBRIC_REGRADE
      ? [["rubric re-grade", () => versionRegradeQueue(db, { primary: PRIMARY_MODEL, version: RUBRIC_VERSION, limit: slots() }), `grade(s) from a rubric older than v${RUBRIC_VERSION}`]]
      : []),
  ];
  for (const [name, load, what] of queues) {
    if (!regradeOn()) break;
    const rows = await load();
    regradeQueued += rows.length;
    if (rows.length) console.log(`${name}: ${rows.length} ${what} (room today: ${room(PRIMARY_MODEL)})`);
    let stop = false;
    for (const [i, row] of rows.entries()) {
      if (gemini.activeModel !== PRIMARY_MODEL || room(PRIMARY_MODEL) < 1) {
        deferred += rows.length - i;
        stop = true;
        break;
      }
      if (!(await handle(row, `[${name} ${i + 1}/${rows.length}]`, { regrade: true }))) {
        stop = true;
        break;
      }
    }
    if (stop) break;
  }

  if (stopped) console.log(`  stopped early: ${stopped}`);
  console.log(
    `rubric done: ${ok}/${queue.length} judged, ${regraded}/${regradeQueued} re-graded, ${skipped} skipped, ${gemini.summary()}`
  );
  return { queued: queue.length + regradeQueued, ok: ok + regraded, errors, skipped, deferred, stopped };
}

// ---------------------------------------------------------------------------
// pairwise mode
// ---------------------------------------------------------------------------
const pairSchema = {
  type: "OBJECT",
  properties: {
    winner: {
      type: "STRING",
      enum: ["A", "B", "skip"],
      description: "skip only if the shots are unusable or truly indistinguishable",
    },
    reason: { type: "STRING", description: "one short sentence" },
  },
  required: ["winner", "reason"],
};

async function runPairwise() {
  const res = await db.execute(
    `SELECT p.url, p.name, p.shot_key, p.ai_rubric,
            COALESCE(r.elo, ${BASE_ELO}) AS elo, COALESCE(r.votes, 0) AS votes
     FROM portfolios p LEFT JOIN ratings r ON r.url = p.url
     WHERE p.status = 'live' AND p.shot_key IS NOT NULL AND ${ACTIVE("p")}
       AND NOT ${NOT_PORTFOLIO("p")}`
  );
  let pool = res.rows.map((r) => ({
    url: String(r.url),
    name: String(r.name),
    key: String(r.shot_key),
    elo: Number(r.elo),
    votes: Number(r.votes),
    tier: (() => {
      try {
        return JSON.parse(String(r.ai_rubric || "{}")).tier;
      } catch {
        return undefined;
      }
    })(),
  }));
  // Concentrate on graded tiers; ungraded (NULL tier) sites are excluded.
  pool = pool.filter((p) => p.tier && TIERS.includes(p.tier));
  if (pool.length < 2) {
    console.log(`pairwise[tiers=${TIERS.join("/")}]: pool too small (${pool.length}) — nothing to do`);
    return { queued: 0, ok: 0 };
  }
  const adopted = await prepareAiVotes(db);
  if (adopted) console.log(`moved ${adopted} legacy AI vote(s) to rater ${FLASH_LITE_RATER_ID}`);
  const voted = await db.execute({
    sql: "SELECT pair_key FROM votes WHERE rater_id = ?",
    args: [RATER_ID],
  });
  const seen = new Set(voted.rows.map((r) => String(r.pair_key)));
  // One batched read of objective signals for the (small) tiered pool.
  const sig = await loadSignals(pool.map((p) => p.url));
  console.log(
    `pairwise[tiers=${TIERS.join("/")}]: pool ${pool.length} site(s), ${seen.size} pair(s) already voted by ${RATER_ID}, casting up to ${VOTES} with ${MODELS.join(" > ")}`
  );

  let cast = 0;
  let errors = 0;
  let skipped = 0;
  let abstained = 0;
  let queued = 0;
  let consecutiveErrors = 0;
  let stopped = null;
  for (let round = 0; cast < VOTES && round < VOTES * 5; round++) {
    // Uncertainty-prioritized: sample a handful, face off the two least-voted
    // whose ratings are close (same selection spirit as GET /api/rank).
    const sample = [...pool].sort(() => Math.random() - 0.5).slice(0, 12);
    sample.sort((a, b) => a.votes - b.votes || Math.abs(a.elo - b.elo));
    let a = sample[0];
    let b = sample.slice(1).find((p) => !seen.has(pairKey(a.url, p.url)));
    if (!b) continue;
    // Randomize A/B presentation so position bias can't favor one slot.
    if (Math.random() < 0.5) [a, b] = [b, a];
    queued++;

    const [heroA, heroB] = await Promise.all([
      heroPart(a.key),
      heroPart(b.key),
    ]);
    if (!heroA || !heroB) {
      seen.add(pairKey(a.url, b.url)); // can't judge this pair this run
      skipped++;
      continue;
    }

    try {
      const { result: verdict, model } = await gemini.generate(
        [
          {
            text:
              `You are judging two developer portfolio websites by their hero screenshots, ` +
              `which are the primary evidence. A: "${a.name}". B: "${b.name}".\n\n` +
              `Decide which is the better portfolio OVERALL. Judge substance, not just looks:\n` +
              `- Visual craft (PRIMARY): hierarchy, typography, color, spacing, and clarity of who/what from the hero.\n` +
              `- Then use the objective signals below as evidence of substance:\n` +
              `  * Lighthouse performance/accessibility — a beautiful page that is slow or inaccessible is worse than it looks.\n` +
              `  * Custom domain, working social preview, contact/resume/GitHub links indicate a finished, professional site.\n` +
              `Let the screenshot lead; use metrics to break near-ties and to penalize a polished-looking page with poor ` +
              `performance/accessibility. Do NOT penalize a site for having fewer metrics listed — missing data is unknown, not bad.\n\n` +
              signalLines("A", a.url, sig) +
              "\n" +
              signalLines("B", b.url, sig) +
              "\n\n" +
              `Pick a winner; skip ONLY if a shot is unusable or the two are truly indistinguishable on both looks and signals.`,
          },
          { text: "A:" },
          heroA,
          { text: "B:" },
          heroB,
        ],
        pairSchema
      );
      consecutiveErrors = 0;
      seen.add(pairKey(a.url, b.url));
      if (verdict.winner === "skip") {
        abstained++;
        console.log(`  skip (${model}): ${a.url} vs ${b.url} - ${verdict.reason}`);
        continue;
      }
      const [win, lose] = verdict.winner === "A" ? [a, b] : [b, a];
      await castVote(win, lose, model);
      cast++;
      console.log(`[${cast}/${VOTES}] (${model}) ${win.url} beat ${lose.url} - ${verdict.reason}`);
    } catch (e) {
      if (e instanceof GeminiAuthError) throw e;
      // Never re-draw a failed pair this run — otherwise a poisoned pair recurs
      // every round on a small tiered pool and burns the budget for 0 votes.
      seen.add(pairKey(a.url, b.url));
      if (/UNIQUE constraint failed/i.test(String(e.message))) continue; // dup, not an error
      errors++;
      console.log(`  ERROR ${a.url} vs ${b.url}: ${String(e.message).slice(0, 120)}`);
      if (e instanceof GeminiUnavailableError) {
        // Out of quota, or unavailable through every retry: stop cleanly.
        stopped = e.message;
        break;
      }
      if (++consecutiveErrors >= 5) {
        console.log("  aborting: 5 consecutive errors (likely quota exhausted or outage)");
        break;
      }
    }
  }
  console.log(
    `pairwise done: ${cast} vote(s) cast, ${abstained} abstained, ${skipped} pair(s) skipped, ${gemini.summary()}`
  );
  if (stopped) console.log(`  stopped early: ${stopped}`);
  return { queued, ok: cast, errors, skipped, abstained, stopped };
}

// Mirrors POST /api/rank: insert + ELO upsert in one write transaction, with
// the UNIQUE(rater_id, pair_key) index as the dup backstop. AI votes move
// official ELO — that is the whole point of the bootstrap (GRADING §7).
async function castVote(win, lose, model) {
  const tx = await db.transaction("write");
  try {
    const rres = await tx.execute({
      sql: "SELECT url, elo, votes FROM ratings WHERE url IN (?, ?)",
      args: [win.url, lose.url],
    });
    const map = new Map(
      rres.rows.map((r) => [String(r.url), { elo: Number(r.elo), votes: Number(r.votes) }])
    );
    const w = map.get(win.url) ?? { elo: BASE_ELO, votes: 0 };
    const l = map.get(lose.url) ?? { elo: BASE_ELO, votes: 0 };
    const updated = eloUpdate(w.elo, l.elo);
    await tx.execute({
      sql: "INSERT INTO votes (winner, loser, pair_key, rater_type, rater_id, model, delta) VALUES (?, ?, ?, 'ai', ?, ?, ?)",
      args: [
        win.url,
        lose.url,
        pairKey(win.url, lose.url),
        RATER_ID,
        model,
        updated.winner - w.elo,
      ],
    });
    const upsert = `INSERT INTO ratings (url, elo, votes, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(url) DO UPDATE SET
        elo = excluded.elo, votes = excluded.votes, updated_at = excluded.updated_at`;
    await tx.execute({ sql: upsert, args: [win.url, updated.winner, w.votes + 1] });
    await tx.execute({ sql: upsert, args: [lose.url, updated.loser, l.votes + 1] });
    await tx.commit();
    // keep in-memory pool fresh so later pair picks use updated numbers
    win.elo = updated.winner;
    win.votes = w.votes + 1;
    lose.elo = updated.loser;
    lose.votes = l.votes + 1;
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
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
if (MODE !== "rubric" && MODE !== "pairwise") {
  console.error("usage: node pipeline/judge.mjs rubric|pairwise [flags]");
  process.exit(1);
}
try {
  // Mark rows that left the list, so only roster sites are judged.
  const roster = await syncRoster(db, await loadFeed(ROOT));
  if (roster.delisted || roster.relisted) {
    console.log(`roster: ${roster.delisted} delisted, ${roster.relisted} relisted`);
  }
  const counts = MODE === "rubric" ? await runRubric() : await runPairwise();
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
