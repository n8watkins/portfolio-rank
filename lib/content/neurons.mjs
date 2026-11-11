// The never-pay guard for Workers AI (owner decisions 2026-11-10: every image
// comes from free daily allowances only; docs/COSTS.md, "Workers AI").
//
// The limit, in images first: PortfolioRank makes at most 40 AI images a UTC
// day (MAX_AI_IMAGES_PER_DAY) and at most 2 in any rolling hour (the
// portfoliorank-ai AI Gateway's own rate limit, docs/AI-GATEWAY.md), counted
// per Workers AI call. Behind it, a
// neuron guard: at most 2,500 neurons a UTC day (AI_NEURON_CEILING; 40
// Schnell images are about 2,320). Both settings may be lowered, never raised:
// a value above its maximum, or one that isn't a whole number, is rejected
// and fails closed (the limit becomes 0 and no call is made).
//
// Why so far under the allowance: Workers AI gives the whole Cloudflare
// account 10,000 free neurons a UTC day, shared with every app, and bills
// anything above that on Workers Paid. The account is split into slices
// (PortfolioRank images 5,000, demo-kit 2,000, everything else 1,000, a 2,000
// buffer never used), and PortfolioRank uses at most half of its slice.
// Cloudflare resets the allowance at 00:00 UTC, so the counter's day is the
// UTC date.
//
// Before every Workers AI call, the caller reserves one image and the call's
// estimated neurons here, in one statement that only succeeds while the
// day's images, the hour's images and the day's neurons all stay within their
// limits, so two calls
// running at once can't both take the last room. A failed reservation means:
// skip the call (no retry). A reservation is never given back, even when the
// call fails (a failed call may still have been billed), so the counter can
// only over-count. Plain JavaScript: the Worker, the app and the tests all
// import it.

/** Cloudflare's free allowance for the whole account, a UTC day (developers.cloudflare.com/workers-ai/platform/pricing). */
export const FREE_DAILY_NEURONS = 10000;
/** PortfolioRank's slice of the account's allowance (docs/COSTS.md, "Workers AI"). */
export const PORTFOLIORANK_SLICE = 5000;
/** The primary limit: AI images a UTC day, the default and the most MAX_AI_IMAGES_PER_DAY may say. */
export const MAX_AI_IMAGES_PER_DAY = 40;
/** AI images in any rolling hour: the AI Gateway's sliding limit (2 requests an hour). */
export const MAX_AI_IMAGES_PER_HOUR = 2;
/** The secondary guard: neurons a UTC day, the default and the most AI_NEURON_CEILING may say. */
export const MAX_NEURON_CEILING = 2500;

const tilesOf = (w, h) => Math.ceil(w / 512) * Math.ceil(h / 512);

// Per-model request shapes and neuron estimates, from the Workers AI pricing
// page (Oct 2026). Partial 512x512 tiles are rounded UP, which is never less
// than what Cloudflare bills (its own examples round to fractions of a tile).
// Every model fits the 2,500 ceiling on its own.
export const IMAGE_MODELS = {
  schnell: {
    id: "@cf/black-forest-labs/flux-1-schnell",
    // 1024x1024 (the model's only size), 4 steps: 4 tiles x 4.80 + 4 steps x 9.60.
    width: 1024,
    height: 1024,
    steps: 4,
    neurons: () => tilesOf(1024, 1024) * 4.8 + 4 * 9.6,
  },
  lucid: {
    id: "@cf/leonardo/lucid-origin",
    // 768x432 (16:9, no crop needed), 20 steps: 2 tiles x 636 + 20 steps x 12.
    // 1024x576 would be 4 tiles (2,784), past the 2,500 ceiling.
    width: 768,
    height: 432,
    steps: 20,
    neurons: () => tilesOf(768, 432) * 636 + 20 * 12,
  },
  flux2dev: {
    id: "@cf/black-forest-labs/flux-2-dev",
    // 1024x576 (16:9), 16 steps: 37.50 per output tile per step, 4 tiles x 16
    // x 37.5 = 2,400. Its native 1280x720 is 6 tiles (4,500 at 20 steps),
    // past the 2,500 ceiling.
    width: 1024,
    height: 576,
    steps: 16,
    neurons: () => tilesOf(1024, 576) * 16 * 37.5,
  },
};

/** The estimate for one call of a model key, rounded up to a whole neuron. */
export const neuronsFor = (key) => Math.ceil(IMAGE_MODELS[key].neurons());

