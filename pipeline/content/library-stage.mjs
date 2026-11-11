// The image library's work (docs/CONTENT-ENGINE.md, "The image library"):
// the Worker's hourly tick (worker/library.ts, the existing "15 * * * *"
// cron) makes up to LIBRARY_PER_HOUR (2) illustrations from the queue of
// themes x subjects (pipeline/content/house-style.mjs), never between 20:00
// and midnight Pacific, so the night's post gets the hour's AI Gateway
// allowance. Each image:
//
//   1. one Workers AI call through the portfoliorank-ai gateway (Flux
//      Schnell; Lucid Origin only if Schnell errors), its image and neurons
//      reserved first against 40 a UTC day, 2 a rolling hour and 2,500
//      neurons a day (lib/content/neurons.mjs); no room, or the gateway's
//      429, means stop until the next tick;
//   2. a center crop to 16:9 and the image stored in R2 under a private
//      prefix;
//   3. one Gemini check of the cropped image (one request, no retry, job
//      "library" within its daily cap): a pass is "pending" for the owner, a
//      fail is "rejected-auto", kept for the owner to see on /admin/images.
//
// A queue item gets one image, ever (no retries): its row is unique. An item
// whose model calls both error has no row and comes up on a later tick.
import crypto from "node:crypto";
import { DEFAULT_RPM, PRIMARY_MODEL, GeminiAuthError, GeminiQuotaError, GeminiRetryBudgetError, createGemini, createLimiter } from "../gemini.mjs";
import { createRequestLog, dailyQuota, ensureGeminiLog } from "../gemini-log.mjs";
import { backgroundAllowance, budgetPlan, usageToday } from "../budget.mjs";
import { insertImage, libraryKey, queuedSubjects } from "../../lib/content/library.mjs";
import { MAX_AI_IMAGES_PER_HOUR, aiLimits, pruneCalls } from "../../lib/content/neurons.mjs";
import { pacificParts } from "../quota-day.mjs";
import { GENERATED, buildCheckRequest, checkPasses, generateIllustration, libraryModel } from "./workers-ai.mjs";

/** LIBRARY_PER_HOUR: a whole number from 0 (off) to 2 (the gateway's hourly limit), else 2. */
export function perHour(value) {
  const raw = String(value ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_AI_IMAGES_PER_HOUR) : MAX_AI_IMAGES_PER_HOUR;
}

/** Pacific hours with no library work: the end-of-day run (20:30) and its post get the gateway's hourly allowance. */
export const QUIET_HOURS = [20, 21, 22, 23];

/** The library settings from the Worker's environment. */
export function libraryConfig(env = {}) {
  return {
    perHour: perHour(env.LIBRARY_PER_HOUR),
    model: libraryModel(env.LIBRARY_MODEL),
    // The AI image limits; a rejected setting fails closed (0) and says why.
    limits: aiLimits(env),
    env: String(env.SITE_ENV ?? "production"),
  };
}

const msg = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * Makes one library image for a queue item. ctx: { db, now, log, library:
 * { ai, model, limits, env, store(key, bytes, contentType) } }. `generate`
 * is one Gemini call: (parts, schema, options) -> { result, model }.
 * Returns { status: "pending" | "rejected-auto" | "skipped" | "budget", id?, notes }.
 * Throws when both model calls error (nothing stored), and rethrows a
 * rejected key, a spent quota or a spent retry budget after storing the image.
 */
export async function makeLibraryImage(ctx, generate, item) {
  const lib = ctx.library;
  const gen = await generateIllustration({ ai: lib.ai, db: ctx.db, limits: lib.limits, prompt: item.prompt, primary: lib.model, now: () => new Date(ctx.now()) });
  if (!gen.ok) {
    if (gen.budget) return { status: "budget", notes: gen.notes };
    throw new Error(`no image: ${gen.notes.join("; ")}`);
  }
  const id = crypto.randomBytes(8).toString("hex");
  const key = await lib.store(libraryKey(lib.env, id), gen.bytes, "image/jpeg");
  let check;
  let pass = false;
  let rethrow = null;
  try {
    const out = await generate(buildCheckRequest({ subject: item.subject, bytes: gen.bytes }));
    if (out.model !== PRIMARY_MODEL) throw new Error(`answered by ${out.model}, not ${PRIMARY_MODEL}`);
    check = { ...out.result, model: out.model };
    pass = checkPasses(out.result);
  } catch (e) {
    // The image is kept for the owner either way; a check that could not run says so.
    check = { error: msg(e) };
    if (e instanceof GeminiAuthError || e instanceof GeminiQuotaError || e instanceof GeminiRetryBudgetError) rethrow = e;
  }
  const status = pass || check.error ? "pending" : "rejected-auto";
  const stored = await insertImage(ctx.db, {
    id,
    theme: item.theme,
    subjectIndex: item.index ?? null,
    subject: item.subject,
    prompt: item.prompt,
    model: gen.model,
    key,
    width: gen.width,
    height: gen.height,
    tags: item.tags,
    alt: item.alt,
    ...GENERATED,
    status,
    check,
    neurons: gen.neurons,
    postId: item.postId ?? null,
    now: ctx.now(),
  });
  if (rethrow) throw rethrow;
  ctx.log?.(`Image library: ${item.theme}#${item.index ?? "post"} ${stored ? status : "already made by another run"} (${gen.model}${gen.notes.length ? `; ${gen.notes.join("; ")}` : ""}${check.note ? `; ${check.note}` : ""})`);
  return { status: stored ? status : "skipped", id, notes: gen.notes };
}

