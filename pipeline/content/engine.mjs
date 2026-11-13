// The content engine's night work (docs/CONTENT-ENGINE.md, "The pipeline"):
// the end-of-day run's "Content" stage (pipeline/night.mjs) runs the weekly
// polls first, then, while CONTENT_MODE is not "off", one content job:
//
//   pick   (stage 1 and 2) on Sunday night, or the first night of a week
//          without one: every fact builder that is ready is an idea; one
//          Gemini request scores them for interest, topic and tone; code
//          keeps the best 2 and a reserve.
//   draft  (stages 3 to 8) on the drafting nights: Monday and Wednesday,
//          for Tuesday's and Thursday's 08:00 Pacific (owner decision 2),
//          and a later night when an earlier draft of the week was dropped
//          or deferred. Facts, write, check (code, outside claims, final
//          review), revise at most twice, images, store.
//
// Caps (gate 6): 1 draft a night, 2 revision rounds, Tavily 10 a post and
// 50 a week, 1 fresh illustration, 2 Pexels searches and 3 image checks a
// post (images.mjs), 2 published posts in any 7
// days (lib/content/store.mjs storePost), and the stage's Gemini cap and
// time cap from the budget accountant. All requests go to 3.5 Flash-Lite
// through the night's client (job "content"); a draft never takes more
// than what is left of the current batch.
//
// The kill switch: CONTENT_MODE "off" (the default) stops the content jobs
// at the next batch; "dry-run" keeps every draft private (status draft);
// "publish" publishes, and only the owner sets it (owner decision 7).
// Within that ceiling the owner's automation settings (lib/content/
// automation.mjs, saved from /admin/blog) choose on or off, the drafting
// days, drafts a week, review or publish, and a queue of topics; when they
// can't be read, the night writes nothing (fail closed). Publishing also
// needs a clean quality scorecard, else the post is kept for review.
import crypto from "node:crypto";
import { pollsContent } from "../polls.mjs";
import { CONTENT_MODELS, isBusy } from "./busy.mjs";
import { pacificParts } from "../quota-day.mjs";
import { AI_LINE, aiNote, contentWeek, nextMorning, recordRun, runsOfWeek, slugify, storePost, tavilyThisWeek } from "../../lib/content/store.mjs";
import { BUILDERS, SITE_URL, findIdeas } from "./facts.mjs";
import { listPublished } from "../../lib/content/blog.mjs";
import { assembleBody, buildReviseRequest, buildWriteRequest, cutSentences, draftTexts, fill, normalizeDraft } from "./writer.mjs";
import { checkLinksLoad, codeChecks, urlsIn } from "./checks.mjs";
import { creditsFor, monthlyCap } from "../../lib/content/tavily-credits.mjs";
import { TAVILY_PER_POST, TAVILY_PER_WEEK, checkClaims } from "./claims.mjs";
import { KIND_TOPIC, TOPICS, buildPickRequest, buildReviewRequest, choosePicks, reviewCheck } from "./topic.mjs";
import { fillImages } from "./images.mjs";
import { aiLimits } from "../../lib/content/neurons.mjs";
import { pexelsCap } from "../../lib/content/pexels-searches.mjs";
import { OutlineError, STAGED_REQUESTS, stagedWrite } from "./staged.mjs";
import { draftsDueBy, draftsWaiting, nextTopic, readAutomation, markTopicUsed } from "../../lib/content/automation.mjs";
import { scorecard } from "./scorecard.mjs";
import { linkPortfoliosToPages } from "../../lib/content/portfolio-links.mjs";

export const MAX_REVISIONS = 2;
/** Requests one round of a draft needs: write, list claims, judge them, final review. */
export const ROUND_REQUESTS = 4;
/** Requests a draft must be able to spend before it starts. */
export const MIN_DRAFT_REQUESTS = ROUND_REQUESTS;
/** Rough requests of a draft that passes first time, for the night's estimate. */
export const DRAFT_ESTIMATE = 9;
/** Drafting nights (Pacific weekday of the night): Monday and Wednesday. */
export const DRAFT_NIGHTS = [1, 3];
export const PICK_NIGHT = 0;

export class ContentBudgetError extends Error {}

