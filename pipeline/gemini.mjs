// Gemini REST client for the AI judge (pipeline/judge.mjs): JSON-mode
// generateContent with pacing, a model fallback chain and retries.
//
// The key always travels in the x-goog-api-key header, never in the URL:
// newer AI Studio keys ("AQ." style) are rejected as a ?key= query parameter,
// and a URL key also leaks into proxy and error logs.
//
// Fallback: each call tries the models in order. A model that is rate limited
// (429), overloaded (5xx) or unreachable (network error, timeout) hands the
// call to the next model. A rejected key (400 API_KEY_INVALID, 401, 403) is
// fatal (GeminiAuthError) and any other error (a bad request, a missing model)
// fails the call; neither falls back, because the next model would fail the
// same way and hide the real problem. When every model is unavailable, the
// whole chain is retried after a growing delay.

// Owner's choice (2026-11-10): 3.5 Flash-Lite first, 3.1 Flash-Lite as backup.
// Stable IDs per https://ai.google.dev/gemini-api/docs/models.
export const PRIMARY_MODEL = "gemini-3.5-flash-lite";
export const BACKUP_MODEL = "gemini-3.1-flash-lite";
export const FLASH_LITE_CHAIN = [PRIMARY_MODEL, BACKUP_MODEL];

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeminiAuthError";
  }
}

const isAuthFailure = (status, body) =>
  status === 401 ||
  status === 403 ||
  (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body));

export function createGemini({
  apiKey,
  models = FLASH_LITE_CHAIN,
  rpm = 8,
  retryDelaysMs = [15000, 30000, 45000],
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = console.log,
} = {}) {
  if (!apiKey) throw new Error("createGemini: apiKey is required");
  if (!models.length) throw new Error("createGemini: at least one model is required");

  const requests = Object.fromEntries(models.map((m) => [m, 0]));
  const answered = Object.fromEntries(models.map((m) => [m, 0]));
  let lastCall = 0;

  // One request to one model. Returns { ok, result } on success or
  // { ok: false, reason } when this model is unavailable and the next one may
  // try; throws when no other model should try.
  async function attempt(model, body) {
    requests[model]++;
    let res;
    try {
      res = await fetchImpl(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, reason: `unreachable (${e?.name || "Error"}: ${String(e?.message ?? e).slice(0, 80)})` };
    }
    if (res.status === 429 || res.status >= 500) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      if (isAuthFailure(res.status, text)) {
        throw new GeminiAuthError(`gemini ${model} rejected the API key: HTTP ${res.status}: ${text}`);
      }
      throw new Error(`gemini ${model} HTTP ${res.status}: ${text}`);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error(`gemini ${model} empty response: ${JSON.stringify(data).slice(0, 300)}`);
    return { ok: true, result: JSON.parse(text) };
  }

  // Returns { result, model } where model is the one that actually answered.
  async function generate(parts, schema) {
    const gap = Math.ceil(60000 / rpm);
    const wait = lastCall + gap - now();
    if (wait > 0) await sleep(wait);
    lastCall = now();

    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    for (let round = 0; ; round++) {
      const reasons = [];
      for (const [i, model] of models.entries()) {
        const out = await attempt(model, body);
        if (out.ok) {
          answered[model]++;
          return { result: out.result, model };
        }
        reasons.push(`${model} ${out.reason}`);
        const next = models[i + 1];
        if (next) log(`  gemini ${model} ${out.reason}, falling back to ${next}`);
      }
      if (round >= retryDelaysMs.length) {
        throw new Error(`gemini unavailable: ${reasons.join("; ")}`);
      }
      const delay = retryDelaysMs[round];
      log(`  gemini unavailable (${reasons.join("; ")}), retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }

  // "12 request(s) [gemini-3.5-flash-lite 12], answered by gemini-3.5-flash-lite 12"
  function summary() {
    const fmt = (counts) =>
      Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([m, n]) => `${m} ${n}`)
        .join(", ") || "none";
    const total = Object.values(requests).reduce((a, b) => a + b, 0);
    return `${total} API request(s) [${fmt(requests)}], answered by ${fmt(answered)}`;
  }

  return { generate, summary, requests, answered };
}
