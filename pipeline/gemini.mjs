// Gemini REST client for the AI judge (pipeline/judge.mjs): JSON-mode
// generateContent with pacing and retries.
//
// The key always travels in the x-goog-api-key header, never in the URL:
// newer AI Studio keys ("AQ." style) are rejected as a ?key= query parameter,
// and a URL key also leaks into proxy and error logs.
//
// Model policy (owner decision 2026-11-10, revised the same day): grades and
// ranking comparisons are made by 3.5 Flash-Lite only, never by a lower
// model. The default model list is [PRIMARY_MODEL] alone:
//   - 503/5xx, timeouts and network errors: retry the SAME model after
//     10s, 30s and 60s (jittered). If the last retry still fails, the call
//     fails (GeminiUnavailableError) and the item waits for the next run.
//   - 429 with a per-day quota (RESOURCE_EXHAUSTED on a PerDay quota): the
//     model is spent for the day (GeminiQuotaError); the run stops and the
//     rest waits for tomorrow's quota.
//   - Any other 429 (per-minute limits): slow down and retry the same model,
//     waiting the RetryInfo delay when Google gives one.
//   - A rejected key (400 API_KEY_INVALID, 401, 403) is fatal
//     (GeminiAuthError); any other 4xx fails the call.
//   - A 200 whose candidate did not finish with STOP (MAX_TOKENS, SAFETY,
//     RECITATION, a blocked prompt, ...) is a failed answer
//     (GeminiIncompleteError): possibly truncated JSON, so it is never
//     stored as a grade or a comparison, and it is not retried (the same
//     request would be cut again; raise the cap instead).
// Every request's finishReason, and the first 300 characters of every
// error body (429s say which limit was hit), go to the request log.
// The backup path is kept for labelled experiments only (the 3.1-vs-3.5
// comparison, non-ranking analysis): a caller passes models:
// FLASH_LITE_CHAIN, which the judge does only with GEMINI_FALLBACK=on
// (fallbackEnabled below; every workflow pins it "off"). With a chain, a
// call that still fails after the retries goes once to the next model, and
// a spent daily quota moves the rest of the run to it (onDailyQuota
// "fallback") or stops it ("stop").
// Every HTTP request waits its turn on one shared limiter (createLimiter), so
// retries count against the rate too, and is reported to onRequest for the
// request log (pipeline/gemini-log.mjs), thinking tokens included.
// retryBudget caps the retries of one client in total (the end-of-day run
// allows 20 a night, pipeline/budget.mjs); past it a call fails with
// GeminiRetryBudgetError instead of retrying.
//
// generate(parts, schema, options) takes an optional systemInstruction,
// thinkingLevel, maxOutputTokens and temperature. A model that rejects the
// thinking level (HTTP 400 naming thinking) is asked again once without it,
// and is not sent one again for the rest of the run, so a level one model
// lacks never fails a grade.

// Stable IDs per https://ai.google.dev/gemini-api/docs/models.
// PRIMARY_MODEL makes every grade and every AI vote. BACKUP_MODEL is for
// labelled experiments only and never writes grades or ratings in production.
export const PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const BACKUP_MODEL = "gemini-3.1-flash-lite";
export const FLASH_LITE_CHAIN = [PRIMARY_MODEL, BACKUP_MODEL];

/**
 * GEMINI_FALLBACK: "off" (default) or "on". Off, the judge uses 3.5 alone and
 * an item 3.5 can't answer waits for the next run. On (experiments only),
 * it uses FLASH_LITE_CHAIN with its per-call fallback to 3.1.
 */
export const fallbackEnabled = (env = process.env) =>
  /^(on|true|1|yes)$/i.test(String(env.GEMINI_FALLBACK ?? "off").trim());

/** The models a judge run uses when --model doesn't name one. */
export const judgeModels = (env = process.env) => (fallbackEnabled(env) ? FLASH_LITE_CHAIN : [PRIMARY_MODEL]);

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_RPM = 8;

export class GeminiAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiAuthError";
  }
}
export class GeminiUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}
/**
 * The model answered (HTTP 200) but its answer did not finish with STOP:
 * cut off at maxOutputTokens (thinking included), blocked for safety, and
 * so on. `finishReason` says which. Callers treat it as a failed item.
 */