/** What a draft is doing, for the live status of "Write a draft now" (in order). */
export const PHASES = {
  facts: "Reading the data",
  writing: "Writing",
  researching: "Researching outside claims",
  checking: "Checking",
  revising: "Revising",
  images: "Picking images",
  saving: "Saving the draft",
};

const iso = (ms) => new Date(ms).toISOString();
const msg = (e) => String(e?.message ?? e).slice(0, 300);

/** Drafting nights of the week up to and including this weekday (Sunday is the week before). */
export function draftsDue(weekday) {
  if (weekday === PICK_NIGHT) return 0;
  return DRAFT_NIGHTS.filter((d) => d <= weekday).length;
}

/**
 * The owner's automation settings for the night, within the config's
 * ceiling (ctx.flags.contentMode, ctx.flags.contentDraftsPerWeek). Null when
 * they can't be read: the caller writes nothing.
 */
export async function automationFor(ctx) {
  try {
    return await readAutomation(ctx.db, { CONTENT_MODE: ctx.flags?.contentMode ?? "off", CONTENT_DRAFTS_PER_WEEK: ctx.flags?.contentDraftsPerWeek });
  } catch (e) {
    ctx.log?.(`Content: the automation settings can't be read, so nothing is written tonight: ${msg(e)}`);
    return null;
  }
}

/**
 * What tonight's content job is, or null. `done` lists the steps already run
 * tonight. Returns { step: "pick" } or { step: "draft", kind, topic? } or
 * null, and why in `reason`; `mode` is the store's mode for tonight's draft.
 */
export async function contentJob(ctx, { done = [] } = {}) {
  const ceiling = ctx.flags?.contentMode ?? "off";
  if (ceiling === "off") return { job: null, reason: 'CONTENT_MODE is "off"' };
  const auto = await automationFor(ctx);
  if (!auto) return { job: null, reason: "the automation settings can't be read" };
  const settings = auto.settings;
  if (!settings.enabled) return { job: null, reason: "the automation is off (/admin/blog)" };
  const now = ctx.now();
  const weekday = pacificParts(now).weekday;
  const week = contentWeek(now);
  const pick = (await runsOfWeek(ctx.db, week, "pick")).filter((r) => r.status === "ok").at(-1);
  const drafts = await runsOfWeek(ctx.db, week, "draft");
  const ok = drafts.filter((r) => r.status === "ok").length;
  const due = draftsDueBy(settings, weekday);
  const draftedTonight = drafts.some((r) => r.night === nightOf(ctx, now) && r.status !== "deferred");
  // "Drafts to keep ready": any night but Sunday tops up the drafts waiting for review, one a night.
  const topUp = (settings.keepReady ?? 0) > 0 && weekday !== PICK_NIGHT && ok >= due ? (await draftsWaiting(ctx.db)) < settings.keepReady : false;
  const draftTonight = !done.includes("draft") && (ok < due || topUp) && !draftedTonight;
  const mode = settings.engineMode;
  if (!pick) {
    if (done.includes("pick")) return { job: null, reason: "no ideas picked this week" };
    if (weekday === PICK_NIGHT || draftTonight) return { job: { step: "pick" }, mode, reason: "the week's pick" };
    return { job: null, reason: "no pick yet; waiting for Sunday" };
  }
  if (!draftTonight) return { job: null, reason: draftedTonight || done.includes("draft") ? "a draft already ran tonight" : `${ok} of ${due} draft(s) due this week done${settings.keepReady ? `, and ${settings.keepReady} or more drafts are waiting` : ""}` };
  const tried = new Set(drafts.filter((r) => r.status !== "deferred").map((r) => r.kind));
  const order = [...(pick.detail.picks ?? []).map((p) => p.kind), ...(pick.detail.reserve ? [pick.detail.reserve.kind] : [])];
  const fresh = order.find((k) => !tried.has(k)) ?? null;
  // The owner's queued topic, if any, is the next draft's angle; the week's
  // pick still chooses the data it is written from (a fresh idea first, else
  // the week's best one again, from the new angle).
  const topic = await nextTopic(ctx.db);
  // A queued topic, or a top-up once every idea was tried, writes again from the week's ideas in turn.
  const kind = fresh ?? (!order.length ? null : topic ? order[0] : topUp ? order[tried.size % order.length] : null);
  if (!kind) return { job: null, reason: "every idea picked this week was tried" };
  return { job: { step: "draft", kind, ...(topic ? { topic } : {}) }, mode, reason: topic ? `draft ${kind} on the queued topic "${topic.topic}"` : `draft ${kind}` };
}

