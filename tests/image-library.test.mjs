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
import { decide, getImage, insertImage, listImages, matchLibrary, matchScore, queuedSubjects, recordUse } from "../lib/content/library.mjs";
import { pexelsCap, reserveSearch, searchUsage } from "../lib/content/pexels-searches.mjs";
import { LIBRARY_SUBJECTS, THEMES } from "../pipeline/content/house-style.mjs";
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
// The never-pay guard: 40 AI images a UTC day, 2 a rolling hour, 2,500 neurons
// ---------------------------------------------------------------------------
const at = (iso, minutes = 0) => new Date(Date.parse(iso) + minutes * 60000);

test("estimates: Schnell 58, Lucid 1,512 (768x432, 20 steps), Flux 2 Dev 2,400 (1024x576, 16 steps); 40 Schnell images fit 2,500", () => {
  assert.equal(neuronsFor("schnell"), 58);
  assert.equal(neuronsFor("lucid"), 1512);
  assert.equal(neuronsFor("flux2dev"), 2400);
  for (const k of ["schnell", "lucid", "flux2dev"]) assert.ok(neuronsFor(k) <= MAX_NEURON_CEILING);
  assert.equal(MAX_AI_IMAGES_PER_DAY, 40);
  assert.equal(MAX_AI_IMAGES_PER_HOUR, 2);
  assert.equal(MAX_NEURON_CEILING, 2500);
  assert.ok(MAX_AI_IMAGES_PER_DAY * neuronsFor("schnell") <= MAX_NEURON_CEILING);
  assert.ok(MAX_NEURON_CEILING <= PORTFOLIORANK_SLICE);
});

test("limits: 40 a day, 2 an hour, 2,500 neurons by default; a value above a maximum, or not a whole number, is rejected and fails closed", () => {
  assert.deepEqual(aiLimits({}), { maxImages: 40, perHour: 2, ceiling: 2500, problem: null });
  assert.deepEqual(aiLimits({ MAX_AI_IMAGES_PER_DAY: "10", AI_NEURON_CEILING: "1000" }), { maxImages: 10, perHour: 2, ceiling: 1000, problem: null });
  assert.deepEqual(aiLimits({ MAX_AI_IMAGES_PER_DAY: "0", AI_NEURON_CEILING: "0" }), { maxImages: 0, perHour: 2, ceiling: 0, problem: null });
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

  assert.equal(perHour(undefined), 2);
  assert.equal(perHour("0"), 0);
  assert.equal(perHour("1"), 1);
  assert.equal(perHour("40"), 2, "never more than the gateway's 2 an hour");
  assert.deepEqual(libraryConfig({ LIBRARY_PER_HOUR: "0", MAX_AI_IMAGES_PER_DAY: "0", AI_NEURON_CEILING: "0", SITE_ENV: "staging" }), { perHour: 0, model: "schnell", limits: { maxImages: 0, perHour: 2, ceiling: 0, problem: null }, env: "staging" });
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

test("hourly batch: 2 an hour, logged as job library, within its Gemini cap; the next tick in the same hour makes none", async () => {
  const { db } = await freshDb();
  assert.deepEqual(STAGES.map((s) => s.key), ["grade_new", "grade_changed", "compare", "content", "library", "regrade", "experiment"]);
  assert.deepEqual(budgetPlan().stages.library, { cap: 40, minutes: 25 });
  const calls = [];
  const r = await batch(db, { ai: schnellAi(calls) });
  assert.deepEqual(r.made.map((m) => m.status), ["pending", "pending"]);
  assert.equal(calls.length, 2);
  const logged = (await db.execute("SELECT job, COUNT(*) AS n FROM gemini_requests GROUP BY job")).rows.map((x) => `${x.job}:${x.n}`);
  assert.deepEqual(logged, ["library:2"]);
  // Ten minutes later, the rolling hour is full: no Workers AI call at all.
  const again = await batch(db, { ai: schnellAi(calls), now: () => MORNING + 600000 });
  assert.deepEqual(again.made, []);
  assert.match(again.stopped, /2 of 2 in the last hour/);
  assert.equal(calls.length, 2);
  // An hour on, two more.
  assert.equal((await batch(db, { ai: schnellAi(calls), now: () => MORNING + 3600000 + 1000 })).made.length, 2);
  // The library job's Gemini cap spent: no batch.
  const capped = await batch(db, { now: () => MORNING + 7200000 + 1000, env: { SITE_ENV: "production", GEMINI_BUDGET: JSON.stringify({ stages: { library: { cap: 4 } } }) } });
  assert.equal(capped.error, "no_gemini_budget");
});

test("hourly batch: quiet from 20:00 to midnight Pacific, off without the binding, the key or the limits; the gateway's 429 stops it", async () => {
  const { db } = await freshDb();
  const calls = [];
  const evening = await batch(db, { ai: schnellAi(calls), now: () => Date.parse("2026-11-12T04:15:00Z") }); // 20:15 Pacific
  assert.equal(evening.error, "off");
  assert.match(evening.stopped, /quiet hours/);
  assert.equal((await batch(db, { now: () => Date.parse("2026-11-12T08:15:00Z") })).made.length, 2, "00:15 Pacific is fine");
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
  assert.deepEqual(gwCalls, ["@cf/black-forest-labs/flux-1-schnell"]);
  assert.equal((await listImages(db2)).length, 0);
});

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
