// Preloaded with `node --import` by tests that run pipeline scripts as a
// child process: replaces fetch so no request leaves the machine. Gemini
// answers from MOCK_GEMINI (a JSON array of steps, consumed in order; the last
// one repeats), screenshots from MOCK_SHOTS ("ok", "missing" or "error").
// Every Gemini request is appended to MOCK_LOG (one JSON line each) so the
// test can see what was sent.
import fs from "node:fs";

const steps = JSON.parse(process.env.MOCK_GEMINI ?? '[{"status":200,"json":{}}]');
let i = 0;
const shots = process.env.MOCK_SHOTS ?? "ok";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input);
  if (url.includes("generativelanguage.googleapis.com")) {
    const step = steps[Math.min(i++, steps.length - 1)];
    if (process.env.MOCK_LOG) {
      const model = url.match(/models\/([^:]+):/)?.[1];
      fs.appendFileSync(
        process.env.MOCK_LOG,
        `${JSON.stringify({ model, hasKeyHeader: Boolean(init.headers?.["x-goog-api-key"]) })}\n`
      );
    }
    if (step.throw) throw new Error(step.throw);
    const body =
      step.raw ??
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(step.json ?? {}) }] } }],
        usageMetadata: step.usage ?? { promptTokenCount: 1000, candidatesTokenCount: 50 },
      });
    return new Response(body, { status: step.status ?? 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://shots.test/")) {
    if (shots === "missing") return new Response("", { status: 404 });
    if (shots === "error") return new Response("", { status: 503 });
    return new Response(JPEG, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  throw new Error(`mock-fetch: unexpected request to ${url}`);
};
