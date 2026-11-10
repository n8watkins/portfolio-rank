// Model watch on Cloudflare (AUTOMATION.md "Model watch"): a weekly Cron
// Trigger reads Google's model list, deprecations page and release notes,
// compares them with last week's snapshot and records the report as owner
// alerts (pipeline/model-watch.mjs). It calls no Gemini model, spends no
// generate quota and changes no setting.
import { db as database } from "../lib/db";
import { emailSender, reconcileAlerts } from "../pipeline/alerts.mjs";
import { isModelWatchAlert, runModelWatch } from "../pipeline/model-watch.mjs";
import type { NightEnv } from "./night";

/** Mondays 16:00 UTC (08:00 or 09:00 Pacific), wrangler.jsonc triggers.crons. */
export const MODEL_WATCH_CRON = "0 16 * * 1";

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));

export async function watchModels(env: NightEnv, now = new Date()) {
  const db = database();
  const email = emailSender(env);
  const r = await runModelWatch({
    db,
    apiKey: env.GEMINI_API_KEY,
    now,
    log: (line: string) => log("model-watch.report", { line }),
    // Only the model-watch alerts are in scope here, so a week without a
    // change clears last week's report and never touches the night's alerts.
    reconcile: (conditions: { key: string; kind: string; title: string; detail?: string }[]) =>
      reconcileAlerts(db, { conditions, scope: isModelWatchAlert, now, email, to: env.OWNER_EMAIL ?? null, log: (line: string) => log("model-watch.alert", { line }) }),
  });
  log("model-watch.done", { status: r.status, changes: r.report.changes, baseline: r.report.baseline, alerts: r.alerts });
  return r;
}
