#!/usr/bin/env node
// Re-check of non-ranked sites, "recheck-543" (owner spec, 2026-11-13).
// Every site not in tier membership is captured fresh and graded again with
// prompt version "portfolio-definition-v2.1" (experiments/portfolio-definition-
// v2.1: the locked grading-two-sets prompts with only the owner's portfolio
// definition in STEP 3 changed), so the answers still compare with the
// two-set test. Nothing here
// writes a grade, rating, tier or listing: the only production writes are
// the request log (gemini_requests, job "recheck-543") and, at the end, the
// review queue rows (status_reviews), which change nothing until the owner
// confirms them on /admin/review.
//
// Steps:
//   select    read-only: the sites and their group (GROUPS), owner removals
//             left out, plus the text index for the "same text on another
//             domain" rule. -> selection.json, dups.json
//   capture   Playwright, no AI (GitHub Actions, sharded: --shard k/n): a
//             fresh desktop and phone capture with the splash click-through,
//             a mode-picker click, up to 15 s for slow content and one retry.
//             -> bundles/X/<id>/{desktop.jpg, phone.jpg, text.txt, facts.json, meta.json}
//   upload    the two screenshots to R2 as <shot_key>/hero.jpg and
//             mobile.jpg, served by /shots like any capture.
//   plan      the requests: every captured site in batches of 5 (seeded
//             order), plus 100 sites one at a time (20 per group, seeded).
//   gemini    the plan on gemini-3.1-flash-lite: a hard stop at 230 HTTP
//             requests (retries included, across restarts), and never past
//             480 requests on the model's Pacific quota day. --dry-run
//             prints the plan and the budget without a key.
//   haiku     scripts/experiments/recheck-543-haiku.mjs (run by the owner).
//   analyze   scripts/experiments/recheck-543-analyze.mjs.
//
// Data lives in RECHECK_DIR (default ~/research/portfoliorank-experiments/
// recheck-543), out of git; GitHub Actions passes it between jobs as
// workflow artifacts (.github/workflows/regrade-not-portfolio.yml).
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { buildDupIndex } from "../../pipeline/junk-rules.mjs";
import { mulberry32, readJson, shuffled, writeJson } from "./grading-two-sets-lib.mjs";

export const JOB = "recheck-543";
export const SEED = 20261114;
export const BATCH = 5;
export const SOLO_PER_GROUP = 20;
export const DIR = process.env.RECHECK_DIR ?? path.join(os.homedir(), "research", "portfoliorank-experiments", "recheck-543");
export const SET = "X";

// Owner, 2026-11-13: grade with the new portfolio definition, the grading lane's prompt
// version "portfolio-definition-v2.1" (experiments/portfolio-definition-v2.1, logged in
// prompt-log.md), for Gemini 3.1 and Haiku alike. Neither runner sends a request until
// that version is in the prompt log, and every review row records it.
export const PROMPT_VERSION = "portfolio-definition-v2.1";
const PROMPT_LOG = path.join(import.meta.dirname, "..", "..", "experiments", "grading-two-sets", "prompt-log.md");
/** The prompt files of PROMPT_VERSION (solo.txt, batch.txt, schema.json), as the grading lane committed them (bee95fb; only the exclusions decide, a missing sign never makes it "not a portfolio"). */
export const PROMPT_DIR = path.join(import.meta.dirname, "..", "..", "experiments", PROMPT_VERSION);
/** Whether PROMPT_VERSION is on disk and logged in prompt-log.md. */
export const promptReady = () =>
  ["solo.txt", "batch.txt", "schema.json"].every((f) => fs.existsSync(path.join(PROMPT_DIR, f))) && fs.existsSync(PROMPT_LOG) && fs.readFileSync(PROMPT_LOG, "utf8").includes(PROMPT_VERSION);

// The five groups, in the order a site is put in the first that fits.
export const GROUPS = ["not_portfolio", "delisted_graded", "delisted_ungraded", "broken", "live_ungraded"];
export const GROUP_LABELS = {
  not_portfolio: "Graded not a portfolio",
  delisted_graded: "Delisted after grading",
  delisted_ungraded: "Delisted before grading",
  broken: "Broken or dead, never graded",
  live_ungraded: "Live, never graded",
};

