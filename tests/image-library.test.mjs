// The blog image library without a server (docs/CONTENT-ENGINE.md, "The
// image library"): the never-pay guard (40 AI images and 2,500 neurons a UTC day, the
// UTC day rollover, concurrent reservations), the model estimates, the 16:9
// crop, the no-retry Gemini call, library matching and approval gating, the
// owner's decisions, the night stage (one image per queue item, the budget
// stop, check results), the Pexels counter and the house style's queue.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jpeg from "jpeg-js";
import { createClient } from "@libsql/client";
import { migrate } from "../lib/schema.mjs";
import { MAX_AI_IMAGES_PER_DAY, MAX_AI_IMAGES_PER_HOUR, MAX_NEURON_CEILING, PORTFOLIORANK_SLICE, aiLimits, aiUsage, guardedRun, NeuronBudgetError, neuronDay, neuronsFor, reserveImage } from "../lib/content/neurons.mjs";
import { altFor, associations, cleanAlt, cleanSubject, cleanTags, decide, editImage, editQueueItem, getImage, insertImage, librarySummary, listImages, matchLibrary, matchScore, queueItems, queuedSubjects, rankLibrary, recordConsidered, recordUse } from "../lib/content/library.mjs";
import { arrivalView, countsText, describeMake, filterImages, idleReason, imageTags, makeChoices, progressText, searchImages, tagCounts, viewCounts, withStatuses } from "../lib/content/library-view.mjs";
import { pexelsCap, reserveSearch, searchUsage } from "../lib/content/pexels-searches.mjs";
import { LIBRARY_SUBJECTS, THEMES, imagePrompt } from "../pipeline/content/house-style.mjs";
import { cropTo16x9, generateIllustration, libraryModel } from "../pipeline/content/workers-ai.mjs";
import { libraryConfig, libraryStage, makeLibraryImage, perHour, runLibraryBatch } from "../pipeline/content/library-stage.mjs";
import { STAGES, budgetPlan } from "../pipeline/budget.mjs";
import { GeminiUnavailableError, PRIMARY_MODEL, createGemini } from "../pipeline/gemini.mjs";

async function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "library-"));
  const url = `file:${path.join(dir, "db.sqlite")}`;
  const db = createClient({ url });
  await migrate(db);
  return { db, url };
}

const jpegOf = (w, h, v = 128) => new Uint8Array(jpeg.encode({ data: Buffer.alloc(w * h * 4, v), width: w, height: h }, 80).data);
const SQUARE_B64 = Buffer.from(jpegOf(1024, 1024)).toString("base64");
const LIMITS = { maxImages: 40, perHour: 2, ceiling: 2500 };
const CHECK_OK = { fits: true, on_style: true, text_artifacts: false, people: false, brand_logo: false, fake_screenshot: false, three_d: false, note: "ok" };

// ---------------------------------------------------------------------------
// The never-pay guard: 40 AI images a UTC day, a rolling hour's cap, 2,500 neurons
// ---------------------------------------------------------------------------
const at = (iso, minutes = 0) => new Date(Date.parse(iso) + minutes * 60000);

test("estimates: Schnell 58, Lucid 1,512 (768x432, 20 steps), Flux 2 Dev 2,400 (1024x576, 16 steps); 40 Schnell images fit 2,500", () => {
  assert.equal(neuronsFor("schnell"), 58);
  assert.equal(neuronsFor("lucid"), 1512);
  assert.equal(neuronsFor("flux2dev"), 2400);
  for (const k of ["schnell", "lucid", "flux2dev"]) assert.ok(neuronsFor(k) <= MAX_NEURON_CEILING);
  assert.equal(MAX_AI_IMAGES_PER_DAY, 40);
  assert.equal(MAX_AI_IMAGES_PER_HOUR, MAX_AI_IMAGES_PER_DAY, "40 a day only: the hour never stops a call first");
  assert.equal(MAX_NEURON_CEILING, 2500);
  assert.ok(MAX_AI_IMAGES_PER_DAY * neuronsFor("schnell") <= MAX_NEURON_CEILING);
  assert.ok(MAX_NEURON_CEILING <= PORTFOLIORANK_SLICE);
});

test("limits: 40 a day (no hourly cap), 2,500 neurons by default; a value above a maximum, or not a whole number, is rejected and fails closed", () => {
  assert.deepEqual(aiLimits({}), { maxImages: 40, perHour: 40, ceiling: 2500, problem: null });
  assert.deepEqual(aiLimits({ MAX_AI_IMAGES_PER_DAY: "10", AI_NEURON_CEILING: "1000" }), { maxImages: 10, perHour: 40, ceiling: 1000, problem: null });
  assert.deepEqual(aiLimits({ MAX_AI_IMAGES_PER_DAY: "0", AI_NEURON_CEILING: "0" }), { maxImages: 0, perHour: 40, ceiling: 0, problem: null });
  for (const bad of ["41", "100", "-1", "abc", "39.5"]) {
    const l = aiLimits({ MAX_AI_IMAGES_PER_DAY: bad });
    assert.deepEqual([l.maxImages, l.perHour, l.ceiling], [0, 0, 0], `${bad} must fail closed`);
    assert.match(l.problem, /MAX_AI_IMAGES_PER_DAY .* not a whole number from 0 to 40/);
  }
  for (const bad of ["2501", "5000", "7000", "x"]) {
    const l = aiLimits({ AI_NEURON_CEILING: bad });
    assert.deepEqual([l.maxImages, l.ceiling], [0, 0], `${bad} must fail closed`);
    assert.match(l.problem, /AI_NEURON_CEILING .* 0 to 2500/);
  }
});

test("guard: at most 2 images in any rolling hour, then more once the hour has passed", async () => {
  const { db } = await freshDb();
  const t0 = "2026-11-11T05:00:00Z";
  assert.equal((await reserveImage(db, { neurons: 58, limits: LIMITS, now: at(t0) })).ok, true);
  assert.equal((await reserveImage(db, { neurons: 58, limits: LIMITS, now: at(t0, 10) })).ok, true);
  assert.equal((await reserveImage(db, { neurons: 58, limits: LIMITS, now: at(t0, 50) })).ok, false, "a third within the hour");
  assert.equal((await reserveImage(db, { neurons: 58, limits: LIMITS, now: at(t0, 61) })).ok, true, "the first left the window");
  const u = await aiUsage(db, { limits: LIMITS, now: at(t0, 61) });
  assert.deepEqual([u.images, u.lastHour, u.perHour], [3, 2, 2]);
});

