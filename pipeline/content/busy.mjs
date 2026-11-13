// When Google's AI is busy (owner, 2026-11-12, after a "Write a draft now"
// failed on three 503s in a row): a draft rides out Gemini overload instead
// of failing.
//
//   1. Each request waits longer between tries, with more jitter (about 15,
//      45 and 90 seconds), and after one busy retry on 3.5 Flash-Lite it
//      moves to 3.1 Flash-Lite for the rest of its tries. Both are on the
//      free tier with their own daily quota, so the backup costs nothing
//      and never touches the quota kept for people's grades. A draft still
//      spends at most its request budget, whichever model answers.
//   2. When a request still gets no answer, the draft stops and is tried
//      again later: "Write a draft now" sleeps its Workflow BUSY_WAIT_MINUTES
//      (15, 20, then 30 minutes) between tries and shows "Google's AI is
//      busy, retrying at 3:42 PM" meanwhile (worker/draft.ts,
//      pipeline/content/manual.mjs); the night pauses its content stage the
//      same way (pipeline/night.mjs).
//
// A spent daily quota or a rejected key is not "busy": those still stop.
import { FLASH_LITE_CHAIN, GeminiAuthError, GeminiQuotaError, GeminiUnavailableError, PRIMARY_MODEL } from "../gemini.mjs";

/** The models a draft may use, in order: 3.5 Flash-Lite, then 3.1 Flash-Lite when 3.5 is busy. */
export const CONTENT_MODELS = FLASH_LITE_CHAIN;

/** Minutes to wait before each new try of a whole draft when Google stays busy. */
export const BUSY_WAIT_MINUTES = [15, 20, 30];

/** createGemini options for content: longer, jittered backoff and the move to the backup model. */
export const CONTENT_GEMINI = {
  models: CONTENT_MODELS,
  retryDelaysMs: [15000, 45000, 90000],
  // Spread tries from 0.5x to 1.5x of the delay, so tries don't line up with everyone else's.
  jitter: () => 0.5 + Math.random(),
  fallbackAfter: 1,
  // 3.1 Flash-Lite thinks far longer than 3.5 at the same level and ran out of
  // output tokens on a staging draft (2026-11-12), so it thinks "minimal".
  thinkingFor: (model, level) => (model === PRIMARY_MODEL ? level : "minimal"),
};

/** Retries one draft may make in all (5xx, timeouts, rate limits), across its requests. */
export const CONTENT_RETRY_BUDGET = 12;

/** Whether an error means Google's AI was busy (worth trying later), not a quota, key or bug. */
export function isBusy(e) {
  return e instanceof GeminiUnavailableError && !(e instanceof GeminiQuotaError) && !(e instanceof GeminiAuthError);
}

/** "3:42 PM PT": when the next try starts, in the site's time. */
export function retryClock(at) {
  return `${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })} PT`;
}