/** The R2 key of a site's re-check screenshots: 16 hex characters, so /shots serves it (worker/assets.ts). */
export const shotKeyOf = (url) => crypto.createHash("sha1").update(`${JOB}|${url}`).digest("hex").slice(0, 16);

const GRADED = "(json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.error') IS NULL)";
const HIDDEN = "(COALESCE(p.health, '') = 'down' OR (p.status IN ('dead', 'parked', 'error') AND COALESCE(p.health, '') != 'live'))";
const NOT_PORTFOLIO = "COALESCE(json_valid(p.ai_rubric) AND json_extract(p.ai_rubric, '$.is_portfolio') = 0, 0)";

/** Which group a portfolios row belongs to (null: none of the five). */
export function groupOf(r) {
  const graded = Boolean(r.graded);
  // Graded "not a portfolio" first, delisted or not (off_list still says when it left the list).
  if (graded && r.not_portfolio) return "not_portfolio";
  if (r.delisted_at) return graded ? "delisted_graded" : "delisted_ungraded";
  if (!graded && r.hidden) return "broken";
  if (!graded) return "live_ungraded";
  return null;
}

/** What the site is now: delisted, hidden or listed (shown, not ranked). */
export const currentOf = (r) => (r.delisted_at ? "delisted" : r.hidden ? "hidden" : "listed");

export async function select(db, { excluded = [] } = {}) {
  const rows = (
    await db.execute(
      `SELECT p.url, p.name, p.delisted_at, ${GRADED} AS graded, ${HIDDEN} AS hidden, ${NOT_PORTFOLIO} AS not_portfolio
       FROM portfolios p
       WHERE NOT EXISTS (SELECT 1 FROM tier_ratings t WHERE t.url = p.url AND t.member = 1)
       ORDER BY p.url`
    )
  ).rows;
  let owner = [];
  try {
    owner = (await db.execute("SELECT url FROM portfolio_owner WHERE removed_at IS NOT NULL OR remove_after IS NOT NULL")).rows.map((r) => String(r.url));
  } catch (e) {
    if (!/no such table/i.test(String(e?.message ?? e))) throw e;
  }
  const out = new Set([...owner, ...excluded.filter((e) => e && typeof e === "object" && e.kind === "owner_request").map((e) => e.url)]);
  const sites = [];
  const skipped = { owner_request: 0, other: [] };
  for (const r of rows) {
    const url = String(r.url);
    if (out.has(url)) {
      skipped.owner_request++;
      continue;
    }
    const group = groupOf(r);
    if (!group) {
      skipped.other.push(url);
      continue;
    }
    sites.push({ url, name: r.name == null ? "" : String(r.name), group, current: currentOf(r), off_list: Boolean(r.delisted_at), shot_key: shotKeyOf(url) });
  }
  sites.forEach((s, i) => (s.id = `${SET}${String(i + 1).padStart(3, "0")}`));
  const dup = buildDupIndex((await db.execute("SELECT url, page_text FROM portfolios WHERE page_text IS NOT NULL")).rows.map((r) => ({ url: String(r.url), page_text: String(r.page_text) })));
  return { sites, skipped, dups: Object.fromEntries([...dup].map(([h, hosts]) => [h, [...hosts]])) };
}

// ---------------------------------------------------------------- plan

/** Gradable ids: a full bundle, and a capture that isn't blocked (never grade a gate). */
export function capturedIds(root = path.join(DIR, "bundles")) {
  const dir = path.join(root, SET);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((id) => ["desktop.jpg", "phone.jpg", "text.txt", "facts.json", "meta.json"].every((f) => fs.existsSync(path.join(dir, id, f))))
    .filter((id) => !readJson(path.join(dir, id, "meta.json")).blocked)
    .sort();
}

/**
 * The request plan: all ids in batches of 5 in a seeded order (the last
 * batch filled up with sites from the first batch, their second answer
 * marked as padding and never used), then 20 ids per group one at a time.
 */