test("guard: at most 40 images a UTC day, counted per image, even with hourly room", async () => {
  const { db } = await freshDb();
  let ok = 0;
  // Two an hour from 00:00 UTC: 48 tries in 24 hours.
  for (let i = 0; i < 48; i++) if ((await reserveImage(db, { neurons: 58, limits: LIMITS, now: at("2026-11-11T00:00:00Z", i * 30) })).ok) ok++;
  assert.equal(ok, 40);
  const u = await aiUsage(db, { limits: LIMITS, now: at("2026-11-11T23:59:00Z") });
  assert.deepEqual([u.images, u.maxImages, u.neurons, u.ceiling], [40, 40, 2320, 2500]);
});

test("guard: the neuron ceiling stops bigger calls before the image count does; 0 means nothing", async () => {
  const { db } = await freshDb();
  const wide = { maxImages: 40, perHour: 40, ceiling: 2500 };
  const now = at("2026-11-11T05:00:00Z");
  assert.equal((await reserveImage(db, { neurons: 1512, limits: wide, now })).ok, true);
  assert.equal((await reserveImage(db, { neurons: 1512, limits: wide, now })).ok, false, "3,024 would pass 2,500");
  assert.equal((await reserveImage(db, { neurons: 58, limits: wide, now })).ok, true);
  assert.deepEqual(Object.values(await aiUsage(db, { limits: wide, now })).slice(1, 6), [2, 40, 2, 40, 1570]);
  const later = at("2026-11-12T05:00:00Z");
  assert.equal((await reserveImage(db, { neurons: 58, limits: { ...LIMITS, maxImages: 0 }, now: later })).ok, false);
  assert.equal((await reserveImage(db, { neurons: 58, limits: { ...LIMITS, perHour: 0 }, now: later })).ok, false);
  assert.equal((await reserveImage(db, { neurons: 58, limits: { ...LIMITS, ceiling: 0 }, now: later })).ok, false);
  assert.equal((await reserveImage(db, { neurons: 58, limits: aiLimits({ MAX_AI_IMAGES_PER_DAY: "99" }), now: later })).ok, false);
  assert.equal((await aiUsage(db, { limits: LIMITS, now: later })).images, 0);
});

test("guard: the day rolls over at 00:00 UTC, Cloudflare's reset", async () => {
  const { db } = await freshDb();
  assert.equal(neuronDay(at("2026-11-11T23:59:59Z")), "2026-11-11");
  assert.equal(neuronDay(at("2026-11-12T00:00:00Z")), "2026-11-12");
  const one = { maxImages: 1, perHour: 2, ceiling: 2500 };
  assert.equal((await reserveImage(db, { neurons: 58, limits: one, now: at("2026-11-11T23:30:00Z") })).ok, true);
  assert.equal((await reserveImage(db, { neurons: 58, limits: one, now: at("2026-11-11T23:59:59Z") })).ok, false);
  assert.equal((await reserveImage(db, { neurons: 58, limits: one, now: at("2026-11-12T00:00:00Z") })).ok, true);
  assert.equal((await aiUsage(db, { limits: one, now: at("2026-11-11T12:00:00Z") })).images, 1);
  assert.equal((await aiUsage(db, { limits: one, now: at("2026-11-12T12:00:00Z") })).images, 1);
});

test("guard: concurrent reservations from separate connections never pass any limit", async () => {
  const now = at("2026-11-11T05:00:00Z");
  const run = async (limits, neurons, n) => {
    const { db, url } = await freshDb();
    const clients = Array.from({ length: 4 }, () => createClient({ url, timeout: 10000 }));
    const results = await Promise.all(Array.from({ length: n }, (_, i) => reserveImage(clients[i % 4], { neurons, limits, now }).catch(() => ({ ok: false }))));
    return { ok: results.filter((r) => r.ok).length, u: await aiUsage(db, { limits, now }) };
  };
  const hour = await run(LIMITS, 58, 30);
  assert.equal(hour.ok, 2);
  assert.equal(hour.u.lastHour, 2);
  const day = await run({ maxImages: 40, perHour: 1000, ceiling: 2500 }, 58, 100);
  assert.equal(day.ok, 40);
  assert.equal(day.u.images, 40);
  const neurons = await run({ maxImages: 40, perHour: 1000, ceiling: 2500 }, 1512, 20);
  assert.equal(neurons.ok, 1);
  assert.ok(neurons.u.neurons <= 2500);
});

test("guardedRun: no room means the call is never made", async () => {
  const { db } = await freshDb();
  let called = 0;
  await assert.rejects(guardedRun(db, { key: "lucid", limits: { ...LIMITS, ceiling: 1000 }, call: async () => called++ }), NeuronBudgetError);
  await assert.rejects(guardedRun(db, { key: "schnell", limits: { ...LIMITS, maxImages: 0 }, call: async () => called++ }), /0 of 0 images today/);
  assert.equal(called, 0);
  assert.equal(await guardedRun(db, { key: "schnell", limits: LIMITS, call: async (cfg) => (called++, cfg.id) }), "@cf/black-forest-labs/flux-1-schnell");
  assert.equal(called, 1);
});

// ---------------------------------------------------------------------------
// Models, crop, no retries
// ---------------------------------------------------------------------------
test("crop: a 1024 square becomes 1024x576; a 16:9 image is left as it is", () => {
  const c = cropTo16x9(jpegOf(1024, 1024));
  assert.deepEqual([c.width, c.height], [1024, 576]);
  const d = jpeg.decode(c.bytes);
  assert.deepEqual([d.width, d.height], [1024, 576]);
  const same = jpegOf(1024, 576);
  assert.equal(cropTo16x9(same).bytes, same);
});

