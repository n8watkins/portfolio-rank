// Every Gemini request is labelled with its prompt's id and version
// (gemini_requests.prompt): each request builder sets options.prompt, the
// client reports it for every HTTP request of the call (retries included),
// and the request log stores it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { createGemini } from "../pipeline/gemini.mjs";
import { createRequestLog, ensureGeminiLog } from "../pipeline/gemini-log.mjs";
import { GRADE_PROMPT, RUBRIC_VERSION, buildRubricRequest } from "../pipeline/rubric.mjs";
import { buildBatchRequest, buildPairRequest } from "../pipeline/compare-prompts.mjs";
import { PROMPT_VERSION_BATCHED, PROMPT_VERSION_ONE_ON_ONE } from "../lib/ranking/config.mjs";
import { buildPickRequest, buildReviewRequest as buildPostReviewRequest } from "../pipeline/content/topic.mjs";
import { buildJudgeRequest, buildListRequest } from "../pipeline/content/claims.mjs";
import { readFileSync } from "node:fs";
import { buildFixRequest, buildWriteRequests } from "../pipeline/content/compose.mjs";
import { planPost } from "../pipeline/content/plan.mjs";
import { buildReviewRequest as buildPhotoReviewRequest } from "../pipeline/content/images.mjs";
import { buildCheckRequest } from "../pipeline/content/workers-ai.mjs";
import { buildPollRequest } from "../pipeline/polls.mjs";

const image = { inline_data: { mime_type: "image/jpeg", data: "AAAA" } };
const site = { name: "Ann", pageText: "Hi", image };
const sheet = {
  headline: "Motion is rare",
  angle: "why",
  dataAsOf: "2026-11-12T00:00:00Z",
  facts: [{ id: "n_sites", label: "Sites", display: "10" }],
  charts: [],
  notable: [],
  superlatives: [],
  examples: [],
  names: [],
  screenshots: [],
};
// The writer plans from a real fact sheet (one of the replay fixtures).
const writerSheet = JSON.parse(readFileSync(new URL("./fixtures/content-replay/top-grades-5bcb50a626f8ebde.json", import.meta.url), "utf8"));
const plan = planPost(writerSheet);

// Every builder that makes a Gemini request, with the label it must carry.
const BUILDERS = [
  ["grade", () => buildRubricRequest({ name: "Ann", url: "https://ann.dev", pageText: "Hi", facts: null, image }), GRADE_PROMPT],
  ["compare one-on-one", () => buildPairRequest([site, site]), PROMPT_VERSION_ONE_ON_ONE],
  ["compare batched", () => buildBatchRequest([site, site, site]), PROMPT_VERSION_BATCHED],
  ["content pick", () => buildPickRequest([{ kind: "top-grades", headline: "h", angle: "a" }], {}), "content-pick-v1"],
  ["content final review", () => buildPostReviewRequest(sheet, "# Title"), "content-review-v1"],
  ["content claims list", () => buildListRequest("draft"), "content-claims-list-v1"],
  ["content claims judge", () => buildJudgeRequest([{ sentence: "c", results: [] }]), "content-claims-judge-v1"],
  ["content write", () => buildWriteRequests(writerSheet, plan)[0], "content-write-v2"],
  ["content fix", () => buildFixRequest(writerSheet, plan, { "SECTION 1": "## H\nText." }, ["too short"], []), "content-fix-v1"],
  ["content stock photo review", () => buildPhotoReviewRequest({ slot: "hero", purpose: "p", alt: "a" }, "para", [{ mime: "image/jpeg", base64: "AAAA" }], "stock photos"), "content-photo-review-v1"],
  ["library check", () => buildCheckRequest({ subject: "a laptop", bytes: new Uint8Array([1, 2, 3]) }), "library-check-v1"],
  ["polls", () => buildPollRequest({ digest: {}, asked: [] }), "polls-v1"],
];

test("every request builder labels its prompt with an id and a version", () => {
  assert.equal(GRADE_PROMPT, `grade-v${RUBRIC_VERSION}`);
  const seen = new Set();
  for (const [name, build, label] of BUILDERS) {
    const prompt = build().options?.prompt;
    assert.equal(prompt, label, name);
    assert.match(prompt, /-v\d+$|^legacy-pairwise$/, `${name}: the label ends in its version`);
    assert.ok(!seen.has(prompt), `${name}: labels are unique`);
    seen.add(prompt);
  }
});

test("the label reaches gemini_requests.prompt for every request of a call, retries included", async () => {
  const db = createClient({ url: ":memory:" });
  await ensureGeminiLog(db);
  const log = createRequestLog({ db, job: "grade-new", runId: "t" });
  const answers = [
    new Response("{}", { status: 503 }),
    new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: {} }), { status: 200 }),
  ];
  const sent = [];
  const gemini = createGemini({
    apiKey: "test-key-not-real",
    rpm: 60000,
    retryDelaysMs: [1],
    sleep: async () => {},
    log: () => {},
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return answers.shift();
    },
    onRequest: (r) => log.record(r),
  });
  const req = buildRubricRequest({ name: "Ann", url: "https://ann.dev", pageText: "Hi", facts: null, image });
  await gemini.generate(req.parts, { type: "OBJECT" }, req.options);
  const rows = (await db.execute("SELECT status, prompt FROM gemini_requests ORDER BY id")).rows.map((r) => [Number(r.status), r.prompt]);
  assert.deepEqual(rows, [
    [503, GRADE_PROMPT],
    [200, GRADE_PROMPT],
  ]);
  assert.ok(sent.every((b) => !("prompt" in b) && !("prompt" in b.generationConfig)), "the label never goes to Google");
});

test("an older table gets the prompt column", async () => {
  const db = createClient({ url: ":memory:" });
  await db.execute("CREATE TABLE gemini_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run_id TEXT, job TEXT, model TEXT NOT NULL, status INTEGER, reason TEXT, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, retry INTEGER NOT NULL DEFAULT 0, fallback INTEGER NOT NULL DEFAULT 0)");
  await ensureGeminiLog(db);
  await ensureGeminiLog(db);
  const cols = (await db.execute("PRAGMA table_info(gemini_requests)")).rows.map((r) => String(r.name));
  assert.ok(cols.includes("prompt"));
});
