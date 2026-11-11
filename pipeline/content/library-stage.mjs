// The image library's night work (docs/CONTENT-ENGINE.md, "The image
// library"): the end-of-day run's "Image library" stage (pipeline/night.mjs),
// right after Content, makes up to LIBRARY_PER_NIGHT (40) illustrations from
// the queue of themes x subjects (pipeline/content/house-style.mjs), each:
//
//   1. one Workers AI call (Flux Schnell; Lucid Origin only if Schnell
//      errors), one image and its neurons reserved against the day's
//      limits first (40 AI images, 2,500 neurons a UTC day); no
//      room means the stage stops for the night;
//   2. a center crop to 16:9 and the image stored in R2 under a private
//      prefix;
//   3. one Gemini check of the cropped image (one request, no retry): a pass
//      is "pending" for the owner, a fail is "rejected-auto", kept for the
//      owner to see on /admin/images.
//
// A queue item gets one image, ever (no retries): its row is unique. An item
// whose model calls both error has no row and is tried on a later night.
import crypto from "node:crypto";
import { DEFAULT_RPM, PRIMARY_MODEL, GeminiAuthError, GeminiQuotaError, GeminiRetryBudgetError, createGemini, createLimiter } from "../gemini.mjs";
import { createRequestLog, dailyQuota, ensureGeminiLog } from "../gemini-log.mjs";
import { backgroundAllowance, budgetPlan, usageToday } from "../budget.mjs";
import { insertImage, libraryKey, queuedSubjects } from "../../lib/content/library.mjs";
import { aiLimits } from "../../lib/content/neurons.mjs";
import { GENERATED, buildCheckRequest, checkPasses, generateIllustration, libraryModel } from "./workers-ai.mjs";

/** Images a night may make by default (Schnell: about 58 neurons each, so 40 is about 2,300). */
export const DEFAULT_PER_NIGHT = 40;

/** LIBRARY_PER_NIGHT: a whole number from 0 (off) to 100, else the default. */
export function perNight(value) {
  const n = Number(String(value ?? "").trim() || NaN);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 100) : DEFAULT_PER_NIGHT;
}

/** The library settings from the Worker's environment. */
export function libraryConfig(env = {}) {
  return {
    perNight: perNight(env.LIBRARY_PER_NIGHT),
    model: libraryModel(env.LIBRARY_MODEL),
    // The day's AI image limits; a rejected setting fails closed (0) and says why.
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

/** The stage handler for pipeline/night.mjs. */
export const libraryStage = {
  parkable: false,
  off: (ctx) => {
    if (!ctx.library?.ai) return "off: no Workers AI binding";
    if (ctx.library.limits?.problem) return `off: ${ctx.library.limits.problem}`;
    if (!ctx.library.perNight) return "off: LIBRARY_PER_NIGHT is 0";
    if (!ctx.library.limits?.maxImages || !ctx.library.limits?.ceiling) return "off: MAX_AI_IMAGES_PER_DAY or AI_NEURON_CEILING is 0";
    return null;
  },
  count: async (ctx) => Math.min(ctx.library.perNight, (await queuedSubjects(ctx.db, { limit: ctx.library.perNight })).length),
  next: async (ctx, stage, n) => {
    if (stage.budgetOut) return [];
    const left = ctx.library.perNight - (stage.made ?? 0);
    if (left <= 0) return [];
    const tried = new Set(stage.tried);
    const queue = (await queuedSubjects(ctx.db)).filter((s) => !tried.has(`library:${s.theme}#${s.index}`));
    return queue.slice(0, Math.min(n, left)).map((s) => ({ id: `library:${s.theme}#${s.index}`, subject: s }));
  },
  run: async (ctx, gemini, item, stage) => {
    const generate = async (req) => gemini.generate(req.parts, req.schema, req.options);
    const r = await makeLibraryImage(ctx, generate, item.subject);
    if (r.status === "budget") {
      stage.budgetOut = true;
      ctx.log?.(`Image library: stopped for tonight: ${r.notes.join("; ")}`);
      return "skipped";
    }
    stage.made = (stage.made ?? 0) + 1;
    return r.status === "skipped" ? "skipped" : "ok";
  },
};

/** Images one manual batch may make. */
export const MAX_MANUAL = 5;

/**
 * One manual batch (POST /api/admin/library/generate): the night stage's
 * work for at most 5 queue items, with the same limits: the day's AI images and neurons,
 * one Gemini check each within the "library" stage's cap and what people
 * leave (budget accountant), no retries. Stops at the first failure.
 * Returns { made: [{ id, status }], stopped?, error? } where error is
 * "no_gemini_budget" when the accountant allows no check now.
 */
export async function manualBatch({ db, env, ai, store, apiKey, login, count = MAX_MANUAL, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  await ensureGeminiLog(db);
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const usage = await usageToday(db, { now: new Date(now()), plan });
  const n = Math.min(count, MAX_MANUAL, backgroundAllowance("library", usage, { plan, quota: dailyQuota(env.GEMINI_DAILY_QUOTA) }).allowed);
  if (n < 1) return { made: [], error: "no_gemini_budget" };
  const requestLog = createRequestLog({ db, job: "library", runId: `manual:${login}` });
  const gemini = createGemini({
    apiKey,
    models: [PRIMARY_MODEL],
    limiter: createLimiter({ rpm: Number(env.GEMINI_RPM) || DEFAULT_RPM }),
    onRequest: (r) => requestLog.record(r),
    onDailyQuota: "stop",
    retryBudget: 0,
    fetchImpl,
  });
  const ctx = { db, now, log: (line) => console.log(JSON.stringify({ event: "library.manual", line })), library: { ...libraryConfig(env), ai, store } };
  const made = [];
  for (const item of await queuedSubjects(db, { limit: n })) {
    try {
      const r = await makeLibraryImage(ctx, (q) => gemini.generate(q.parts, q.schema, q.options), item);
      if (r.status === "budget") return { made, stopped: `today's AI image limit is reached: ${r.notes.join("; ")}` };
      made.push({ id: r.id, status: r.status });
    } catch (e) {
      return { made, stopped: msg(e) };
    }
  }
  return { made };
}