test("generateIllustration: Schnell once; Lucid once only when Schnell errors; both erroring is a failure, not a retry", async () => {
  const { db } = await freshDb();
  const calls = [];
  const failing = { run: async (model) => (calls.push(model), Promise.reject(new Error("5xx"))) };
  const r = await generateIllustration({ ai: failing, db, limits: LIMITS, prompt: "p" });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, ["@cf/black-forest-labs/flux-1-schnell", "@cf/leonardo/lucid-origin"]);
  // Lucid gets its documented input (768x432, 20 steps).
  const inputs = [];
  const lucidOnly = { run: async (model, input) => (inputs.push([model, input]), model.includes("schnell") ? Promise.reject(new Error("x")) : { image: Buffer.from(jpegOf(768, 432)).toString("base64") }) };
  const ok = await generateIllustration({ ai: lucidOnly, db: (await freshDb()).db, limits: LIMITS, prompt: "p" });
  assert.equal(ok.model, "lucid");
  assert.deepEqual(inputs[1][1], { prompt: "p", width: 768, height: 432, num_steps: 20 });
  // Lucid's 1,512 doesn't fit what a small ceiling leaves, so a Schnell error there makes nothing.
  const { db: db2 } = await freshDb();
  const tight = await generateIllustration({ ai: failing, db: db2, limits: { ...LIMITS, ceiling: 1000 }, prompt: "p" });
  assert.equal(tight.ok, false);
  assert.equal(tight.budget, true);
});

test("an AI Gateway budget stop (429) never falls back to Lucid", async () => {
  const { db } = await freshDb();
  const calls = [];
  const exhausted = Object.assign(new Error("Workers AI budget exhausted (AI Gateway rate limit, 429)"), { name: "AiBudgetExhausted" });
  const ai = { run: async (model) => (calls.push(model), Promise.reject(exhausted)) };
  const r = await generateIllustration({ ai, db, limits: LIMITS, prompt: "p" });
  assert.deepEqual([r.ok, r.budget], [false, true]);
  assert.deepEqual(calls, ["@cf/black-forest-labs/flux-1-schnell"]);
});

test("flux 2 dev (off by default) is sent as multipart form data", async () => {
  assert.equal(libraryModel(undefined), "schnell");
  assert.equal(libraryModel("FLUX2DEV"), "flux2dev");
  assert.equal(libraryModel("lucid"), "schnell");
  const { db } = await freshDb();
  let seen;
  const ai = { run: async (model, input) => ((seen = [model, input]), { image: Buffer.from(jpegOf(1024, 576)).toString("base64") }) };
  const r = await generateIllustration({ ai, db, limits: LIMITS, prompt: "p", primary: "flux2dev" });
  assert.equal(r.ok, true);
  assert.equal(seen[0], "@cf/black-forest-labs/flux-2-dev");
  assert.match(seen[1].multipart.contentType, /^multipart\/form-data; boundary=/);
  assert.equal((await aiUsage(db, { limits: LIMITS })).neurons, 2400);
});

test("Gemini noRetry: one HTTP request, then the call fails", async () => {
  let n = 0;
  const gemini = createGemini({ apiKey: "k", fetchImpl: async () => (n++, new Response("busy", { status: 503 })), sleep: async () => {} });
  await assert.rejects(gemini.generate([{ text: "x" }], { type: "OBJECT" }, { noRetry: true }), GeminiUnavailableError);
  assert.equal(n, 1);
  n = 0;
  const slow = createGemini({ apiKey: "k", fetchImpl: async () => (n++, new Response("{}", { status: 429 })), sleep: async () => {} });
  await assert.rejects(slow.generate([{ text: "x" }], { type: "OBJECT" }, { noRetry: true }), GeminiUnavailableError);
  assert.equal(n, 1);
});

// ---------------------------------------------------------------------------
// The library: matching, approval gating, decisions
// ---------------------------------------------------------------------------
const row = (id, theme, tags, status = "approved") => ({ id, theme, key: `private/library/test/${id}.jpg`, tags, alt: "alt", caption: "AI-generated illustration", source: "workers-ai", licence: "generated", credit: "AI-generated illustration", status });
const hex = (n) => n.toString(16).padStart(16, "0");

test("matching: tags against keywords; only approved images; never one of the last 10 posts' unless allowed", async () => {
  const { db } = await freshDb();
  assert.equal(matchScore(["Design", "layouts"], ["design", "layout", "grid"]), 2);
  await insertImage(db, row(hex(1), "design-polish", ["design", "layout", "grid"]));
  await insertImage(db, row(hex(2), "design-polish", ["design"]));
  await insertImage(db, row(hex(3), "design-polish", ["design", "layout", "grid", "polish"], "pending"));
  await insertImage(db, row(hex(4), "design-polish", ["design", "layout", "grid", "polish"], "rejected-auto"));
  await insertImage(db, row(hex(5), "design-polish", ["design", "layout", "grid", "polish"], "retired"));
  assert.equal((await matchLibrary(db, { keywords: ["design", "layout"] })).id, hex(1));
  assert.equal(await matchLibrary(db, { keywords: ["security"] }), null);
  // Used by one of the last 10 posts: skipped; the weaker match comes up.
  await recordUse(db, { imageId: hex(1), postId: "post-1", slot: "hero", now: new Date("2026-11-01T00:00:00Z") });
  assert.equal((await matchLibrary(db, { keywords: ["design", "layout"] })).id, hex(2));
  assert.equal((await matchLibrary(db, { keywords: ["design", "layout"], allowRecent: true })).id, hex(1));
  assert.equal((await matchLibrary(db, { keywords: ["design"], exclude: new Set([hex(2)]) })), null);
  // Ten newer posts later it is free again.
  for (let i = 0; i < 10; i++) await recordUse(db, { imageId: hex(2), postId: `post-${i + 2}`, slot: "hero", now: new Date(Date.UTC(2026, 10, 2 + i)) });
  assert.equal((await matchLibrary(db, { keywords: ["design", "layout"] })).id, hex(1));
});