/** A whole number from 0 to max, the default when missing, else null (rejected). */
function setting(value, max) {
  const raw = String(value ?? "").trim();
  if (raw === "") return max;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/**
 * The limits from the environment: { maxImages, perHour, ceiling, problem }.
 * Missing settings take their maximum; a rejected one fails closed (both
 * limits 0) and `problem` says why.
 */
export function aiLimits(env = {}) {
  const images = setting(env.MAX_AI_IMAGES_PER_DAY, MAX_AI_IMAGES_PER_DAY);
  const neurons = setting(env.AI_NEURON_CEILING, MAX_NEURON_CEILING);
  const problems = [];
  if (images == null) problems.push(`MAX_AI_IMAGES_PER_DAY "${String(env.MAX_AI_IMAGES_PER_DAY).slice(0, 20)}" is not a whole number from 0 to ${MAX_AI_IMAGES_PER_DAY}`);
  if (neurons == null) problems.push(`AI_NEURON_CEILING "${String(env.AI_NEURON_CEILING).slice(0, 20)}" is not a whole number from 0 to ${MAX_NEURON_CEILING}`);
  if (problems.length) return { maxImages: 0, perHour: 0, ceiling: 0, problem: `${problems.join("; ")}: Workers AI is off until it is fixed` };
  return { maxImages: images, perHour: MAX_AI_IMAGES_PER_HOUR, ceiling: neurons, problem: null };
}

/** The UTC day a moment falls in, as YYYY-MM-DD (Cloudflare's reset is 00:00 UTC). */
export function neuronDay(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

export const NEURON_TABLES = [
  // One row per Workers AI call reserved: when, its UTC day, its estimated neurons and the model.
  `CREATE TABLE IF NOT EXISTS ai_image_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    day TEXT NOT NULL,
    neurons INTEGER NOT NULL,
    model TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS ai_image_calls_day_idx ON ai_image_calls (day)",
  "CREATE INDEX IF NOT EXISTS ai_image_calls_at_idx ON ai_image_calls (at)",
];

const HOUR = 3600000;

/** The day's and the last hour's totals. */
async function totals(db, now) {
  const day = neuronDay(now);
  const r = await db.execute({
    sql: `SELECT (SELECT COUNT(*) FROM ai_image_calls WHERE day = ?) AS images,
                 (SELECT COALESCE(SUM(neurons), 0) FROM ai_image_calls WHERE day = ?) AS neurons,
                 (SELECT COUNT(*) FROM ai_image_calls WHERE at > ?) AS last_hour`,
    args: [day, day, new Date(now.getTime() - HOUR).toISOString()],
  });
  const row = r.rows[0];
  return { day, images: Number(row?.images ?? 0), neurons: Number(row?.neurons ?? 0), lastHour: Number(row?.last_hour ?? 0) };
}

/**
 * Takes one image and `neurons` now if the day's images, the last hour's
 * images and the day's neurons all stay within `limits` ({ maxImages,
 * perHour, ceiling }); returns { ok, day, images, neurons, lastHour }, the
 * totals after the attempt.
 */
export async function reserveImage(db, { neurons, limits, model = null, now = new Date() }) {
  const n = Math.ceil(Number(neurons));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`reserveImage: bad estimate ${neurons}`);
  const at = new Date(now);
  const day = neuronDay(at);
  const maxImages = Number(limits?.maxImages ?? 0);
  const perHour = Number(limits?.perHour ?? 0);
  const ceiling = Number(limits?.ceiling ?? 0);
  // One statement: the row is written only when all three limits hold.
  const r = await db.execute({
    sql: `INSERT INTO ai_image_calls (at, day, neurons, model)
          SELECT ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM ai_image_calls WHERE day = ?) + 1 <= ?
            AND (SELECT COUNT(*) FROM ai_image_calls WHERE at > ?) + 1 <= ?
            AND (SELECT COALESCE(SUM(neurons), 0) FROM ai_image_calls WHERE day = ?) + ? <= ?`,
    args: [at.toISOString(), day, n, model, day, maxImages, new Date(at.getTime() - HOUR).toISOString(), perHour, day, n, ceiling],
  });
  return { ok: r.rowsAffected === 1, ...(await totals(db, at)) };
}

/** Today's AI images ("N of 40"), the last hour's and the neurons, for the admin pages. */
export async function aiUsage(db, { limits, now = new Date() }) {
  const t = await totals(db, new Date(now));
  return {
    day: t.day,
    images: t.images,
    maxImages: limits.maxImages,
    lastHour: t.lastHour,
    perHour: limits.perHour,
    neurons: t.neurons,
    ceiling: limits.ceiling,
    slice: PORTFOLIORANK_SLICE,
    free: FREE_DAILY_NEURONS,
    problem: limits.problem ?? null,
  };
}

/** Deletes call rows older than 90 days (the counters only read today and the last hour). */
export async function pruneCalls(db, { now = new Date() } = {}) {
  await db.execute({ sql: "DELETE FROM ai_image_calls WHERE at < ?", args: [new Date(new Date(now).getTime() - 90 * 86400000).toISOString()] });
}

export class NeuronBudgetError extends Error {}

/**
 * The one way to call a Workers AI image model: reserve first, then call
 * once. Throws NeuronBudgetError (no call made) when there is no room now.
 * `call` gets the model config and does the request.
 */
export async function guardedRun(db, { key, limits, now = new Date(), call }) {
  const neurons = neuronsFor(key);
  const r = await reserveImage(db, { neurons, limits, model: key, now });
  if (!r.ok) {
    throw new NeuronBudgetError(
      `Workers AI: no room now for one more ${key} image (${neurons} neurons): ${r.images} of ${limits?.maxImages ?? 0} images today, ${r.lastHour} of ${limits?.perHour ?? 0} in the last hour, ${r.neurons} of ${limits?.ceiling ?? 0} neurons (UTC ${r.day})${limits?.problem ? `; ${limits.problem}` : ""}; skipped`
    );
  }
  return call(IMAGE_MODELS[key]);
}
