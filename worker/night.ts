// The end-of-day run on Cloudflare (owner decisions 2026-11-10; AUTOMATION.md
// "End of day"). GitHub's schedule starts jobs 4 to 10 hours late, so the
// clock is the Worker's Cron Trigger:
//
//   cron 03:30 and 04:30 UTC  ->  scheduled() starts tonight's Workflow only
//                                 when it is 20:30 in Los Angeles (one of the
//                                 two crons matches, whatever the DST state)
//   EndOfDayWorkflow (NIGHT)  ->  1. the free checks: starts sync-upstream.yml
//                                    on GitHub Actions (feed, capture of new
//                                    sites, a re-capture of the oldest ones,
//                                    page evidence, fingerprint changes) and,
//                                    on Sundays, health.yml; waits for the
//                                    first until 21:15 at the latest
//                                 2. the AI stages, one batch per step, paced
//                                    (pipeline/night.mjs)
//                                 3. the summary in night_runs
//
// The instance id is "night-<Pacific date>", so a night runs at most once;
// night_runs makes sure of it too. Nothing here calls Gemini outside the
// batches, and every step is safe to run again.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createClient } from "@libsql/client";
import { budgetPlan, isNightStart, nightTimeline, pacificParts } from "../pipeline/budget.mjs";
import { dailyQuota } from "../pipeline/gemini-log.mjs";
import { DEFAULT_RPM } from "../pipeline/gemini.mjs";
import { dispatchWorkflow, workflowRun } from "../pipeline/github-dispatch.mjs";
import { finishNight, planNight, runBatch, startNight } from "../pipeline/night.mjs";
import { rankingConfig } from "../lib/ranking/config.mjs";
import { emailSender, nightConditions, reconcileAlerts, tractionConditions, tractionLevels } from "../pipeline/alerts.mjs";
import { drainPeopleQueue } from "../pipeline/people.mjs";

/** The bindings and vars from wrangler.jsonc plus the Worker secrets this file reads. */
export type NightEnv = CloudflareEnv & {
  // Secrets (wrangler secret put).
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  GEMINI_API_KEY?: string;
  GITHUB_DISPATCH_TOKEN?: string;
  // Optional vars: the defaults in code apply when they are absent.
  GEMINI_BUDGET?: string;
  GEMINI_DAILY_QUOTA?: string;
  RANKING_BUDGET?: string;
  RANKING_BATCHED_COUNTS?: string;
  RANKING_AI_WEIGHT?: string;
  ALERT_TRACTION?: string;
  // Where owner alerts go, once an email provider is set up.
  OWNER_EMAIL?: string;
};

type NightParams = { trigger: "cron" | "manual"; scheduledTime?: number };
// The engine's state is plain JSON; the Workflow only passes it on.
type NightState = { skip?: boolean; reason?: string; done?: boolean; night: string; timeline: ReturnType<typeof nightTimeline>; checks: unknown } & Record<string, unknown>;

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The hourly Cron Trigger that finishes queued people's requests (wrangler.jsonc). */
export const PEOPLE_QUEUE_CRON = "15 * * * *";
const CHECKS_POLL = "1 minute";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