test("decisions: keep and drop for pending and rejected-auto, retire for approved; the wrong status is refused", async () => {
  const { db } = await freshDb();
  await insertImage(db, row(hex(1), "t", ["a"], "pending"));
  await insertImage(db, row(hex(2), "t", ["a"], "rejected-auto"));
  assert.equal((await decide(db, { id: hex(1), action: "keep", actor: "admin:o" })).image.status, "approved");
  assert.equal((await decide(db, { id: hex(2), action: "drop", actor: "admin:o" })).image.status, "rejected");
  assert.equal((await decide(db, { id: hex(1), action: "keep", actor: "admin:o" })).error, "wrong_status");
  assert.equal((await decide(db, { id: hex(2), action: "retire", actor: "admin:o" })).error, "wrong_status");
  const retired = await decide(db, { id: hex(1), action: "retire", actor: "admin:o" });
  assert.equal(retired.image.status, "retired");
  assert.equal(retired.image.decidedBy, "admin:o");
  assert.equal((await decide(db, { id: hex(9), action: "keep", actor: "admin:o" })).error, "not_found");
  assert.equal(await matchLibrary(db, { keywords: ["a"] }), null, "retired and dropped images are never matched");
});

// ---------------------------------------------------------------------------
// The library's work: one image per queue item, the hourly batch
// ---------------------------------------------------------------------------
function stageCtx(db, { ai, limits = LIMITS, stored = new Map() } = {}) {
  return {
    db,
    now: () => Date.parse("2026-11-11T05:00:00Z"),
    log: () => {},
    library: { ai, perHour: 2, model: "schnell", limits, env: "test", store: async (k, b) => (stored.set(k, b), k) },
  };
}
const schnellAi = (calls = []) => ({ run: async (model) => (calls.push(model), { image: SQUARE_B64 }) });
const geminiFetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(CHECK_OK) }] }, finishReason: "STOP" }], usageMetadata: {} }), { status: 200 });
// 10:15 Pacific on 2026-11-11 (outside the quiet hours).
const MORNING = Date.parse("2026-11-11T18:15:00Z");
const batch = (db, over = {}) => runLibraryBatch({ db, env: { SITE_ENV: "production", GEMINI_RPM: "6000" }, ai: schnellAi(), store: async (k) => k, apiKey: "k", runId: "test", fetchImpl: geminiFetch, now: () => MORNING, log: () => {}, ...over });

test("house style: 26 themes of 5 subjects, each with alt text and tags; the queue goes round the themes", () => {
  assert.equal(THEMES.length, 26);
  assert.ok(THEMES.every((t) => t.subjects.length === 5 && t.tags.length >= 4));
  assert.equal(LIBRARY_SUBJECTS.length, 130);
  assert.ok(LIBRARY_SUBJECTS.every((s) => s.alt && s.prompt.includes("no letters or numbers")));
  assert.deepEqual(LIBRARY_SUBJECTS.slice(0, 26).map((s) => s.index), Array(26).fill(0));
  assert.equal(new Set(LIBRARY_SUBJECTS.slice(0, 26).map((s) => s.theme)).size, 26);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, 26);
});

test("library image: one per queue item, checked on the 16:9 crop; a failed check is rejected-auto; settings", async () => {
  const { db } = await freshDb();
  const calls = [];
  const stored = new Map();
  const ctx = stageCtx(db, { ai: schnellAi(calls), stored });
  const [first, second] = await queuedSubjects(db, { limit: 2 });
  const sizes = [];
  const gen = (answer) => async (req) => {
    const img = jpeg.decode(Buffer.from(req.parts[1].inline_data.data, "base64"));
    sizes.push(`${img.width}x${img.height}`);
    assert.equal(req.options.noRetry, true);
    return { result: answer, model: PRIMARY_MODEL };
  };
  const a = await makeLibraryImage(ctx, gen(CHECK_OK), first);
  const b = await makeLibraryImage(ctx, gen({ ...CHECK_OK, text_artifacts: true, note: "fake letters" }), second);
  assert.equal(a.status, "pending");
  assert.equal(b.status, "rejected-auto");
  assert.deepEqual(sizes, ["1024x576", "1024x576"]);
  assert.deepEqual(calls, Array(2).fill("@cf/black-forest-labs/flux-1-schnell"));
  const img = await getImage(db, a.id);
  assert.equal(img.caption, "AI-generated illustration");
  assert.equal(img.key, `private/library/test/${a.id}.jpg`);
  assert.ok(stored.has(img.key));
  assert.deepEqual(img.tags.slice(0, 2), THEMES.find((t) => t.id === first.theme).tags.slice(0, 2));
  const left = await queuedSubjects(db);
  assert.equal(left.length, 128);
  assert.ok(!left.some((s) => s.theme === first.theme && s.index === first.index));
  // The same item again, an hour later, stores nothing new (the unique index).
  const later = { ...ctx, now: () => Date.parse("2026-11-11T06:30:00Z") };
  assert.equal((await makeLibraryImage(later, gen(CHECK_OK), first)).status, "skipped");
  assert.equal((await listImages(db)).length, 2);

  assert.equal(perHour(undefined), 40);
  assert.equal(perHour("0"), 0);
  assert.equal(perHour("5"), 5);
  assert.equal(perHour("40"), 40);
  assert.equal(perHour("400"), 40, "never more than the day's 40");
  assert.deepEqual(libraryConfig({ LIBRARY_PER_HOUR: "0", MAX_AI_IMAGES_PER_DAY: "0", AI_NEURON_CEILING: "0", SITE_ENV: "staging" }), { perHour: 0, model: "schnell", limits: { maxImages: 0, perHour: 40, ceiling: 0, problem: null }, env: "staging" });
  assert.match(libraryConfig({ MAX_AI_IMAGES_PER_DAY: "50" }).limits.problem, /0 to 40/);
  assert.match(libraryStage.off(), /hourly tick/);
});

