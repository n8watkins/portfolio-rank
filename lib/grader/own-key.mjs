// Grading on the visitor's own Gemini key (owner decision 2026-11-10, "Free
// tier everywhere": a bring-your-own-key option).
//
// The key lives in the visitor's browser. It reaches the Worker only in the
// JSON body of the one request that uses it (never a URL, never a header,
// since Workers Logs records request headers), is used for that request
// alone, and is never stored, logged or sent anywhere but Google's API in
// the x-goog-api-key header. The grade is the same: gemini-3.5-flash-lite
// only, the same rubric (pipeline/rubric.mjs), marked own_key on the grade.
// Its requests are not written to gemini_requests: they spend the visitor's
// quota, not PortfolioRank's, so the budget accountant must not count them.
import { GeminiAuthError, GeminiIncompleteError, GeminiQuotaError, GeminiUnavailableError, PRIMARY_MODEL, createGemini, createLimiter } from "../../pipeline/gemini.mjs";
import { RESPONSE_SCHEMA, buildRubricRequest, gradeRecord, parseRubricResponse } from "../../pipeline/rubric.mjs";

/** AI Studio keys: the classic "AIza..." form and the newer "AQ." form. */
export const OWN_KEY = /^(AIza[0-9A-Za-z_-]{30,}|AQ\.[0-9A-Za-z_.-]{20,300})$/;

export const validOwnKey = (k) => typeof k === "string" && OWN_KEY.test(k.trim());

/**
 * A free check that the key works for 3.5 Flash-Lite: the model's metadata
 * (models.get), which uses no generate quota. Returns "ok", "rejected" or
 * "unknown" (Google didn't answer clearly; the grade will tell).
 *
 * @param {string} key
 * @param {{ fetchImpl?: typeof fetch, apiBase?: string }} [options]
 */
export async function checkOwnKey(key, { fetchImpl = fetch, apiBase = "https://generativelanguage.googleapis.com/v1beta" } = {}) {
  try {
    const res = await fetchImpl(`${apiBase}/models/${PRIMARY_MODEL}`, { headers: { "x-goog-api-key": key.trim() }, signal: AbortSignal.timeout(8000) });
    try {
      await res.body?.cancel?.();
    } catch {
      /* nothing to drain */
    }
    if (res.ok) return "ok";
    if ([400, 401, 403, 404].includes(res.status)) return "rejected";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Grades a captured job on the visitor's key. Returns { ok: true, grade } or
 * { ok: false, error } where error is "own_key_rejected", "own_key_quota",
 * "gemini_busy" or "grade_failed". Never throws, never includes the key or
 * Google's error text in what it returns.
 *
 * @param {{ key: string, job: any, image: unknown, fetchImpl?: typeof fetch, apiBase?: string, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<{ ok: true, grade: any, error?: undefined } | { ok: false, error: "own_key_rejected" | "own_key_quota" | "gemini_busy" | "grade_failed", grade?: undefined }>}
 */
export async function gradeOnOwnKey({ key, job, image, fetchImpl = fetch, apiBase, now = () => Date.now(), sleep }) {
  const motion = job.meta?.motion;
  const facts = job.facts && job.facts.motion == null && typeof motion === "boolean" ? { ...job.facts, motion } : job.facts;
  const request = buildRubricRequest({ name: hostOf(job.url), url: String(job.final_url ?? job.url), pageText: String(job.page_text ?? ""), facts, image, now: new Date(now()) });
  const gemini = createGemini({
    apiKey: key.trim(),
    models: [PRIMARY_MODEL],
    // The visitor waits on this request: short retries, no request log.
    limiter: createLimiter({ rpm: 60, now, ...(sleep ? { sleep } : {}) }),
    retryDelaysMs: [2000, 8000],
    maxSlowdowns: 1,
    slowdownMs: 5000,
    onDailyQuota: "stop",
    retryBudget: 4,
    timeoutMs: 60000,
    fetchImpl,
    now,
    ...(sleep ? { sleep } : {}),
    ...(apiBase ? { apiBase } : {}),
    log: () => {},
  });
  try {
    const { result, model, usage } = await gemini.generate(request.parts, RESPONSE_SCHEMA, request.options);
    if (model !== PRIMARY_MODEL) return { ok: false, error: "grade_failed" };
    const grade = gradeRecord({ parsed: parseRubricResponse(result), model, usage, facts, source: "own-key", now: new Date(now()) });
    return { ok: true, grade: { ...grade, own_key: true } };
  } catch (e) {
    if (e instanceof GeminiAuthError) return { ok: false, error: "own_key_rejected" };
    if (e instanceof GeminiQuotaError) return { ok: false, error: "own_key_quota" };
    if (e instanceof GeminiUnavailableError) return { ok: false, error: "gemini_busy" };
    if (e instanceof GeminiIncompleteError) return { ok: false, error: "grade_failed" };
    return { ok: false, error: "grade_failed" };
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
}