const nightOf = (ctx, now) => ctx.night ?? pacificDay(now);
function pacificDay(now) {
  const p = pacificParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A generate() over the night's client that keeps to a request budget and to 3.5. */
function budgeted(gemini, limit) {
  const used = { n: 0 };
  const generate = async (req) => {
    if (used.n >= limit) throw new ContentBudgetError(`content budget of ${limit} request(s) for this step is used up`);
    used.n++;
    const out = await gemini.generate(req.parts, req.schema, req.options);
    if (!CONTENT_MODELS.includes(out.model)) throw new Error(`answered by ${out.model}, not ${CONTENT_MODELS.join(" or ")}`);
    return out.result;
  };
  return { generate, used, left: () => limit - used.n };
}

/** Stage 1 and 2: ideas from the fact builders, scored by one request when there is a choice. */
export async function runPick(ctx, gemini, { night, budget }) {
  const now = ctx.now();
  const mode = ctx.flags.contentMode;
  const { ideas, waiting } = await findIdeas(ctx.db, { now });
  const lastKinds = (await runsOfWeek(ctx.db, contentWeek(now - 7 * 86400000), "draft")).filter((r) => r.status === "ok").map((r) => r.kind);
  let chosen;
  let requests = 0;
  if (ideas.length === 0) chosen = { picks: [], reserve: null, skipped: [] };
  else if (ideas.length === 1) chosen = { picks: [{ kind: ideas[0].kind, score: null, topic: KIND_TOPIC[ideas[0].kind] ?? TOPICS[1], tone: "neutral" }], reserve: null, skipped: [] };
  else {
    const g = budgeted(gemini, Math.min(1, budget));
    const answer = await g.generate(buildPickRequest(ideas, { lastKinds }));
    requests = g.used.n;
    chosen = choosePicks(ideas, answer, { lastKinds });
  }
  const status = chosen.picks.length ? "ok" : "skipped";
  await recordRun(ctx.db, { night, now, step: "pick", mode, status, gemini: requests, detail: { ...chosen, waiting, ideas: ideas.map((i) => i.kind) } });
  ctx.log(`Content: pick ${status}: ${chosen.picks.map((p) => p.kind).join(", ") || "none"}${chosen.reserve ? `, reserve ${chosen.reserve.kind}` : ""}; waiting for data: ${waiting.map((w) => w.kind).join(", ") || "none"}`);
  return { status, ...chosen, requests };
}

async function rosterOf(db) {
  return (await db.execute("SELECT name, url FROM portfolios WHERE name IS NOT NULL")).rows.map((r) => ({ name: String(r.name), url: String(r.url) }));
}

/** Adds each supported claim's source link after its sentence. */
export function linkSources(markdown, supported) {
  let out = markdown;
  for (const c of supported) {
    const s = c.sentence.replace(/[.?!]$/, "");
    const end = c.sentence.slice(s.length);
    out = out.split(c.sentence).join(`${s} ([source](${c.url}))${end}`);
  }
  return out;
}

/**
 * Stages 3 to 8 for one idea. Returns { status: "ok" | "dropped" |
 * "skipped" | "deferred", postId, requests, ... }. Throws Gemini's own
 * errors (quota, key, retries) so the night stops the way it always does.
 * `step` is the content_runs step: "draft" for the night (which the
 * schedule counts), "manual" for the owner's "Write a draft now"
 * (pipeline/content/manual.mjs). `focus` is the owner's optional angle,
 * which steers the writer over the same facts. `extras` adds to the sheet
 * what the writer should also follow: `guidelines` (the editor's
 * guidelines), `ownerNotes` (a rewrite's notes) and `rewriteOf`.
 * `onPhase(phase, detail)` reports progress (PHASES) for the live status.
 * Returns also `searches` (Tavily) and `aiImages` (Workers AI) spent.
 */
export async function runDraft(ctx, gemini, { kind, night, budget, step = "draft", focus = null, length = null, extras = {}, onPhase = async () => {} }) {
  const now = ctx.now();
  const mode = ctx.flags.contentMode;
  const db = ctx.db;
  const log = (line) => ctx.log(`Content: ${kind}: ${line}`);
  const phase = async (name, detail = null) => {
    try {
      await onPhase(name, detail);
    } catch {
      // The live status is a convenience; it never fails a draft.
    }
  };
  const staged = ctx.flags.writerMode === "staged";
  const minRequests = staged ? STAGED_REQUESTS + 2 : MIN_DRAFT_REQUESTS;
  if (budget < minRequests) {
    await recordRun(db, { night, now, step, mode, status: "deferred", kind, detail: { reason: `only ${budget} request(s) left in this batch; ${minRequests} needed` } });
    return { status: "deferred", requests: 0 };
  }
  await phase("facts");
  const built = await BUILDERS[kind](db, { now });
  // Published posts the draft may link to (interlinks, owner 2026-11-12), newest first.
  const relatedPosts = built.ready ? (await listPublished(db, { now, limit: 12 }).catch(() => [])).map((p) => ({ title: p.title, url: `${SITE_URL}/blog/${p.slug}`, tags: p.tags })) : [];
  const sheet = built.ready ? { ...built, ...(focus ? { focus } : {}), ...(length ? { length } : {}), ...(relatedPosts.length ? { relatedPosts } : {}), ...extras } : built;
  if (!sheet.ready) {
    await recordRun(db, { night, now, step, mode, status: "skipped", kind, detail: { reason: sheet.reason } });
    log(`not ready: ${sheet.reason}`);
    return { status: "skipped", requests: 0 };
  }
  const g = budgeted(gemini, budget);
  const roster = await rosterOf(db);
  const tavilyLeft = Math.max(0, Math.min(TAVILY_PER_POST, TAVILY_PER_WEEK - (await tavilyThisWeek(db, now))));
  const postId = crypto.randomBytes(8).toString("hex");
  const history = [];
  let searches = 0;
  let draft = null;
  let supported = [];
  let failures = [];
  let passed = false;
  let review = null;
  try {
    for (let round = 0; round <= MAX_REVISIONS; round++) {
      if (round > 0 && g.left() < ROUND_REQUESTS) {
        failures.push(`no budget for revision ${round} (${g.left()} request(s) left)`);
        break;
      }
      await phase(round === 0 ? "writing" : "revising", round === 0 ? null : `round ${round} of ${MAX_REVISIONS}`);
      if (round === 0 && staged) draft = normalizeDraft((await stagedWrite(sheet, g.generate, { onOutlineFail: (p) => log(`outline retry: ${p.slice(0, 2).join("; ")}`), log })).draft);
      else draft = normalizeDraft(await g.generate(round === 0 ? buildWriteRequest(sheet) : buildReviseRequest(sheet, draft, failures)));
      // Gate 2: outside claims, on the unfilled draft.
      await phase("researching");
      const text = draftTexts(draft)
        .filter(([k]) => !k.startsWith("images."))
        .map(([, v]) => v)
        .join("\n");
      const claims = await checkClaims(text, { tavilyKey: ctx.content?.keys?.tavily, fetchImpl: ctx.fetchImpl, budget: { gemini: g.left() - 1, tavily: tavilyLeft - searches }, generate: g.generate, names: sheet.names.map((n) => n.name), credits: creditsFor(db, { cap: monthlyCap(ctx.content?.tavilyMonthlyCredits), now: () => new Date(now) }) });
      searches += claims.searches;
      supported = [...supported.filter((c) => text.includes(c.sentence) && !claims.cut.some((x) => x.sentence === c.sentence)), ...claims.supported].filter(
        (c, i, all) => all.findIndex((x) => x.sentence === c.sentence) === i
      );
      draft = cutSentences(draft, claims.cut.map((c) => c.sentence));
      // Gates 1 and 4 and the template, by code.
      await phase("checking");
      const code = codeChecks(draft, sheet, { roster, allowedSentences: supported.map((c) => c.sentence), claimUrls: supported.map((c) => c.url) });
      const filled = draftTexts(draft).map(([k, v]) => [k, fill(v, sheet.facts)]);
      const links = await checkLinksLoad(filled.flatMap(([, v]) => urlsIn(v)), ctx.fetchImpl);
      failures = [...code.failures, ...links.problems.map((p) => `links-load: ${p}`)];
      if (claims.listedNotFound?.length) failures.push(...claims.listedNotFound.map((s) => `claims: an outside claim could not be located word for word, rewrite or remove it: "${s.slice(0, 120)}"`));
      const entry = { round, checks: [...code.checks, links], claims: { supported: claims.supported, cut: claims.cut, unchecked: Boolean(claims.unchecked) } };
      history.push(entry);
      if (claims.unchecked) failures.push("claims: no budget left to check outside claims");
      if (failures.length) {
        log(`round ${round}: ${failures.length} problem(s): ${failures.slice(0, 3).join("; ")}`);
        continue;
      }
      // Gate 3 and 4 again: the final review of topic, tone, naming and voice.
      if (g.left() < 1) {
        failures.push("review: no budget left for the final review");
        break;
      }
      const filledBody = fill(assembleBody(draft), sheet.facts);
      review = reviewCheck(await g.generate(buildReviewRequest(sheet, `# ${fill(draft.title, sheet.facts)}\n\n${fill(draft.subtitle, sheet.facts)}\n\n${filledBody}`)));
      entry.checks.push(review);
      if (!review.ok) {
        failures = review.problems.map((p) => `review: ${p}`);
        log(`round ${round}: the review failed: ${failures.slice(0, 3).join("; ")}`);
        continue;
      }
      passed = true;
      break;
    }
  } catch (e) {
    if (!(e instanceof ContentBudgetError) && !(e instanceof OutlineError)) {
      // Google busy: "deferred", so the same night (or "Write a draft now") may try the draft again later (pipeline/content/busy.mjs).
      const busy = isBusy(e);
      await recordRun(db, { night, now, step, mode, status: busy ? "deferred" : "failed", kind, gemini: g.used.n, tavily: searches, detail: { ...(busy ? { reason: "Google's AI was busy" } : {}), error: msg(e), history } });
      // What the draft spent before it stopped, for the job's totals (pipeline/content/manual.mjs).
      e.spent = { gemini: g.used.n, tavily: searches, imagesAi: 0 };
      throw e;
    }
    failures.push(msg(e));
  }

  const checks = { passed, rounds: history.length, history, failures: passed ? [] : failures };
  // A dropped draft keeps the image slots it proposed, for the owner's review.
  if (!passed && draft) checks.proposedImages = draft.images ?? [];
  if (!passed) {
    if (draft) await storePost(db, postOf({ id: postId, kind, sheet, draft, images: [], supported, checks, night, ctx, requests: g.used.n, status: "dropped" }), { mode, publishAt: null, now });
    await recordRun(db, { night, now, step, mode, status: "dropped", kind, postId: draft ? postId : null, gemini: g.used.n, tavily: searches, detail: { failures: failures.slice(0, 20) } });
    log(`dropped after ${history.length} round(s): ${failures.slice(0, 3).join("; ")}`);
    return { status: "dropped", postId: draft ? postId : null, requests: g.used.n, searches, aiImages: 0, failures };
  }

  // Stage 7: images.
  await phase("images");
  const body = assembleBody(draft);
  const img = await fillImages(draft.images ?? [], {
    sheet,
    body,
    filledBody: fill(body, sheet.facts),
    budget: { gemini: g.left() },
    ctx: {
      postId,
      env: ctx.content?.env ?? "local",
      db,
      now: ctx.now,
      fetchImpl: ctx.fetchImpl,
      keys: { pexels: ctx.content?.keys?.pexels },
      pexelsCap: pexelsCap(ctx.content?.pexelsMonthlySearches),
      ai: ctx.content?.ai ?? null,
      limits: aiLimits(ctx.content?.aiEnv ?? {}),
      store: ctx.content?.store ?? (async (key) => key),
      generate: g.generate,
      // The post's own tags also count when matching approved library images, so the writer prefers ones that fit the post.
      postTags: (draft.tags ?? []).map((t) => fill(t, sheet.facts)),
    },
  }).catch(async (e) => {
    if (e instanceof ContentBudgetError) return { images: [], dropped: (draft.images ?? []).map((i) => i.slot), requests: 0, aiImages: 0, pexels: 0, notes: [msg(e)], body };
    if (isBusy(e)) await recordRun(db, { night, now, step, mode, status: "deferred", kind, gemini: g.used.n, tavily: searches, detail: { reason: "Google's AI was busy", error: msg(e), history } });
    e.spent = { gemini: g.used.n, tavily: searches, imagesAi: 0 };
    throw e;
  });
  checks.images = img.notes;

  await phase("saving");
  // Stage 8: store (published at the next 08:00 Pacific in publish mode, else private).
  const publishAt = nextMorning(now);
  const post = postOf({ id: postId, kind, sheet, draft, body: img.body, images: img.images, supported, checks, night, ctx, requests: g.used.n });
  // Publishing automatically also needs a clean scorecard; a flagged post waits for the owner.
  // (ctx.flags.publishGate "none" turns the gate off; only tests that are about other caps use it.)
  const held = mode === "publish" && ctx.flags?.publishGate !== "none" ? scorecard(post).flags : [];
  if (held.length) post.checks = { ...post.checks, publishHeld: `kept for review: ${held.slice(0, 3).join("; ")}` };
  const stored = await storePost(db, post, { mode: held.length ? "dry-run" : mode, publishAt, now });
  await recordRun(db, { night, now, step, mode, status: "ok", kind, postId, gemini: g.used.n, tavily: searches, imagesAi: img.aiImages, detail: { stored: stored.status, capped: stored.capped, ...(held.length ? { held: held.slice(0, 3) } : {}), publishAt: iso(publishAt), images: img.images.map((i) => `${i.slot}:${i.kind}`), dropped: img.dropped, pexels: img.pexels, imageChecks: img.requests } });
  log(`${stored.status}${stored.capped ? " (held back by the weekly cap)" : ""} after ${history.length} round(s), ${g.used.n} request(s), ${img.images.length} image(s)`);
  return { status: "ok", postId, stored: stored.status, requests: g.used.n, searches, aiImages: img.aiImages };
}

/** The row storePost writes, from a draft (filled) and its checks. */
function postOf({ id, kind, sheet, draft, body, images, supported, checks, night, ctx, requests, status }) {
  const f = (t) => fill(t, sheet.facts);
  const title = f(draft.title);
  return {
    id,
    slug: slugify(title, id),
    kind,
    status,
    title,
    subtitle: f(draft.subtitle),
    altTitles: [f(draft.alt_title_a), f(draft.alt_title_b)],
    tags: (draft.tags ?? []).map(f),
    shareLine: f(draft.share_line),
    newsletterBlurb: f(draft.newsletter_blurb),
    aiLine: AI_LINE,
    aiNote: aiNote({ dataAsOf: sheet.dataAsOf, dataLink: sheet.dataLink }),
    // Portfolios link to their PortfolioRank page (lib/content/portfolio-links.mjs), after the checks loaded the sites themselves.
    body: linkPortfoliosToPages(linkSources(f(body ?? assembleBody(draft)), supported), (sheet.names ?? []).map((n) => n.url).filter(Boolean)),
    facts: sheet,
    checks,
    images: images.map((i) => ({ ...i, alt: f(i.alt) })),
    claims: supported,
    dataAsOf: sheet.dataAsOf,
    night,
    runId: ctx.runId ?? null,
    requests,
  };
}

/** The night's estimate of requests for tonight's content job. */
async function waiting(ctx) {
  const { job } = await contentJob(ctx);
  if (!job) return 0;
  return job.step === "pick" ? 1 : DRAFT_ESTIMATE;
}

/**
 * The "Content" stage handler (pipeline/night.mjs): the polls job first,
 * then the content job in a later batch, so a draft gets a whole batch.
 */
export const contentStage = {
  parkable: false,
  // Google busy on a draft: the night pauses and tries it again (pipeline/night.mjs, pipeline/content/busy.mjs).
  busyRetry: true,
  count: async (ctx) => (await pollsContent.count(ctx)) + (await waiting(ctx)),
  next: async (ctx, stage, n) => {
    if (!stage.pollsDone) {
      const polls = await pollsContent.next(ctx, stage, n);
      if (polls.length) return polls.map((i) => ({ ...i, part: "polls" }));
      stage.pollsDone = true;
    }
    const { job, mode, reason } = await contentJob(ctx, { done: stage.contentDone ?? [] });
    if (job) job.mode = mode;
    if (!job) {
      if (!stage.contentReason) {
        stage.contentReason = reason;
        ctx.log(`Content: no post work tonight: ${reason}`);
      }
      return [];
    }
    return [{ id: `content:${stage.night}:${job.step}`, part: "content", job }];
  },
  advance: (stage, item) => {
    if (item.part === "polls") stage.pollsDone = true;
    else stage.contentDone = [...(stage.contentDone ?? []), item.job.step];
  },
  run: async (ctx, gemini, item, stage, { left = 0 } = {}) => {
    if (item.part === "polls") return pollsContent.run(ctx, gemini, item, stage);
    // Tonight's mode from the owner's settings (never above CONTENT_MODE).
    const c = { ...ctx, night: stage.night, flags: { ...ctx.flags, contentMode: item.job.mode ?? "dry-run" } };
    if (item.job.step === "pick") {
      await runPick(c, gemini, { night: stage.night, budget: left });
      return "ok";
    }
    const topic = item.job.topic ?? null;
    const r = await runDraft(c, gemini, { kind: item.job.kind, night: stage.night, budget: left, ...(topic ? { focus: topic.topic } : {}) });
    if (topic && (r.status === "ok" || r.status === "dropped")) {
      await markTopicUsed(ctx.db, topic.id, { night: stage.night, postId: r.postId ?? null, status: r.status === "ok" ? "used" : "dropped", now: new Date(ctx.now()) });
    }
    return r.status === "ok" || r.status === "dropped" ? "ok" : "skipped";
  },
};

/**
 * The weekly owner summary (informed, not asked): on Sunday nights while
 * CONTENT_MODE is not "off", one owner alert of kind "info" with the last 7
 * days of content work. It holds only that night, so it is sent once a week.
 */
export async function contentSummaryConditions(db, { now, mode }) {
  if (mode === "off" || pacificParts(now).weekday !== PICK_NIGHT) return [];
  let rows;
  try {
    rows = (await db.execute({ sql: "SELECT * FROM content_runs WHERE at > ? ORDER BY id", args: [iso(now - 7 * 86400000)] })).rows;
  } catch (e) {
    if (/no such table/i.test(String(e?.message))) return [];
    throw e;
  }
  const parse = (v) => {
    try {
      return JSON.parse(String(v));
    } catch {
      return {};
    }
  };
  const drafts = rows.filter((r) => r.step === "draft" || r.step === "manual");
  const published = drafts.filter((r) => r.status === "ok" && parse(r.detail).stored === "published").length;
  const queued = drafts.filter((r) => r.status === "ok" && parse(r.detail).stored === "draft").length;
  const dropped = drafts.filter((r) => r.status === "dropped");
  const capped = drafts.filter((r) => parse(r.detail).capped).length;
  const gem = rows.reduce((a, r) => a + Number(r.gemini), 0);
  const tav = rows.reduce((a, r) => a + Number(r.tavily), 0);
  const ai = rows.reduce((a, r) => a + Number(r.images_ai), 0);
  const lines = [
    `Mode: ${mode}.`,
    `Published: ${published}. Private drafts: ${queued}. Dropped: ${dropped.length}.`,
    ...dropped.map((r) => `- ${r.kind} dropped on ${r.night}: ${(parse(r.detail).failures ?? []).slice(0, 3).join("; ")}`),
    `Gemini requests: ${gem}. Tavily searches: ${tav} of ${TAVILY_PER_WEEK}. Workers AI images: ${ai}.`,
    ...(capped ? [`${capped} post(s) held back by the 2-a-week publish cap.`] : []),
    "Review the drafts: /admin/blog.",
  ];
  return [{ key: "content-weekly", kind: "info", title: "PortfolioRank content: the week's summary", detail: lines.join("\n") }];
}