test("library image: a check that cannot run keeps the image pending, without a retry", async () => {
  const { db } = await freshDb();
  const ctx = stageCtx(db, { ai: schnellAi() });
  const [item] = await queuedSubjects(db, { limit: 1 });
  let n = 0;
  const r = await makeLibraryImage(ctx, async () => (n++, Promise.reject(new GeminiUnavailableError("busy"))), item);
  assert.equal(n, 1);
  assert.equal(r.status, "pending");
  assert.match((await getImage(db, r.id)).check.error, /busy/);
});

const TICK_ENV = { SITE_ENV: "production", GEMINI_RPM: "6000", LIBRARY_PER_HOUR: "2" };

test("hourly batch: the tick makes LIBRARY_PER_HOUR (2), logged as job library, within its Gemini cap", async () => {
  const { db } = await freshDb();
  assert.deepEqual(STAGES.map((s) => s.key), ["grade_new", "grade_changed", "compare", "content", "library", "regrade", "experiment"]);
  assert.deepEqual(budgetPlan().stages.library, { cap: 40, minutes: 25 });
  const calls = [];
  const r = await batch(db, { ai: schnellAi(calls), env: TICK_ENV });
  assert.deepEqual(r.made.map((m) => m.status), ["pending", "pending"]);
  assert.equal(calls.length, 2);
  assert.deepEqual([r.usage.images, r.usage.lastHour, r.usage.maxImages], [2, 2, 40], "every answer carries the counters");
  const logged = (await db.execute("SELECT job, COUNT(*) AS n FROM gemini_requests GROUP BY job")).rows.map((x) => `${x.job}:${x.n}`);
  assert.deepEqual(logged, ["library:2"]);
  // The library job's Gemini cap spent: no batch.
  const capped = await batch(db, { now: () => MORNING + 600000, env: { ...TICK_ENV, GEMINI_BUDGET: JSON.stringify({ stages: { library: { cap: 2 } } }) } });
  assert.equal(capped.error, "no_gemini_budget");
  assert.equal(capped.reason, "no_gemini_budget");
});

test("Make now: up to 10 a click with no hourly cap, until the day's 40 ('day', back at 00:00 UTC); the neurons stop it too", async () => {
  const { db } = await freshDb();
  const calls = [];
  // The tick made 2 at 10:15; the owner asks for 10 three times within the hour and gets them all.
  await batch(db, { ai: schnellAi(calls), env: TICK_ENV });
  for (let i = 1; i <= 3; i++) assert.equal((await batch(db, { ai: schnellAi(calls), env: TICK_ENV, count: 10, now: () => MORNING + i * 60000 })).made.length, 10);
  assert.equal(calls.length, 32);
  // Asking for 10 more gets the 8 left of the day's 40, then the day is used.
  assert.equal((await batch(db, { ai: schnellAi(calls), env: TICK_ENV, count: 10, now: () => MORNING + 300000 })).made.length, 8);
  const day = await batch(db, { ai: schnellAi(calls), env: TICK_ENV, count: 1, now: () => MORNING + 360000 });
  assert.deepEqual([day.made.length, day.error, day.reason, day.nextAt], [0, "no_room", "day", "2026-11-12T00:00:00.000Z"]);
  assert.equal(calls.length, 40);
  // A custom subject obeys the same limit.
  const own = await batch(db, { ai: schnellAi(calls), env: TICK_ENV, custom: { subject: "A flat stack of project cards with one amber card" }, now: () => MORNING + 360000 });
  assert.equal(own.reason, "day");
  assert.equal(calls.length, 40);
  // The neurons: 2,450 of 2,500 used by earlier, bigger calls.
  const { db: db3 } = await freshDb();
  await db3.execute({ sql: "INSERT INTO ai_image_calls (at, day, neurons, model) VALUES (?, ?, 2450, 'flux2dev')", args: [new Date(MORNING - 7200000).toISOString(), "2026-11-11"] });
  assert.equal((await batch(db3, { ai: schnellAi(calls), env: TICK_ENV, count: 1 })).reason, "neurons");
  assert.equal(calls.length, 40);
});

test("audit: every Workers AI path (tick, Make now, Make your own, a post's fresh illustration) is refused before the model once 40 images or 2,500 neurons are reserved for the UTC day", async () => {
  const { fillImages } = await import("../pipeline/content/images.mjs");
  const full = {
    images: async (db) => {
      for (let i = 0; i < 40; i++) await db.execute({ sql: "INSERT INTO ai_image_calls (at, day, neurons, model) VALUES (?, ?, 58, 'schnell')", args: [new Date(Date.parse("2026-11-11T01:00:00Z") + i * 60000).toISOString(), "2026-11-11"] });
    },
    neurons: async (db) => {
      await db.execute({ sql: "INSERT INTO ai_image_calls (at, day, neurons, model) VALUES (?, ?, 2450, 'flux2dev')", args: ["2026-11-11T01:00:00.000Z", "2026-11-11"] });
    },
  };
  // The gateway: one hourly limit far above the day's, so only the database can stop the call.
  const env = { SITE_ENV: "production", GEMINI_RPM: "6000", LIBRARY_PER_HOUR: "40" };
  for (const [what, fill] of Object.entries(full)) {
    const paths = {
      tick: (db, ai) => batch(db, { ai, env }),
      "make now": (db, ai) => batch(db, { ai, env, count: 5 }),
      "make your own": (db, ai) => batch(db, { ai, env, custom: { subject: "A flat lighthouse beside a browser window" } }),
      "post illustration": async (db, ai) => {
        const slot = { slot: "hero", kind: "picture", purpose: "a calm desk", keywords: ["nothing-matches"], alt: "A calm desk" };
        const sheet = { names: [], charts: [], screenshots: [], facts: [] };
        const r = await fillImages([slot], { sheet, body: "x", filledBody: "x", budget: { gemini: 5 }, ctx: { postId: "p", env: "test", db, now: () => MORNING, fetchImpl: async () => new Response("", { status: 500 }), keys: {}, ai, limits: aiLimits({}), store: async (k) => k, generate: async () => CHECK_OK } });
        return { made: [], notes: r.notes };
      },
    };
    for (const [path, run] of Object.entries(paths)) {
      const { db } = await freshDb();
      await fill(db);
      const calls = [];
      const r = await run(db, schnellAi(calls));
      assert.deepEqual(calls, [], `${path} with ${what} full must not call Workers AI`);
      assert.equal(r.made.length, 0, `${path}: nothing made`);
      if (r.reason) assert.equal(r.reason, what === "images" ? "day" : "neurons", `${path}: says why`);
      const n = (await db.execute("SELECT COUNT(*) AS n FROM ai_image_calls")).rows[0].n;
      assert.equal(Number(n), what === "images" ? 40 : 1, `${path}: no reservation slipped past the cap`);
    }
  }
});