export function makePlan(sites, ids, seed = SEED) {
  const rnd = mulberry32(seed);
  const order = shuffled(ids, rnd);
  const batches = [];
  for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
  const last = batches.at(-1);
  const pad = [];
  if (last && last.length < BATCH && batches.length > 1) {
    for (const id of batches[0]) {
      if (last.length >= BATCH) break;
      last.push(id);
      pad.push(id);
    }
  }
  const group = new Map(sites.map((s) => [s.id, s.group]));
  const solo = [];
  for (const g of GROUPS) solo.push(...shuffled(ids.filter((id) => group.get(id) === g), rnd).slice(0, SOLO_PER_GROUP));
  const requests = [
    ...batches.map((b, i) => ({ key: `batch/b${String(i + 1).padStart(3, "0")}`, step: "batch", set: SET, kind: "batch", ids: b, pad: i === batches.length - 1 ? pad : [] })),
    ...shuffled(solo, rnd).map((id) => ({ key: `solo/${id}`, step: "solo", set: SET, kind: "solo", ids: [id] })),
  ];
  return { seed, sites: ids.length, batches: batches.length, solo: solo.length, requests };
}

// ---------------------------------------------------------------- gemini

export const GEMINI31 = {
  model: "gemini-3.1-flash-lite",
  temperature: 0.2,
  thinkingLevel: "low",
  maxOutputTokens: { solo: 8192, batch: 32768 },
  rpm: 8,
  hard_stop: 230,
  retry_delays_ms: [30000, 60000, 120000, 300000],
  max_tries: 5,
  broken_answer_retries: 1,
  day_cap: 480,
  prompt_ids: { solo: "portfolio-definition-v2.1-solo", solo_freetext: "portfolio-definition-v2.1-solo-freetext", batch: "portfolio-definition-v2.1-batch" },
  amendments: [
    "2026-11-13: recheck-543 on gemini-3.1-flash-lite with the two-sets settings",
    "2026-11-13 (owner): prompts portfolio-definition-v2.1 (experiments/portfolio-definition-v2.1, bee95fb): the locked prompts with only STEP 3 replaced; is_portfolio is false only for the exclusions",
  ],
  job: JOB,
};

/** Capture machines for n sites: up to 20, none with fewer than about 10 sites. */
export const shardCount = (n) => Math.max(1, Math.min(20, Math.floor(n / 10)));

/** The job's cap: HTTP requests to Gemini 3.1 for recheck-543 in all, pilot and full run, retries included. */
export const JOB_CAP = 230;
export const PILOT_MAX_HTTP = 6;

/** A pilot plan: the given ids in batches of 5, in the given order (never a partial batch). */
export function pilotPlan(ids) {
  if (!ids.length || ids.length % BATCH) throw new Error(`a pilot needs a multiple of ${BATCH} sites, got ${ids.length}`);
  const requests = [];
  for (let i = 0; i < ids.length; i += BATCH) requests.push({ key: `batch/p${String(i / BATCH + 1).padStart(2, "0")}`, step: "batch", set: SET, kind: "batch", ids: ids.slice(i, i + BATCH), pad: [] });
  return { pilot: true, sites: ids.length, batches: requests.length, solo: 0, requests };
}

/** HTTP requests already logged for this job (pilot and full run together). */
async function jobUsed(db) {
  try {
    return Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM gemini_requests WHERE job = ?", args: [JOB] })).rows[0].n);
  } catch (e) {
    if (/no such table/i.test(String(e?.message ?? e))) return 0;
    throw e;
  }
}

