// "Write a draft now" on Cloudflare (docs/CONTENT-ENGINE.md, "Write a draft
// now"): the owner's draft runs as a Workflow (wrangler.jsonc workflows,
// binding DRAFT), so it may take the minutes a draft needs after the page's
// request has returned. The page polls the job's row for its live status.
//
//   params { jobId }          a job the admin API queued (lib/content/jobs.mjs)
//   params { topic?, kind? }  queue one here first, with the same daily cap:
//                             the owner-only path from the command line,
//                             `wrangler workflows trigger portfolio-rank-draft`
//                             (only someone with the account's API token can)
//
// One step, never retried (a retry would spend the caps twice); the job's
// row says how it ended either way.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { engine, type NightEnv } from "./night";
import { cleanTopic, createJob } from "../lib/content/jobs.mjs";
import { BUILDERS } from "../pipeline/content/facts.mjs";
import { newJobId, runManualJob } from "../pipeline/content/manual.mjs";

type DraftParams = { jobId?: string; topic?: string; kind?: string };

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }));
const ONCE = { retries: { limit: 0, delay: "1 second", backoff: "constant" as const }, timeout: "15 minutes" };

export class DraftWorkflow extends WorkflowEntrypoint<NightEnv, DraftParams> {
  async run(event: WorkflowEvent<DraftParams>, step: WorkflowStep) {
    const p = event.payload ?? {};
    const jobId = await step.do("queue the job", ONCE, async () => {
      if (p.jobId) return /^[0-9a-f]{16}$/.test(p.jobId) ? p.jobId : null;
      const t = cleanTopic(p.topic);
      if (!t.ok) return null;
      const kind = p.kind && Object.hasOwn(BUILDERS, p.kind) ? p.kind : null;
      const id = newJobId();
      const r = await createJob(engine(this.env, `draft:${id}`).db, { id, kind, topic: t.topic, by: "owner:wrangler" });
      if ("error" in r) {
        log("draft.capped", { used: r.used });
        return null;
      }
      return id;
    });
    if (!jobId) return { skipped: "no job (a bad id or topic, or the day's 5 drafts are used)" };
    const out = await step.do("write the draft", ONCE, async () => {
      const ctx = { ...engine(this.env, `draft:${jobId}`), env: this.env as unknown as Record<string, unknown> };
      const job = await runManualJob(ctx, jobId);
      return { status: job?.status ?? "missing", postId: job?.postId ?? null, message: job?.message ?? null };
    });
    log("draft.done", { jobId, ...out });
    return { jobId, ...out };
  }
}