test("Make your own: cleaned and bounded, one image with no queue slot, the same check, alt text and tags made from the subject", async () => {
  const { db } = await freshDb();
  const calls = [];
  assert.equal((await batch(db, { ai: schnellAi(calls), env: TICK_ENV, custom: { subject: "short" } })).reason, "bad_subject");
  assert.equal((await batch(db, { ai: schnellAi(calls), env: TICK_ENV, custom: { subject: "x".repeat(400) } })).reason, "bad_subject");
  assert.equal(calls.length, 0);
  const r = await batch(db, { ai: schnellAi(calls), env: TICK_ENV, custom: { subject: "A flat stack of project cards with one amber card on top.", theme: "project-storytelling" } });
  assert.deepEqual(r.made.map((m) => m.status), ["pending"]);
  const img = await getImage(db, r.made[0].id);
  assert.equal(img.subjectIndex, null, "never uses up a queue slot");
  assert.equal(img.theme, "project-storytelling");
  assert.equal(img.subject, "A flat stack of project cards with one amber card on top");
  assert.equal(img.prompt, imagePrompt(img.subject));
  assert.equal(img.alt, "Stack of project cards with one amber card on top, for project storytelling");
  assert.ok(img.tags.includes("projects") && img.tags.includes("card") && !img.tags.includes("amber"), img.tags.join(","));
  assert.equal(img.style, "flat vector");
  assert.equal((await queuedSubjects(db)).length, 130);
  // An unknown theme is "custom".
  const r2 = await batch(db, { ai: schnellAi(calls), env: TICK_ENV, custom: { subject: "A flat lighthouse beside a browser window", theme: "nope" } });
  assert.equal((await getImage(db, r2.made[0].id)).theme, "custom");
});

test("hourly batch: quiet from 20:00 to midnight Pacific, off without the binding, the key or the limits; the gateway's 429 stops it", async () => {
  const { db } = await freshDb();
  const calls = [];
  const evening = await batch(db, { ai: schnellAi(calls), now: () => Date.parse("2026-11-12T04:15:00Z") }); // 20:15 Pacific
  assert.equal(evening.error, "off");
  assert.equal(evening.reason, "quiet");
  assert.match(evening.stopped, /quiet hours/);
  assert.equal((await batch(db, { env: TICK_ENV, now: () => Date.parse("2026-11-12T08:15:00Z") })).made.length, 2, "00:15 Pacific is fine");
  assert.match((await batch(db, { ai: null })).stopped, /no Workers AI binding/);
  assert.match((await batch(db, { apiKey: "" })).stopped, /GEMINI_API_KEY/);
  assert.match((await batch(db, { env: { LIBRARY_PER_HOUR: "0" } })).stopped, /LIBRARY_PER_HOUR is 0/);
  assert.match((await batch(db, { env: { AI_NEURON_CEILING: "9000" } })).stopped, /AI_NEURON_CEILING "9000"/);
  assert.equal(calls.length, 0);
  // The gateway answers 429: one call, no Lucid, nothing stored, the batch stops.
  const { db: db2 } = await freshDb();
  const gwCalls = [];
  const gateway = { run: async (model) => (gwCalls.push(model), Promise.reject(Object.assign(new Error("429"), { name: "AiBudgetExhausted" }))) };
  const r = await batch(db2, { ai: gateway });
  assert.deepEqual(r.made, []);
  assert.match(r.stopped, /no room for AI images now/);
  assert.equal(r.reason, "gateway");
  assert.equal(r.gatewayLimit, 0, "the refused call is not one the gateway allowed");
  assert.deepEqual(gwCalls, ["@cf/black-forest-labs/flux-1-schnell"]);
  assert.equal((await listImages(db2)).length, 0);
});

// ---------------------------------------------------------------------------
// The owner's tools: the queue, drop and its Undo, alt text and tags, associations
// ---------------------------------------------------------------------------
test("queue: edit, skip, un-skip and reset a subject before it is made; a made one can't change", async () => {
  const { db } = await freshDb();
  const [first, second] = await queueItems(db);
  assert.equal((await editQueueItem(db, { theme: first.theme, index: first.index, op: "edit", subject: "tiny" })).ok, false);
  assert.equal((await editQueueItem(db, { theme: "nope", index: 0, op: "skip" })).error, "bad_request");
  assert.equal((await editQueueItem(db, { theme: first.theme, index: first.index, op: "drop" })).error, "bad_request");
  assert.equal((await editQueueItem(db, { theme: first.theme, index: first.index, op: "edit", subject: "A flat lighthouse beside a browser window" })).ok, true);
  assert.equal((await editQueueItem(db, { theme: second.theme, index: second.index, op: "skip" })).ok, true);
  let items = await queueItems(db);
  const edited = items.find((q) => q.theme === first.theme && q.index === first.index);
  assert.deepEqual([edited.subject, edited.edited, edited.original], ["A flat lighthouse beside a browser window", true, first.subject]);
  assert.equal(edited.prompt, imagePrompt("A flat lighthouse beside a browser window"));
  assert.match(edited.alt, /^Lighthouse beside a browser window, for /);
  assert.ok(items.find((q) => q.theme === second.theme && q.index === second.index).skipped);
  // A skipped subject is never made; the queue counts it out.
  const next = await queuedSubjects(db, { limit: 2 });
  assert.ok(!next.some((q) => q.theme === second.theme && q.index === second.index));
  assert.equal((await librarySummary(db)).queued, 129);
  assert.equal((await librarySummary(db)).skipped, 1);
  // Skipping keeps an edit; reset brings back the built-in subject.
  await editQueueItem(db, { theme: first.theme, index: first.index, op: "skip" });
  items = await queueItems(db);
  assert.deepEqual([items[0].skipped, items[0].edited], [true, true]);
  await editQueueItem(db, { theme: first.theme, index: first.index, op: "reset" });
  await editQueueItem(db, { theme: second.theme, index: second.index, op: "unskip" });
  items = await queueItems(db);
  assert.deepEqual([items[0].subject, items[0].skipped, items[1].skipped], [first.subject, false, false]);
  // Once made, an item can't be edited.
  await insertImage(db, { ...row(hex(1), first.theme, ["a"], "pending"), subjectIndex: first.index });
  assert.equal((await editQueueItem(db, { theme: first.theme, index: first.index, op: "skip" })).error, "already_made");
});

