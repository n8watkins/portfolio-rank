// The image library's work (docs/CONTENT-ENGINE.md, "The image library"):
// the Worker's hourly tick (worker/library.ts, the existing "15 * * * *"
// cron) makes up to LIBRARY_PER_HOUR (40; the day's 40 is the only real
// limit, and the owner's "Make now" may use what is left of it)
// illustrations from the queue of themes x subjects
// (pipeline/content/house-style.mjs), never between 20:00 and midnight
// Pacific, so the night's post gets its image. Each image:
//
//   1. one Workers AI call through the portfoliorank-ai gateway (Flux
//      Schnell; Lucid Origin only if Schnell errors), its image and neurons
//      reserved first against 40 a UTC day and 2,500
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
import { cleanSubject, customItem, insertImage, libraryKey, queuedSubjects } from "../../lib/content/library.mjs";
import { MAX_AI_IMAGES_PER_HOUR, aiHeadroom, aiLimits, aiUsage, neuronsFor, pruneCalls } from "../../lib/content/neurons.mjs";
import { pacificParts } from "../quota-day.mjs";
import { GENERATED, buildCheckRequest, checkPasses, generateIllustration, libraryModel } from "./workers-ai.mjs";

/**
 * LIBRARY_PER_HOUR: how many images the hourly tick makes, a whole number from
 * 0 (off) to 40 (the day's cap), else 40.
 */
export function perHour(value) {
  const raw = String(value ?? "").trim();
  const n = Number(raw);
  return raw !== "" && Number.isInteger(n) && n >= 0 ? Math.min(n, MAX_AI_IMAGES_PER_HOUR) : MAX_AI_IMAGES_PER_HOUR;
}

/** Images one call of "Make now" may ask for: the day's 40 (the page asks for one a request, so it shows progress). */
export const MAX_MANUAL = MAX_AI_IMAGES_PER_HOUR;

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
    if (gen.budget) return { status: "budget", gateway: Boolean(gen.gateway), notes: gen.notes };
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

/** Why the library does nothing now: { code, text } ("quiet" for the nightly pause, else "off"), or null. */
export function libraryOffReason(lib, now) {
  if (!lib?.ai) return { code: "off", text: "no Workers AI binding" };
  if (lib.limits?.problem) return { code: "off", text: lib.limits.problem };
  if (!lib.perHour) return { code: "off", text: "LIBRARY_PER_HOUR is 0" };
  if (!lib.limits?.maxImages || !lib.limits?.ceiling || !lib.limits?.perHour) return { code: "off", text: "MAX_AI_IMAGES_PER_DAY or AI_NEURON_CEILING is 0" };
  if (now != null && QUIET_HOURS.includes(pacificParts(now).hour)) return { code: "quiet", text: "quiet hours (20:00 to midnight Pacific): the night's post gets the AI Gateway's hourly allowance" };
  return null;
}

/** Why the library does nothing now, or null. */
export function libraryOff(lib, now) {
  return libraryOffReason(lib, now)?.text ?? null;
}


/**
 * One batch of library images: the hourly tick (up to LIBRARY_PER_HOUR) or
 * the owner's "Make now" (POST /api/admin/library/generate), up to what is
 * left of the day's 40, or one image from the owner's own subject (`custom`:
 * { subject, theme? }, cleaned here). Same limits every way: the AI image
 * limits (40 a day, 2,500 neurons), one Gemini check each within
 * the "library" job's daily cap and what people leave (the budget
 * accountant), no retries. Stops at the first failure or when there is no
 * room; the next tick tries again. `ai` is already wrapped by
 * lib/ai-gateway.mjs. Returns { made: [{ id, status }], stopped?, error?,
 * reason?, nextAt?, usage } where error is "off", "bad_subject", "no_room" or
 * "no_gemini_budget", and reason says why nothing more was made: "quiet",
 * "hour" and "day" (with nextAt), "neurons", "gateway" (the AI Gateway's own 429),
 * "no_gemini_budget", "queue_empty", "bad_subject", "off" or "error". usage
 * is the AI image counters after the batch (lib/content/neurons.mjs aiUsage).
 * @param {{ db: any, env: any, ai: any, store: any, apiKey?: string, runId: string, count?: number, custom?: { subject: unknown, theme?: string } | null, fetchImpl?: typeof fetch, now?: () => number, quiet?: boolean, log?: (line: string) => void }} args
 */