// In the end-of-day run the "Image library" stage is only the Gemini cap for
// job "library" (pipeline/budget.mjs); the work runs on the hourly tick.
export const libraryStage = { parkable: false, off: () => "runs on the hourly tick (worker/library.ts), not in the night" };

/** Why the library does nothing now, or null. */
export function libraryOff(lib, now) {
  if (!lib?.ai) return "no Workers AI binding";
  if (lib.limits?.problem) return lib.limits.problem;
  if (!lib.perHour) return "LIBRARY_PER_HOUR is 0";
  if (!lib.limits?.maxImages || !lib.limits?.ceiling) return "MAX_AI_IMAGES_PER_DAY or AI_NEURON_CEILING is 0";
  if (now != null && QUIET_HOURS.includes(pacificParts(now).hour)) return "quiet hours (20:00 to midnight Pacific): the night's post gets the AI Gateway's hourly allowance";
  return null;
}

/** Images one manual batch may make (the gateway's hourly limit). */
export const MAX_MANUAL = MAX_AI_IMAGES_PER_HOUR;

/**
 * One batch of library images: the hourly tick (up to LIBRARY_PER_HOUR) or
 * the owner's "Make 2 now" (POST /api/admin/library/generate). Same limits
 * either way: the AI image limits (40 a day, 2 an hour, 2,500 neurons), one
 * Gemini check each within the "library" job's daily cap and what people
 * leave (the budget accountant), no retries. Stops at the first failure or
 * when there is no room; the next tick tries again. `ai` is already wrapped
 * by lib/ai-gateway.mjs. Returns { made: [{ id, status }], stopped?, error? }
 * where error is "off" (with stopped saying why) or "no_gemini_budget".
 * @param {{ db: any, env: any, ai: any, store: any, apiKey?: string, runId: string, count?: number, fetchImpl?: typeof fetch, now?: () => number, quiet?: boolean, log?: (line: string) => void }} args
 */
export async function runLibraryBatch({ db, env, ai, store, apiKey, runId, count, fetchImpl = globalThis.fetch, now = () => Date.now(), quiet = true, log = (line) => console.log(JSON.stringify({ event: "library", line })) }) {
  const lib = { ...libraryConfig(env), ai, store };
  const off = libraryOff(lib, quiet ? now() : null);
  if (off) return { made: [], error: "off", stopped: off };
  if (!apiKey) return { made: [], error: "off", stopped: "no GEMINI_API_KEY for the checks" };
  await ensureGeminiLog(db);
  await pruneCalls(db, { now: new Date(now()) });
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const usage = await usageToday(db, { now: new Date(now()), plan });
  const n = Math.min(count ?? lib.perHour, lib.perHour, backgroundAllowance("library", usage, { plan, quota: dailyQuota(env.GEMINI_DAILY_QUOTA) }).allowed);
  if (n < 1) return { made: [], error: "no_gemini_budget" };
  const requestLog = createRequestLog({ db, job: "library", runId });
  const gemini = createGemini({
    apiKey,
    models: [PRIMARY_MODEL],
    limiter: createLimiter({ rpm: Number(env.GEMINI_RPM) || DEFAULT_RPM, now }),
    onRequest: (r) => requestLog.record(r),
    onDailyQuota: "stop",
    retryBudget: 0,
    fetchImpl,
    now,
  });
  const ctx = { db, now, log, library: lib };
  const made = [];
  for (const item of await queuedSubjects(db, { limit: n })) {
    try {
      const r = await makeLibraryImage(ctx, (q) => gemini.generate(q.parts, q.schema, q.options), item);
      if (r.status === "budget") return { made, stopped: `no room for AI images now: ${r.notes.join("; ")}` };
      made.push({ id: r.id, status: r.status });
    } catch (e) {
      return { made, stopped: msg(e) };
    }
  }
  return { made };
}