test("cleaning: subjects, alt text and tags lose control and separator characters and are bounded", () => {
  assert.deepEqual(cleanSubject("  A flat browser​ window  with cards.  "), { ok: true, subject: "A flat browser window with cards" });
  assert.equal(cleanSubject(42).ok, false);
  assert.equal(cleanSubject("1234567890").ok, false, "needs words");
  assert.equal(cleanAlt("A short alt text line").alt, "A short alt text line");
  assert.equal(cleanAlt("x".repeat(161)).ok, false);
  assert.deepEqual(cleanTags(["Design", " design ", "dark mode", "<b>ui</b>", ""]).tags, ["design", "dark mode", "bui/b"]);
  assert.equal(cleanTags(Array.from({ length: 17 }, (_, i) => `t${i}`)).ok, false);
  assert.equal(cleanTags(["x".repeat(31)]).ok, false);
  assert.equal(cleanTags("a, b").tags.length, 2);
  // Alt text: short, specific, the theme said once, never longer than 160.
  assert.equal(altFor("A flat globe made of simple lines with small edge nodes around it, one node in amber", "Deployment and cloud"), "Globe made of simple lines with small edge nodes around it, one node in amber, for deployment and cloud");
  assert.equal(altFor("The first impression (five seconds)", "First impressions (the five-second test)"), "First impression (five seconds), for first impressions");
  assert.ok(altFor("word ".repeat(80), "Theme").length <= 160);
});

test("drop and Undo: drop is immediate, restore puts it back where it was, nothing is deleted", async () => {
  const { db } = await freshDb();
  await insertImage(db, row(hex(1), "t", ["a"], "pending"));
  await insertImage(db, row(hex(2), "t", ["a"], "rejected-auto"));
  for (const id of [hex(1), hex(2)]) assert.equal((await decide(db, { id, action: "drop", actor: "admin:o" })).image.status, "rejected");
  assert.equal((await decide(db, { id: hex(1), action: "restore", to: "approved", actor: "admin:o" })).error, "bad_request", "an undo never approves");
  assert.equal((await decide(db, { id: hex(1), action: "restore", to: "pending", actor: "admin:o" })).image.status, "pending");
  assert.equal((await decide(db, { id: hex(2), action: "restore", to: "rejected-auto", actor: "admin:o" })).image.status, "rejected-auto");
  assert.equal((await decide(db, { id: hex(2), action: "restore", to: "pending", actor: "admin:o" })).error, "wrong_status", "only a dropped image can be restored");
  assert.equal((await listImages(db)).length, 2);
});

test("alt text and tags: editable, cleaned, and the edited tags drive matching", async () => {
  const { db } = await freshDb();
  await insertImage(db, row(hex(1), "t", ["design"], "approved"));
  assert.equal((await editImage(db, { id: hex(1), alt: "no" })).error, "Alt text needs at least 8 characters.");
  assert.equal((await editImage(db, { id: hex(9), alt: "A real alt text" })).error, "not_found");
  assert.equal((await editImage(db, { id: hex(1) })).error, "Nothing to change.");
  const r = await editImage(db, { id: hex(1), alt: "Grid of cards with one amber card", tags: ["Security", "auth"] });
  assert.deepEqual([r.image.alt, r.image.tags], ["Grid of cards with one amber card", ["security", "auth"]]);
  assert.equal(await matchLibrary(db, { keywords: ["design"] }), null);
  assert.equal((await matchLibrary(db, { keywords: ["security"] })).id, hex(1));
});

test("associations: posts that used, considered or made an image; a rejected draft never deletes its images", async () => {
  const { db } = await freshDb();
  const { storePost } = await import("../lib/content/store.mjs");
  const { review } = await import("../lib/content/blog.mjs");
  for (let i = 1; i <= 4; i++) await insertImage(db, row(hex(i), "design-polish", ["design", "layout", ...(i === 1 ? ["grid"] : [])]));
  await insertImage(db, { ...row(hex(5), "post", ["design"], "pending"), postId: "p1" });
  const ranked = await rankLibrary(db, { keywords: ["design", "layout", "grid"] });
  assert.equal(ranked[0].img.id, hex(1));
  assert.equal(ranked.length, 4, "the best and up to 3 close matches");
  await recordUse(db, { imageId: hex(1), postId: "p1", slot: "hero" });
  for (const { img } of ranked.slice(1)) await recordConsidered(db, { imageId: img.id, postId: "p1", slot: "hero" });
  await recordConsidered(db, { imageId: hex(2), postId: "p1", slot: "hero" }); // once only
  await storePost(db, testPost("p1"), { mode: "dry-run", publishAt: null, now: new Date() });
  const links = await associations(db);
  assert.deepEqual(links.get(hex(1)).map((l) => [l.kind, l.postId, l.title, l.status]), [["used", "p1", "A test draft", "draft"]]);
  assert.deepEqual(links.get(hex(2)).map((l) => l.kind), ["considered"]);
  assert.deepEqual(links.get(hex(5)).map((l) => l.kind), ["made"]);
  const s = await librarySummary(db);
  assert.deepEqual([s.usedInPosts, s.usedInPublished], [1, 0]);
  // The owner rejects the draft: every image, use and association stays.
  assert.equal((await review(db, "p1", { action: "reject", by: "admin:o", note: "no", now: new Date() })).status, "rejected");
  assert.equal((await listImages(db)).length, 5);
  assert.equal((await associations(db)).get(hex(1))[0].status, "rejected");
});