export async function runLibraryBatch(args) {
  const lib = { ...libraryConfig(args.env), ai: args.ai, store: args.store };
  const now = args.now ?? (() => Date.now());
  const result = await batchWork({ ...args, now }, lib);
  // Always say where the counters stand now, so the page can show them next to the outcome.
  try {
    result.usage = await aiUsage(args.db, { limits: lib.limits, now: new Date(now()) });
  } catch {}
  return result;
}

/** @param {any} args @param {any} lib */
async function batchWork({ db, env, apiKey, runId, count, custom = null, fetchImpl = globalThis.fetch, now, quiet = true, log = (line) => console.log(JSON.stringify({ event: "library", line })) }, lib) {
  const manual = count != null || custom != null;
  const off = libraryOffReason(lib, quiet ? now() : null);
  if (off) return { made: [], error: "off", reason: off.code, stopped: off.text };
  if (!apiKey) return { made: [], error: "off", reason: "off", stopped: "no GEMINI_API_KEY for the checks" };
  let cleaned = null;
  if (custom) {
    cleaned = cleanSubject(custom.subject);
    if (!cleaned.ok) return { made: [], error: "bad_subject", reason: "bad_subject", stopped: cleaned.error };
  }
  await ensureGeminiLog(db);
  await pruneCalls(db, { now: new Date(now()) });
  const room = await aiHeadroom(db, { limits: lib.limits, neurons: neuronsFor(lib.model), now: new Date(now()) });
  if (room.remaining < 1) return { made: [], error: "no_room", reason: room.blocker, nextAt: room.nextAt, stopped: `no room for AI images now (${room.blocker})` };
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const usage = await usageToday(db, { now: new Date(now()), plan });
  const allowed = backgroundAllowance("library", usage, { plan, quota: dailyQuota(env.GEMINI_DAILY_QUOTA) }).allowed;
  // The tick makes LIBRARY_PER_HOUR; the owner's "Make now" what it asks for, within what is left of the day.
  const n = Math.min(custom ? 1 : (count ?? lib.perHour), manual ? MAX_MANUAL : lib.perHour, allowed, room.remaining);
  if (n < 1) return { made: [], error: "no_gemini_budget", reason: "no_gemini_budget" };
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
  const items = custom ? [customItem({ subject: cleaned.subject, theme: custom.theme })] : await queuedSubjects(db, { limit: n });
  if (!items.length) return { made, reason: "queue_empty", stopped: "every subject has an image or is skipped" };
  for (const item of items) {
    try {
      const r = await makeLibraryImage(ctx, (q) => gemini.generate(q.parts, q.schema, q.options), item);
      if (r.status === "budget") {
        // The gateway's own limit (a 429), else our counters moved under us.
        const after = await aiHeadroom(db, { limits: lib.limits, neurons: neuronsFor(lib.model), now: new Date(now()) });
        const stop = { made, stopped: `no room for AI images now: ${r.notes.join("; ")}` };
        // The refused call is counted too, so the gateway let through one fewer in the last hour.
        if (r.gateway) return { ...stop, reason: "gateway", gatewayLimit: Math.max(0, after.lastHour - 1) };
        return { ...stop, reason: after.blocker ?? "hour", nextAt: after.nextAt };
      }
      made.push({ id: r.id, status: r.status });
    } catch (e) {
      return { made, reason: "error", stopped: msg(e) };
    }
  }
  return { made };
}
