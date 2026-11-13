// The owner's goals (pipeline/goals.mjs, lib/goals/config.mjs), on the
// Monday-morning Cron Trigger ("0 16 * * 1", worker/index.ts): measures last
// week, records progress, and emails the owner once when a goal is reached.
// Plain code, no Gemini.
import * as Sentry from "@sentry/cloudflare";
import { db as database } from "../lib/db";
import { emailSender } from "../pipeline/alerts.mjs";
import { checkGoals } from "../pipeline/goals.mjs";
import type { NightEnv } from "./night";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function goalsTick(env: NightEnv & { KIT_API_KEY?: string }, scheduledTime: number) {
  const db = database();
  try {
    const r = await checkGoals(
      { db, email: emailSender(env, { db }), to: env.OWNER_EMAIL ?? null, siteUrl: String(env.SITE_URL ?? ""), kitApiKey: env.KIT_API_KEY ?? null, log: (line: string) => log("goals.log", { line }) },
      { now: new Date(scheduledTime) }
    );
    log("goals.tick", { week: r.week, goals: r.goals.map((g) => ({ id: g.id, reached: g.reached, fired: g.fired, error: g.error ?? null })) });
    return r;
  } catch (e) {
    // Never fails the weekly cron's other work; next Monday tries again.
    Sentry.captureException(e);
    log("goals.tick.failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return null;
  }
}