async function gemini({ dryRun, pilot = null }) {
  const { pipelineDb } = await import("../../pipeline/roster.mjs");
  const { dailyTotals } = await import("../../pipeline/gemini-log.mjs");
  const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
  const sel = readJson(path.join(DIR, "selection.json"));
  const folder = pilot ? "gemini31-pilot" : "gemini31";
  const planPath = path.join(DIR, folder, "plan.json");
  let plan;
  if (fs.existsSync(planPath)) plan = readJson(planPath);
  else if (pilot) {
    const ids = pilot.split(",").map((x) => x.trim()).filter(Boolean);
    const gradable = new Set(capturedIds());
    const bad = ids.filter((id) => !gradable.has(id));
    if (bad.length) throw new Error(`not gradable (missing, failed or blocked): ${bad.join(", ")}`);
    plan = pilotPlan(ids);
  } else plan = makePlan(sel.sites, capturedIds());
  if (!fs.existsSync(planPath)) writeJson(planPath, plan);
  const statePath = path.join(DIR, folder, "state.json");
  const state = fs.existsSync(statePath) ? readJson(statePath) : { http_requests: 0, items: {} };
  const left = plan.requests.filter((r) => !state.items[r.key]?.answers).length;
  const used = (await dailyTotals(db)).used.get(GEMINI31.model)?.n ?? 0;
  const job = await jobUsed(db);
  // This run may send what the job has left of its cap (a pilot at most PILOT_MAX_HTTP).
  const budget = Math.max(0, Math.min(JOB_CAP - job, pilot ? PILOT_MAX_HTTP - state.http_requests : Infinity));
  const settings = { ...GEMINI31, hard_stop: state.http_requests + budget };
  console.log(`${pilot ? "PILOT: " : ""}${plan.sites} sites: ${plan.batches} batches of ${BATCH} + ${plan.solo} one at a time = ${plan.requests.length} requests`);
  console.log(`${left} requests left; job ${JOB} has used ${job} of its ${JOB_CAP} HTTP requests; this run may send ${budget}`);
  console.log(`${GEMINI31.model}: ${used} requests this Pacific quota day (cap ${GEMINI31.day_cap})`);
  if (used + Math.min(left, budget) > GEMINI31.day_cap) console.log(`note: the day cap stops the run at ${GEMINI31.day_cap}; run it again after the quota day turns`);
  console.log(`prompt ${PROMPT_VERSION}: ${promptReady() ? "in place" : "NOT in place yet (prompt-log.md doesn't name it)"}`);
  if (dryRun) return 0;
  if (!promptReady()) {
    console.log(`refusing to run: the prompts are not ${PROMPT_VERSION} yet`);
    return 3;
  }
  if (budget <= 0) {
    console.log(`hard stop: no requests left (job cap ${JOB_CAP}${pilot ? `, pilot cap ${PILOT_MAX_HTTP}` : ""})`);
    return 3;
  }
  const { loadPrompts, run } = await import("./grading-two-sets-run.mjs");
  const { exit } = await run({
    db,
    plan,
    prompts: loadPrompts(PROMPT_DIR),
    settings,
    out: path.join(DIR, folder),
    rawDir: path.join(DIR, "raw", folder),
    bundleRoot: path.join(DIR, "bundles"),
    timelinePath: path.join(DIR, "timeline.json"),
  });
  return exit === "done" ? 0 : 3;
}

// ---------------------------------------------------------------- upload

async function upload() {
  if (!process.env.R2_ACCOUNT_ID) throw new Error("upload needs the R2_* variables");
  const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
  const sel = readJson(path.join(DIR, "selection.json"));
  let n = 0;
  for (const s of sel.sites) {
    const dir = path.join(DIR, "bundles", SET, s.id);
    for (const [from, to] of [["desktop.jpg", "hero.jpg"], ["phone.jpg", "mobile.jpg"]]) {
      if (!fs.existsSync(path.join(dir, from))) continue;
      await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET ?? "portfolio-rank", Key: `${s.shot_key}/${to}`, Body: fs.readFileSync(path.join(dir, from)), ContentType: "image/jpeg" }));
      n++;
    }
  }
  console.log(`uploaded ${n} screenshots`);
}

// ---------------------------------------------------------------- main