export class GeminiIncompleteError extends Error {
  constructor(message, finishReason) {
    super(message);
    this.name = "GeminiIncompleteError";
    this.finishReason = finishReason;
  }
}

/** The first `max` characters of an error body, one line, with anything key-like removed. */
export function errorDetail(body, { apiKey = "", max = 300 } = {}) {
  let t = String(body ?? "");
  if (apiKey) t = t.split(apiKey).join("[key]");
  t = t
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]")
    .replace(/\bAQ\.[0-9A-Za-z_.-]{10,}/g, "[key]")
    .replace(/([?&](?:key|access_token)=)[^&\s"']+/gi, "$1[key]")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, max);
}

/** The finishReason of a generateContent answer: the candidate's, or BLOCKED:<reason> for a blocked prompt; null when absent. */
export function finishReasonOf(data) {
  const c = data?.candidates?.[0];
  if (c?.finishReason) return String(c.finishReason);
  const blocked = data?.promptFeedback?.blockReason;
  if (blocked) return `BLOCKED:${blocked}`;
  return null;
}

export class GeminiQuotaError extends GeminiUnavailableError {
  constructor(message) {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

const isAuthFailure = (status, body) =>
  status === 401 ||
  status === 403 ||
  (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body));

/** A 429 body that says a per-day quota is spent (vs a per-minute limit). */
export function isDailyQuota(body) {
  return /PerDay|per[ _-]?day|daily/i.test(String(body ?? ""));
}

/** RetryInfo delay from a 429 body ("retryDelay": "43s"), in ms, or null. */
export function retryDelayFrom(body) {
  const m = String(body ?? "").match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

/**
 * One limiter per run, shared by every Gemini call: requests are spaced
 * evenly at `rpm` per minute. `lastAt` (ms) continues the pace of an earlier
 * limiter, so a run split into batches (pipeline/night.mjs) keeps one even
 * pace; `last` is when the latest request was let through.
 */
export function createLimiter({ rpm = DEFAULT_RPM, lastAt = null, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(60000 / Math.max(rpm, 0.001));
  let next = lastAt == null ? 0 : lastAt + gap;
  let last = lastAt;
  return {
    rpm,
    gap,
    get last() {
      return last;
    },
    /** When the next request may go out (ms). */
    get nextAt() {
      return Math.max(now(), next);
    },
    async take() {
      const t = now();
      const at = Math.max(t, next);
      next = at + gap;
      last = at;
      if (at > t) await sleep(at - t);
    },
  };
}

/** Thrown when a run has used its whole retry budget (createGemini retryBudget). */
export class GeminiRetryBudgetError extends GeminiUnavailableError {
  constructor(message) {
    super(message);
    this.name = "GeminiRetryBudgetError";
  }
}

export function createGemini({
  apiKey,
  // 3.5 alone unless a caller (an experiment) passes the chain.
  models = [PRIMARY_MODEL],
  rpm = DEFAULT_RPM,
  limiter,
  retryDelaysMs = [10000, 30000, 60000],
  // Per-minute 429s: how many times to slow down before giving up on a call.
  maxSlowdowns = 5,
  // With a chain only: "fallback" moves the run to the next model when a
  // daily quota is spent, "stop" ends it instead (GeminiQuotaError). With
  // one model a spent quota always ends the run.
  onDailyQuota = "fallback",
  slowdownMs = 60000,
  // Retries this client may make in total (5xx, timeouts, rate limits); once
  // spent, a call that would retry fails with GeminiRetryBudgetError.
  retryBudget = Infinity,
  jitter = () => 0.8 + Math.random() * 0.4,
  timeoutMs = 120000,
  // Google's API; a local stand-in in tests.
  apiBase = GEMINI_API_BASE,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
  onRequest = () => {},
} = {}) {
  if (!apiKey) throw new Error("createGemini: apiKey is required");
  if (!models.length) throw new Error("createGemini: at least one model is required");
  const pace = limiter ?? createLimiter({ rpm, now, sleep });

  const requests = Object.fromEntries(models.map((m) => [m, 0]));
  const answered = Object.fromEntries(models.map((m) => [m, 0]));
  const counts = { http5xx: 0, http429: 0, network: 0, fallbacks: 0, retries: 0, incomplete: 0 };
  // Index of the model in use; moves forward for good when a model's daily
  // quota is spent.
  let active = 0;

  async function report(rec) {
    try {
      await onRequest(rec);
    } catch {
      /* the request log must never break a run */
    }
  }

  // One HTTP request. Returns { kind: "ok", result } | { kind: "transient" |
  // "daily" | "slow", reason, body }; throws for auth and other 4xx errors.
  async function attempt(model, body, { retry, fallback, thinking = false }) {
    await pace.take();
    requests[model]++;
    const started = now();
    const rec = { at: new Date(started).toISOString(), model, retry, fallback, status: 0, reason: "", latencyMs: 0, inputTokens: null, outputTokens: null, thoughtsTokens: null, finishReason: null, detail: null };
    let res;
    try {
      res = await fetchImpl(`${apiBase}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      counts.network++;
      const reason = `unreachable (${e?.name || "Error"}: ${String(e?.message ?? e).slice(0, 80)})`;
      await report({ ...rec, reason, latencyMs: now() - started });
      return { kind: "transient", reason };
    }
    rec.status = res.status;
    if (res.status === 429 || res.status >= 500) {
      const text = (await res.text().catch(() => "")).slice(0, 2000);
      rec.latencyMs = now() - started;
      rec.detail = errorDetail(text, { apiKey });
      if (res.status >= 500) {
        counts.http5xx++;
        await report({ ...rec, reason: `HTTP ${res.status}` });
        return { kind: "transient", reason: `HTTP ${res.status}` };
      }
      counts.http429++;
      const daily = isDailyQuota(text);
      const reason = daily ? "HTTP 429 daily quota" : "HTTP 429 rate limit";
      await report({ ...rec, reason });
      return { kind: daily ? "daily" : "slow", reason, body: text };
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      await report({ ...rec, reason: `HTTP ${res.status}`, latencyMs: now() - started, detail: errorDetail(text, { apiKey }) });
      if (thinking && res.status === 400 && /thinking/i.test(text)) {
        return { kind: "thinking", reason: `HTTP 400 thinking config: ${text.slice(0, 120)}` };
      }
      if (isAuthFailure(res.status, text)) {
        throw new GeminiAuthError(`gemini ${model} rejected the API key: HTTP ${res.status}: ${text}`);
      }
      throw new Error(`gemini ${model} HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const meta = data.usageMetadata ?? {};
    const usage = {
      inputTokens: meta.promptTokenCount ?? null,
      outputTokens: meta.candidatesTokenCount ?? null,
      thoughtsTokens: meta.thoughtsTokenCount ?? null,
    };
    const finishReason = finishReasonOf(data);
    // No finishReason at all (not seen from the API) is judged by the JSON below.
    const complete = finishReason == null || finishReason === "STOP";
    await report({ ...rec, reason: complete ? "ok" : `incomplete: ${finishReason}`, latencyMs: now() - started, finishReason, ...usage });
    if (!complete) {
      counts.incomplete++;
      throw new GeminiIncompleteError(
        `gemini ${model} answer did not finish (${finishReason}; ${usage.outputTokens ?? "?"} output and ${usage.thoughtsTokens ?? "?"} thinking tokens)`,
        finishReason
      );
    }
    // Thought summaries (if a model sends them) come first; the answer is the
    // last non-thought text part.
    const parts = (data.candidates?.[0]?.content?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought);
    const text = parts.at(-1)?.text;
    if (!text) throw new Error(`gemini ${model} empty response: ${JSON.stringify(data).slice(0, 300)}`);
    return { kind: "ok", result: JSON.parse(text), usage };
  }

  // Models that rejected a thinking level this run; they get none.
  const noThinking = new Set();
  function bodyFor(model, parts, schema, { systemInstruction, thinkingLevel, maxOutputTokens, temperature = 0.2 }) {
    const generationConfig = { temperature, responseMimeType: "application/json", responseSchema: schema };
    if (maxOutputTokens) generationConfig.maxOutputTokens = maxOutputTokens;
    const thinking = Boolean(thinkingLevel) && !noThinking.has(model);
    if (thinking) generationConfig.thinkingConfig = { thinkingLevel };
    return {
      thinking,
      body: JSON.stringify({
        ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents: [{ role: "user", parts }],
        generationConfig,
      }),
    };
  }

  // Returns { result, model, fallback, usage } where model is the one that
  // answered and usage its { inputTokens, outputTokens, thoughtsTokens }.
  async function generate(parts, schema, options = {}) {

    let transient = 0;
    let slowdowns = 0;
    let idx = active;
    let oneOff = false; // this call alone moved to the backup after retries
    const spendRetry = (model, reason) => {
      if (counts.retries >= retryBudget) {
        throw new GeminiRetryBudgetError(`gemini ${model} ${reason}: this run's retry budget (${retryBudget}) is used up`);
      }
      counts.retries++;
    };
    for (let n = 0; ; n++) {
      const model = models[idx];
      const { body, thinking } = bodyFor(model, parts, schema, options);
      const out = await attempt(model, body, { retry: n > 0, fallback: idx > 0, thinking });
      if (out.kind === "ok") {
        answered[model]++;
        return { result: out.result, model, fallback: idx > 0, usage: out.usage };
      }
      if (out.kind === "thinking") {
        log(`  gemini ${model} does not take thinking level ${options.thinkingLevel}; asking again without it`);
        noThinking.add(model);
        spendRetry(model, out.reason);
        continue;
      }
      if (out.kind === "daily") {
        if (onDailyQuota === "stop") {
          throw new GeminiQuotaError(`gemini ${model}: daily quota used up; waiting for tomorrow's quota`);
        }
        if (idx + 1 >= models.length) {
          throw new GeminiQuotaError(
            models.length > 1
              ? `gemini ${model}: daily quota used up and no backup model left`
              : `gemini ${model}: daily quota used up; waiting for tomorrow's quota`
          );
        }
        log(`  gemini ${model} daily quota used up; using ${models[idx + 1]} for the rest of this run`);
        counts.fallbacks++;
        idx++;
        active = Math.max(active, idx);
        transient = 0;
        slowdowns = 0;
        continue;
      }
      if (out.kind === "slow") {
        if (++slowdowns > maxSlowdowns) {
          throw new GeminiUnavailableError(`gemini ${model}: still rate limited after ${maxSlowdowns} slowdowns`);
        }
        const wait = retryDelayFrom(out.body) ?? slowdownMs;
        spendRetry(model, out.reason);
        log(`  gemini ${model} rate limited, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      // transient: 5xx, timeout, network
      if (transient < retryDelaysMs.length) {
        const wait = Math.round(retryDelaysMs[transient] * jitter());
        spendRetry(model, out.reason);
        transient++;
        log(`  gemini ${model} ${out.reason}, retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!oneOff && idx + 1 < models.length) {
        log(`  gemini ${model} ${out.reason} after ${retryDelaysMs.length} retries; this call goes to ${models[idx + 1]}`);
        counts.fallbacks++;
        oneOff = true;
        idx++;
        transient = retryDelaysMs.length; // one attempt on the backup, no further retries
        continue;
      }
      throw new GeminiUnavailableError(`gemini unavailable: ${model} ${out.reason} after ${retryDelaysMs.length} retries`);
    }
  }

  // "12 request(s) [gemini-3.5-flash-lite 12], answered by gemini-3.5-flash-lite 12"
  function summary() {
    const fmt = (c) =>
      Object.entries(c)
        .filter(([, n]) => n > 0)
        .map(([m, n]) => `${m} ${n}`)
        .join(", ") || "none";
    const total = Object.values(requests).reduce((a, b) => a + b, 0);
    return `${total} API request(s) [${fmt(requests)}], answered by ${fmt(answered)}`;
  }

  return {
    generate,
    summary,
    requests,
    answered,
    counts,
    get activeModel() {
      return models[active];
    },
  };
}