function engine(env: NightEnv, runId: string) {
  if (!env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is not set");
  const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  const plan = budgetPlan(env.GEMINI_BUDGET);
  return {
    db,
    apiKey: env.GEMINI_API_KEY,
    plan,
    quota: dailyQuota(env.GEMINI_DAILY_QUOTA),
    rpm: Number(env.GEMINI_RPM) || DEFAULT_RPM,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    log: (line: string) => log("night.log", { line }),
    fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
    // The hero screenshot from the SHOTS bucket, as an inline image part.
    image: async (shotKey: string) => {
      try {
        const obj = await env.SHOTS.get(`${shotKey}/hero.jpg`);
        if (!obj) return "missing";
        if (obj.size > IMAGE_MAX_BYTES) return null;
        const data = Buffer.from(await obj.arrayBuffer()).toString("base64");
        return { inline_data: { mime_type: "image/jpeg", data } };
      } catch {
        return null;
      }
    },
    flags: {
      rankingV2: /^true$/i.test(String(env.RANKING_V2 ?? "")),
      rubricRegrade: /^true$/i.test(String(env.RUBRIC_REGRADE ?? "")),
      ranking: rankingConfig({
        RANKING_V2: env.RANKING_V2,
        RANKING_BUDGET: env.RANKING_BUDGET,
        RANKING_BATCHED_COUNTS: env.RANKING_BATCHED_COUNTS,
        RANKING_AI_WEIGHT: env.RANKING_AI_WEIGHT,
      }),
    },
    // Owner alerts and people's "your grade is ready": off until an email
    // provider is chosen (pipeline/alerts.mjs emailSender).
    email: emailSender(env),
    runId,
  };
}

// Batches never throw (pipeline/night.mjs ends the run instead); a step that
// fails for another reason (the platform) is tried once more. The engine's
// steps are idempotent.
const ONCE_MORE = { retries: { limit: 1, delay: "1 minute", backoff: "constant" as const }, timeout: "20 minutes" };
const MAX_BATCHES = 1500;

export class EndOfDayWorkflow extends WorkflowEntrypoint<NightEnv, NightParams> {
  async run(event: WorkflowEvent<NightParams>, step: WorkflowStep) {
    const runId = event.instanceId;
    // Without the key there is nothing to run, and the night stays unclaimed
    // (the GitHub fallback grades instead; AUTOMATION.md).
    if (!this.env.GEMINI_API_KEY) {
      const reason = "GEMINI_API_KEY is not set on the Worker: tonight's end-of-day run is skipped (the GitHub schedule of sync-upstream.yml is the fallback)";
      log("night.skip", { reason });
      return { skipped: reason };
    }
    let state = (await step.do("claim the night", ONCE_MORE, () => startNight(engine(this.env, runId), { trigger: event.payload.trigger }))) as NightState;
    if (state.skip) {
      log("night.skip", { reason: state.reason });
      return { skipped: state.reason };
    }

    // 1. The free checks on GitHub Actions, before any Gemini work.
    const checks = await step.do("start the free checks", ONCE_MORE, async () => {
      // The weekly health check starts with Sunday's run.
      const sunday = pacificParts(Date.parse(String(state.startedAt))).weekday === 0;
      const nightly = await dispatchWorkflow({
        token: this.env.GITHUB_DISPATCH_TOKEN,
        workflow: "sync-upstream.yml",
        inputs: { refresh: String(this.env.NIGHTLY_REFRESH ?? "150"), rubric_regrade: String(this.env.RUBRIC_REGRADE ?? "false") },
        log: (line) => log("night.checks", { line }),
      });
      const health = sunday
        ? await dispatchWorkflow({ token: this.env.GITHUB_DISPATCH_TOKEN, workflow: "health.yml", log: (line) => log("night.checks", { line }) })
        : null;
      return { nightly, health };
    });
    let checksSummary: string;
    if ("skipped" in checks.nightly) {
      checksSummary = String(checks.nightly.skipped);
    } else if (checks.nightly.runId) {
      const runIdGh = checks.nightly.runId;
      let last: { status: string; conclusion: string | null; url: string | null; now: number } = { status: "queued", conclusion: null, url: checks.nightly.url, now: Date.now() };
      for (let i = 0; i < 120; i++) {
        last = await step.do(`check on the free checks ${i}`, ONCE_MORE, async () => ({
          ...(await workflowRun({ token: this.env.GITHUB_DISPATCH_TOKEN, runId: runIdGh })),
          now: Date.now(),
        }));
        if (last.status === "completed" || last.now >= Date.parse(state.timeline.checksDeadline)) break;
        await step.sleep(`wait for the free checks ${i}`, CHECKS_POLL);
      }
      checksSummary =
        last.status === "completed"
          ? `sync-upstream.yml finished (${last.conclusion}) ${last.url ?? ""}`.trim()
          : `sync-upstream.yml still ${last.status} at the deadline; the AI stages start without waiting ${last.url ?? ""}`.trim();
    } else {
      checksSummary = "sync-upstream.yml started (GitHub gave no run id, so the AI stages did not wait for it)";
    }
    if (checks.health && "skipped" in checks.health) checksSummary += `; health.yml: ${checks.health.skipped}`;
    else if (checks.health) checksSummary += `; health.yml started (Sunday) ${checks.health.url ?? ""}`.trimEnd();
    state = { ...state, checks: { summary: checksSummary, nightly: checks.nightly, health: checks.health } };

    // 2. The AI stages.
    state = (await step.do("plan the AI work", ONCE_MORE, () => planNight(engine(this.env, runId), state))) as NightState;
    for (let i = 0; i < MAX_BATCHES && !state.done; i++) {
      const r = (await step.do(`batch ${i}`, ONCE_MORE, () => runBatch(engine(this.env, runId), state))) as { state: NightState; pauseMs?: number };
      state = r.state;
      if (r.pauseMs) await step.sleep(`people are grading, pause ${i}`, r.pauseMs);
    }

    // 3. The summary, then the owner alerts (one email per condition per
    // day while it holds).
    const done = await step.do("write the summary", ONCE_MORE, async () => {
      const { status, summary } = await finishNight(engine(this.env, runId), state);
      return {
        status,
        stopped: summary.stopped,
        requests: summary.actual.requests,
        estimate: summary.estimate?.requests ?? 0,
        night: summary.night,
        quotaLeft: summary.estimate?.quotaLeft ?? null,
        stages: summary.stages.map((x: { key: string; label: string; result: string }) => ({ key: x.key, label: x.label, result: x.result })),
        parked: summary.parked,
      };
    });
    await step.do("owner alerts", ONCE_MORE, async () => {
      const ctx = engine(this.env, runId);
      const night = { night: done.night, estimate: done.quotaLeft == null ? null : { quotaLeft: done.quotaLeft }, stages: done.stages, parked: done.parked };
      const conditions = [...nightConditions(night, ctx.plan), ...(await tractionConditions(ctx.db, { now: new Date(Date.parse(String(state.startedAt))), levels: tractionLevels(this.env.ALERT_TRACTION) }))];
      const r = await reconcileAlerts(ctx.db, { conditions, email: ctx.email, to: this.env.OWNER_EMAIL ?? null, log: ctx.log });
      log("night.alerts", r);
      return r;
    });
    log("night.done", { night: state.night, status: done.status, stopped: done.stopped, requests: done.requests, estimate: done.estimate });
    return { status: done.status, stopped: done.stopped, requests: done.requests, estimate: done.estimate };
  }
}

/**
 * The hourly cron: finishes people's grade requests that waited for 3.5
 * (busy, or the quota was spent), while there is quota for people.
 */
export async function drainPeople(env: NightEnv) {
  if (!env.GEMINI_API_KEY) return { done: 0, queued: 0, failed: 0 };
  const ctx = engine(env, "people-queue");
  const r = await drainPeopleQueue(ctx, { limit: 10 });
  if (r.done || r.failed || r.queued) log("people.queue", r);
  return r;
}

/**
 * The Cron Trigger (wrangler.jsonc triggers.crons): starts tonight's
 * Workflow when this firing is 20:30 Pacific; the other DST offset's firing
 * does nothing.
 */
export async function startTonight(scheduledTime: number, env: NightEnv) {
  const plan = budgetPlan(env.GEMINI_BUDGET);
  const t = isNightStart(scheduledTime, plan);
  if (!t.start) {
    log("night.cron.skip", { scheduledTime: new Date(scheduledTime).toISOString(), pacific: t.local, reason: "not the start time in Pacific time (this cron covers the other DST offset)" });
    return { started: false, night: t.night };
  }
  const id = `night-${t.night}`;
  try {
    await env.NIGHT.create({ id, params: { trigger: "cron", scheduledTime } satisfies NightParams });
    log("night.cron.start", { id, scheduledTime: new Date(scheduledTime).toISOString() });
    return { started: true, night: t.night, id };
  } catch (e) {
    // An instance with tonight's id exists: tonight already ran or is running.
    log("night.cron.exists", { id, error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { started: false, night: t.night, id };
  }
}