async function main() {
  const [step, ...args] = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const opt = (f) => (args.indexOf(f) >= 0 ? args[args.indexOf(f) + 1] : null);
  if (step === "select") {
    const { pipelineDb } = await import("../../pipeline/roster.mjs");
    const root = path.join(import.meta.dirname, "..", "..");
    const excluded = fs.existsSync(path.join(root, "data", "excluded.json")) ? readJson(path.join(root, "data", "excluded.json")) : [];
    const { sites, skipped, dups } = await select(pipelineDb(root), { excluded });
    writeJson(path.join(DIR, "selection.json"), { at: new Date().toISOString(), seed: SEED, skipped, sites });
    writeJson(path.join(DIR, "dups.json"), dups);
    const by = Object.fromEntries(GROUPS.map((g) => [g, sites.filter((s) => s.group === g).length]));
    console.log(`${sites.length} sites: ${JSON.stringify(by)}; owner requests left out: ${skipped.owner_request}; in no group: ${skipped.other.length}`);
    for (const u of skipped.other.slice(0, 20)) console.log(`  in no group: ${u}`);
    return 0;
  }
  if (step === "capture") {
    const { captureAll } = await import("./recheck-543-capture.mjs");
    return captureAll({ dir: DIR, set: SET, shard: opt("--shard"), only: opt("--only") });
  }
  if (step === "check") {
    const { checkOne } = await import("./recheck-543-capture.mjs");
    return (await checkOne({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "recheck-check-")) }), 0);
  }
  if (step === "shards") {
    // The capture matrix: up to 20 machines, none with fewer than about 10 sites.
    const sel = readJson(path.join(DIR, "selection.json"));
    const n = opt("--only") ? opt("--only").split(",").filter(Boolean).length : sel.sites.length;
    console.log(JSON.stringify(Array.from({ length: shardCount(n) }, (_, i) => i)));
    return 0;
  }
  if (step === "upload") return (await upload(), 0);
  if (step === "plan") {
    const sel = readJson(path.join(DIR, "selection.json"));
    const plan = makePlan(sel.sites, capturedIds());
    console.log(`${plan.sites} captured: ${plan.batches} batches + ${plan.solo} solo = ${plan.requests.length} requests`);
    return 0;
  }
  if (step === "gemini") return gemini({ dryRun: flag("--dry-run"), pilot: opt("--pilot") });
  if (step === "queue") {
    // The review rows (experiments/recheck-543/queue.json, written by recheck-543-analyze.mjs and
    // committed for the record) into status_reviews. Never updates a row the owner has decided:
    // INSERT OR IGNORE on (batch, url). Changes nothing else; /admin/review applies on Confirm.
    const rows = readJson(path.join(import.meta.dirname, "..", "..", "experiments", "recheck-543", "queue.json"));
    const { pipelineDb } = await import("../../pipeline/roster.mjs");
    const db = pipelineDb(path.join(import.meta.dirname, "..", ".."));
    const has = (await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'status_reviews'")).rows.length;
    if (!has) throw new Error("status_reviews does not exist yet: the review queue PR must be deployed first");
    const cols = ["batch", "url", "grp", "current", "proposed", "agreed", "reason", "off_list", "shot_key", "verdicts", "signals", "status", "created_at"];
    console.log(`${rows.length} rows${flag("--dry-run") ? " (dry run: nothing written)" : ""}`);
    if (flag("--dry-run")) return 0;
    let added = 0;
    for (const r of rows) {
      const res = await db.execute({ sql: `INSERT OR IGNORE INTO status_reviews (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => r[c] ?? null) });
      added += res.rowsAffected;
    }
    console.log(`${added} rows added, ${rows.length - added} already there`);
    return 0;
  }
  if (step === "fetch") {
    // The workflow's artifacts, with the local gh login (no secrets): the selection and bundles of a capture run, the answers of a gemini run.
    const { execFileSync } = await import("child_process");
    const gh = (...a) => execFileSync("gh", ["run", "download", ...a], { stdio: "inherit" });
    const cap = opt("--capture-run");
    const fix = opt("--fix-run");
    const gem = opt("--gemini-run");
    if (!cap && !gem && !fix) throw new Error("fetch needs --capture-run N, --fix-run N and/or --gemini-run N");
    if (cap) {
      gh(cap, "-n", "recheck-selection", "-D", DIR);
      gh(cap, "-p", "recheck-bundles-*", "-D", path.join(DIR, "dl"));
      for (const d of fs.readdirSync(path.join(DIR, "dl"))) fs.cpSync(path.join(DIR, "dl", d), path.join(DIR, "bundles"), { recursive: true });
      fs.rmSync(path.join(DIR, "dl"), { recursive: true, force: true });
    }
    // A recapture replaces those sites' bundles (the whole folder, so no file of the old capture stays).
    if (fix) {
      gh(fix, "-n", "recheck-bundles-fix", "-D", path.join(DIR, "dl-fix"));
      const root = path.join(DIR, "dl-fix", SET);
      for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        fs.rmSync(path.join(DIR, "bundles", SET, id), { recursive: true, force: true });
        fs.cpSync(path.join(root, id), path.join(DIR, "bundles", SET, id), { recursive: true });
      }
      fs.rmSync(path.join(DIR, "dl-fix"), { recursive: true, force: true });
    }
    if (cap || fix) console.log(`${capturedIds().length} gradable bundles in ${path.join(DIR, "bundles")}`);
    if (gem) gh(gem, "-n", "recheck-gemini31", "-D", DIR);
    return 0;
  }
  console.error("usage: recheck-543.mjs <select|check|shards [--only ids]|capture [--shard k/n] [--only ids]|upload|plan|gemini [--dry-run] [--pilot X001,...]|fetch [--capture-run N] [--fix-run N] [--gemini-run N]>");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