test("page helpers: tabs and counts, search and tags, Make choices, progress and every outcome in plain words", () => {
  const imgs = [
    { id: "1", status: "pending", alt: "Browser window with a grid", subject: "grid", tags: ["design", "grid"], style: "flat vector" },
    { id: "2", status: "approved", alt: "Database and API plug", subject: "db", tags: ["backend"], style: "flat vector" },
    { id: "3", status: "rejected", alt: "Dark window", subject: "dark", tags: ["dark mode", "design"], style: "flat vector" },
    { id: "4", status: "rejected-auto", alt: "Rocket", subject: "rocket", tags: ["ship"], style: "flat vector" },
  ];
  assert.deepEqual(viewCounts(imgs), { review: 1, approved: 1, dropped: 1, failed: 1, all: 4 });
  assert.deepEqual(filterImages(imgs, "nope").map((i) => i.id), ["1"], "To review is the default");
  assert.deepEqual(viewCounts(withStatuses(imgs, { 1: "rejected" })), { review: 0, approved: 1, dropped: 2, failed: 1, all: 4 });
  assert.deepEqual(searchImages(imgs, { tag: "design" }).map((i) => i.id), ["1", "3"]);
  assert.deepEqual(searchImages(imgs, { query: "window GRID" }).map((i) => i.id), ["1"]);
  assert.deepEqual(searchImages(imgs, { query: "api", tag: "design" }), []);
  assert.deepEqual(tagCounts(imgs).slice(0, 2), [{ tag: "flat vector", n: 4 }, { tag: "design", n: 2 }]);
  assert.deepEqual(imageTags({ tags: ["design", "flat vector"], style: "flat vector" }), ["design", "flat vector"], "an edit that repeats the style shows it once");
  assert.equal(arrivalView({ review: 2, approved: 12 }), "review", "anything to review comes first");
  assert.equal(arrivalView({ review: 0, approved: 12 }), "approved", "nothing to review opens on the approved images");
  assert.equal(arrivalView({ review: 0, approved: 0 }), "review", "an empty library says so on To review");
  assert.deepEqual(makeChoices(10), [1, 2, 5, 10]);
  assert.deepEqual(makeChoices(38), [1, 2, 5, 10], "never more than 10 a click");
  assert.deepEqual(makeChoices(7), [1, 2, 5, 7]);
  assert.deepEqual(makeChoices(1), [1]);
  assert.deepEqual(makeChoices(0), []);
  assert.equal(progressText(1, 2), "Making 1 of 2... about 5 seconds each");
  assert.equal(progressText(2, 5, 8400), "Making 2 of 5... about 8 seconds each");
  const usage = { images: 12, maxImages: 40, lastHour: 10, perHour: 10, neurons: 696, ceiling: 2500 };
  assert.equal(countsText(usage), "Today 12 of 40 · 28 left");
  const fmt = () => "3:15 PM";
  assert.equal(describeMake({ requested: 2, made: [{ status: "pending" }, { status: "pending" }] }, fmt), "Made 2 (in To review)");
  assert.equal(describeMake({ requested: 5, made: [{ status: "pending" }, { status: "rejected-auto" }], reason: "hour", nextAt: "2026-11-11T23:15:00Z", usage }, fmt), "Made 2 of 5 (1 to review, 1 failed the check). This hour's limit is used: next batch at 3:15 PM");
  assert.equal(describeMake({ made: [], reason: "hour", nextAt: "x" }, fmt), "This hour's limit is used: next batch at 3:15 PM");
  assert.equal(describeMake({ made: [], reason: "day", usage }, fmt), "Today's 40 are used");
  assert.equal(describeMake({ made: [], reason: "quiet" }, fmt), "Paused 8 pm to midnight Pacific");
  assert.equal(describeMake({ made: [], reason: "gateway", gatewayLimit: 2, usage }, fmt), "The AI Gateway allows 2 an hour: raise it in AI Gateway settings");
  assert.match(describeMake({ made: [], reason: "neurons", usage }, fmt), /neuron allowance is used \(696 of 2,500\)/);
  assert.equal(describeMake({ made: [] }, fmt), "Nothing was made");
  assert.equal(idleReason({ remaining: 0, blocker: "day", quiet: false, off: null }, usage, fmt), "Today's 40 are used");
  assert.equal(idleReason({ remaining: 3, blocker: null, quiet: true, off: null }, usage, fmt), "Paused 8 pm to midnight Pacific");
  assert.equal(idleReason({ remaining: 3, blocker: null, quiet: false, off: null }, usage, fmt), null);
});

/** A minimal draft row for lib/content/store.mjs insertPost. */
function testPost(id) {
  return { id, slug: `test-${id}`, kind: "test", status: "draft", mode: "dry-run", title: "A test draft", body: "Body.", facts: {}, checks: {}, images: [], claims: [], dataAsOf: "2026-11-11", aiLine: "Written with AI", aiNote: "Note" };
}

// ---------------------------------------------------------------------------
// Pexels
// ---------------------------------------------------------------------------
test("Pexels counter: counts each search per UTC month and stops a runaway at the cap", async () => {
  const { db } = await freshDb();
  assert.equal(pexelsCap(undefined), 500);
  assert.equal(pexelsCap("3"), 3);
  const nov = new Date("2026-11-30T23:00:00Z");
  const dec = new Date("2026-12-01T00:00:00Z");
  const got = [];
  for (let i = 0; i < 4; i++) got.push(await reserveSearch(db, { cap: 3, now: nov }));
  assert.deepEqual(got, [true, true, true, false]);
  assert.deepEqual(await searchUsage(db, { cap: 3, now: nov }), { month: "2026-11", used: 3, cap: 3 });
  assert.equal(await reserveSearch(db, { cap: 3, now: dec }), true);
  assert.equal((await searchUsage(db, { cap: 3, now: dec })).used, 1);
  assert.equal(await reserveSearch(db, { cap: 0, now: new Date("2027-01-02T00:00:00Z") }), false);
});
