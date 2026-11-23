// The two model clients. Each takes the provider-neutral request from
// common.mjs buildRequest and returns { out (parsed JSON), usage {in, out},
// stop, raw }. Keys come from the environment only (pass-env); they are
// never logged.
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { SCHEMAS } from "./prompts.mjs";
import { GEMINI_MODEL, HAIKU_MODEL } from "./common.mjs";

export class ModelError extends Error {
  constructor(message, { retry = false, status = null, usage = null } = {}) {
    super(message);
    this.retry = retry;
    this.status = status;
    this.usage = usage;
  }
}

const scrub = (s) =>
  String(s ?? "")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]")
    .replace(/\bAQ\.[0-9A-Za-z_.-]{10,}/g, "[key]")
    .replace(/sk-ant-[0-9A-Za-z_-]+/g, "[key]")
    .replace(/\s+/g, " ")
    .slice(0, 300);

// JSON Schema to Gemini's OpenAPI subset.
function toGemini(s) {
  if (s.type === "object") {
    return {
      type: "OBJECT",
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGemini(v)])),
      required: s.required,
      propertyOrdering: Object.keys(s.properties),
    };
  }
  if (s.type === "string") return s.enum ? { type: "STRING", enum: s.enum } : { type: "STRING" };
  if (s.type === "boolean") return { type: "BOOLEAN" };
  throw new Error(`schema type ${s.type}`);
}

export async function askGemini(req) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ModelError("GEMINI_API_KEY is not set");
  const parts = [];
  if (req.image) parts.push({ inline_data: { mime_type: "image/jpeg", data: fs.readFileSync(req.image).toString("base64") } });
  parts.push({ text: req.text });
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: toGemini(SCHEMAS[req.schemaKind]),
      thinkingConfig: { thinkingLevel: "minimal" },
      maxOutputTokens: 2048,
    },
  };
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    throw new ModelError(`gemini network: ${scrub(e.message)}`, { retry: true });
  }
  const raw = await res.text();
  if (!res.ok) {
    const daily = res.status === 429 && /PerDay|per[ _-]?day|daily/i.test(raw);
    throw new ModelError(`gemini HTTP ${res.status}${daily ? " (daily quota)" : ""}: ${scrub(raw)}`, {
      retry: !daily && (res.status === 429 || res.status >= 500),
      status: res.status,
    });
  }
  const data = JSON.parse(raw);
  const um = data.usageMetadata ?? {};
  const usage = { in: um.promptTokenCount ?? 0, out: (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0), thoughts: um.thoughtsTokenCount ?? 0 };
  const cand = data.candidates?.[0];
  const stop = cand?.finishReason ?? (data.promptFeedback?.blockReason ? `BLOCKED:${data.promptFeedback.blockReason}` : null);
  const textOut = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
  if (stop !== "STOP") throw new ModelError(`gemini finished with ${stop}`, { usage });
  let out;
  try {
    out = JSON.parse(textOut);
  } catch {
    throw new ModelError(`gemini answer is not JSON: ${scrub(textOut)}`, { usage });
  }
  return { out, usage, stop, raw: textOut, modelVersion: data.modelVersion ?? null };
}

let anthropic = null;
export async function askHaiku(req) {
  if (!process.env.ANTHROPIC_API_KEY) throw new ModelError("ANTHROPIC_API_KEY is not set");
  anthropic ??= new Anthropic({ maxRetries: 0, timeout: 90_000 });
  const content = [];
  if (req.image) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(req.image).toString("base64") } });
  content.push({ type: "text", text: req.text });
  let msg;
  try {
    msg = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      system: req.system,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMAS[req.schemaKind] } },
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new ModelError(`haiku 429: ${scrub(e.message)}`, { retry: true, status: 429 });
    if (e instanceof Anthropic.InternalServerError) throw new ModelError(`haiku ${e.status}: ${scrub(e.message)}`, { retry: true, status: e.status });
    if (e instanceof Anthropic.APIConnectionError) throw new ModelError(`haiku network: ${scrub(e.message)}`, { retry: true });
    if (e instanceof Anthropic.APIError) throw new ModelError(`haiku ${e.status}: ${scrub(e.message)}`, { status: e.status, retry: e.status === 529 });
    throw e;
  }
  const usage = {
    in: (msg.usage.input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
    out: msg.usage.output_tokens ?? 0,
  };
  if (msg.stop_reason !== "end_turn") throw new ModelError(`haiku stopped with ${msg.stop_reason}`, { usage });
  const textOut = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let out;
  try {
    out = JSON.parse(textOut);
  } catch {
    throw new ModelError(`haiku answer is not JSON: ${scrub(textOut)}`, { usage });
  }
  return { out, usage, stop: msg.stop_reason, raw: textOut, modelVersion: msg.model };
}

export const ASK = { gemini: askGemini, haiku: askHaiku };
