// Gemini REST client for the AI judge (pipeline/judge.mjs): JSON-mode
// generateContent with pacing, retries and a backup model.
//
// The key always travels in the x-goog-api-key header, never in the URL:
// newer AI Studio keys ("AQ." style) are rejected as a ?key= query parameter,
// and a URL key also leaks into proxy and error logs.
//
// Model policy (owner decision 2026-11-10): use 3.5 Flash-Lite for everything
// until its quota is used up; 3.1 Flash-Lite only then.
//   - 503/5xx, timeouts and network errors: retry the SAME model after
//     10s, 30s and 60s (jittered). If the last retry still fails, that one
//     call goes to the backup model, and the answer records which model gave it.
//   - 429 with a per-day quota (RESOURCE_EXHAUSTED on a PerDay quota): the
//     model is spent for the day, so this call and every later call in the
//     run use the backup model (onDailyQuota "fallback", the vote job), or
//     the run stops and waits for tomorrow (onDailyQuota "stop", grading:
//     3.1 grades get re-graded by 3.5 later anyway).
//   - Any other 429 (per-minute limits): slow down and retry the same model,
//     waiting the RetryInfo delay when Google gives one.
//   - A rejected key (400 API_KEY_INVALID, 401, 403) is fatal
//     (GeminiAuthError); any other 4xx fails the call. Neither falls back.
//   - When no model can answer, GeminiUnavailableError (or
//     GeminiQuotaError when every model's daily quota is spent): the judge
//     stops cleanly and the next run picks up where it left off.
// Every HTTP request waits its turn on one shared limiter (createLimiter), so
// retries count against the rate too, and is reported to onRequest for the
// request log (pipeline/gemini-log.mjs), thinking tokens included.
//
// generate(parts, schema, options) takes an optional systemInstruction,
// thinkingLevel, maxOutputTokens and temperature. A model that rejects the
// thinking level (HTTP 400 naming thinking) is asked again once without it,
// and is not sent one again for the rest of the run, so a level one model
// lacks never fails a grade.

// Owner's choice (2026-11-10): 3.5 Flash-Lite first, 3.1 Flash-Lite as backup.
// Stable IDs per https://ai.google.dev/gemini-api/docs/models.
export const PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const BACKUP_MODEL = "gemini-3.1-flash-lite";
export const FLASH_LITE_CHAIN = [PRIMARY_MODEL, BACKUP_MODEL];

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
 * evenly at `rpm` per minute.
 */
export function createLimiter({ rpm = DEFAULT_RPM, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const gap = Math.ceil(60000 / Math.max(rpm, 0.001));
  let next = 0;
  return {
    rpm,
    async take() {
      const t = now();
      const at = Math.max(t, next);
      next = at + gap;
      if (at > t) await sleep(at - t);
    },
  };
}

export function createGemini({
  apiKey,
  models = FLASH_LITE_CHAIN,
  rpm = DEFAULT_RPM,
  limiter,
  retryDelaysMs = [10000, 30000, 60000],
  // Per-minute 429s: how many times to slow down before giving up on a call.
  maxSlowdowns = 5,
  // "fallback": a spent daily quota moves the run to the next model.
  // "stop": it ends the run instead (GeminiQuotaError), for work that would
  // rather wait for tomorrow's quota than be done by the backup.
  onDailyQuota = "fallback",
  slowdownMs = 60000,
  jitter = () => 0.8 + Math.random() * 0.4,
  timeoutMs = 120000,
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
  const counts = { http5xx: 0, http429: 0, network: 0, fallbacks: 0, retries: 0 };
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
    const rec = { at: new Date(started).toISOString(), model, retry, fallback, status: 0, reason: "", latencyMs: 0, inputTokens: null, outputTokens: null, thoughtsTokens: null };
    let res;
    try {
      res = await fetchImpl(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
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
      await report({ ...rec, reason: `HTTP ${res.status}`, latencyMs: now() - started });
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
    await report({ ...rec, reason: "ok", latencyMs: now() - started, ...usage });
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
        counts.retries++;
        continue;
      }
      if (out.kind === "daily") {
        if (onDailyQuota === "stop") {
          throw new GeminiQuotaError(`gemini ${model}: daily quota used up; waiting for tomorrow's quota`);
        }
        if (idx + 1 >= models.length) {
          throw new GeminiQuotaError(`gemini ${model}: daily quota used up and no backup model left`);
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
        log(`  gemini ${model} rate limited, waiting ${Math.round(wait / 1000)}s`);
        counts.retries++;
        await sleep(wait);
        continue;
      }
      // transient: 5xx, timeout, network
      if (transient < retryDelaysMs.length) {
        const wait = Math.round(retryDelaysMs[transient] * jitter());
        transient++;
        counts.retries++;
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
      throw new GeminiUnavailableError(`gemini unavailable: ${model} ${out.reason}`);
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
    /** Move the rest of the run to the next model (a caller's own budget is spent). */
    useNextModel() {
      if (active + 1 >= models.length) return null;
      active++;
      counts.fallbacks++;
      return models[active];
    },
  };
}
