import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { workerEnv } from "@/lib/grader/server";
import { cleanNotes, cleanTopic, createJob, finishJob, getJob, recentJobs } from "@/lib/content/jobs.mjs";
import { contentCosts } from "@/lib/content/costs.mjs";
import { BUILDERS } from "@/pipeline/content/facts.mjs";
import { newJobId } from "@/pipeline/content/manual.mjs";

// "Write a draft now" (docs/CONTENT-ENGINE.md, "Write a draft now"), only
// for the GitHub account in ADMIN_GITHUB_ID:
//   POST /api/admin/content/draft { topic?, kind? }            a new draft
//   POST /api/admin/content/draft { rewriteOf, notes }         "Rewrite with these notes"
//     -> 202 { job }; 400 (bad_request, or the cleaning message),
//        401, 403, 404 not_found (the draft to rewrite), 409
//        production_only, 429 daily_cap (5 a Pacific day), 503 no_workflow
//   GET  /api/admin/content/draft?id=<job>  -> { job }          the live status
//   GET  /api/admin/content/draft           -> { jobs, costs }  today's jobs and the cost panel
// The draft runs in the DraftWorkflow (worker/draft.ts); production only,
// where the Gemini key and the counters live. POSTs must come from this
// site with a JSON body (CSRF).
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers: PRIVATE });

type DraftBinding = { create(opts: { id: string; params: unknown }): Promise<unknown> };

export async function GET(req: Request) {
  const who = await requireAdmin();
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  await ensureSchema();
  const id = new URL(req.url).searchParams.get("id");
  if (id != null) {
    if (!/^[0-9a-f]{16}$/.test(id)) return fail("not_found", 404);
    const job = await getJob(db(), id);
    return job ? NextResponse.json({ job }, { headers: PRIVATE }) : fail("not_found", 404);
  }
  const client = db();
  const [jobs, costs] = await Promise.all([recentJobs(client, { limit: 10 }), contentCosts(client, { env: process.env, now: new Date() })]);
  return NextResponse.json({ jobs, costs }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  const body = (await req.json().catch(() => null)) as { topic?: unknown; kind?: unknown; rewriteOf?: unknown; notes?: unknown } | null;
  if (!body || typeof body !== "object") return fail("bad_request", 400);
  // Bounded before cleaning (lib/content/jobs.mjs does the rest).
  if ((body.topic != null && (typeof body.topic !== "string" || body.topic.length > 1000)) || (body.notes != null && (typeof body.notes !== "string" || body.notes.length > 5000))) return fail("bad_request", 400);
  const kind = body.kind == null || body.kind === "" ? null : typeof body.kind === "string" && Object.hasOwn(BUILDERS, body.kind) ? body.kind : undefined;
  if (kind === undefined) return fail("bad_request", 400);
  const topic = cleanTopic(body.topic);
  if (!topic.ok) return fail(topic.error, 400);
  let rewriteOf: string | null = null;
  let notes: string | null = null;
  if (body.rewriteOf != null) {
    if (typeof body.rewriteOf !== "string" || !/^[0-9a-f]{16}$/.test(body.rewriteOf)) return fail("bad_request", 400);
    const n = cleanNotes(body.notes);
    if (!n.ok) return fail(n.error, 400);
    rewriteOf = body.rewriteOf;
    notes = n.notes;
  }
  const env = (await workerEnv()) as Record<string, unknown>;
  if (String(env.SITE_ENV ?? "") !== "production") return fail("production_only", 409);
  const draft = env.DRAFT as DraftBinding | undefined;
  if (!draft) return fail("no_workflow", 503);
  await ensureSchema();
  const client = db();
  if (rewriteOf) {
    const src = await client.execute({ sql: "SELECT 1 FROM posts WHERE id = ?", args: [rewriteOf] });
    if (!src.rows.length) return fail("not_found", 404);
  }
  const id = newJobId();
  const made = await createJob(client, { id, kind, topic: topic.topic, rewriteOf, notes, by: `admin:${who.login}` });
  if ("error" in made) return fail("daily_cap", 429, { used: made.used });
  try {
    await draft.create({ id: `draft-${id}`, params: { jobId: id } });
  } catch (e) {
    await finishJob(client, id, { status: "failed", message: `The Workflow did not start: ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    return fail("workflow_failed", 502);
  }
  return NextResponse.json({ job: made.job }, { status: 202, headers: PRIVATE });
}
