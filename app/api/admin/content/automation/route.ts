import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { addTopic, automationView, removeTopic, saveAutomation } from "@/lib/content/automation.mjs";

// The blog's automation (lib/content/automation.mjs), for the GitHub account
// in ADMIN_GITHUB_ID only; the panel is on /admin/blog.
//   GET  /api/admin/content/automation -> the panel's view
//   POST /api/admin/content/automation
//        { op: "save", settings: { enabled, mode, days, perWeek } }
//        { op: "add-topic", topic } | { op: "remove-topic", id }
//     -> the panel's view; 400 with a plain message when a change is refused
//        (above the config's ceiling, a bad topic), 401, 403
// POSTs must come from this site with a JSON body (CSRF).
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number, message?: string) => NextResponse.json({ error, ...(message ? { message } : {}) }, { status, headers: PRIVATE });
const env = () => ({ CONTENT_MODE: process.env.CONTENT_MODE, CONTENT_DRAFTS_PER_WEEK: process.env.CONTENT_DRAFTS_PER_WEEK });

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  await ensureSchema();
  return NextResponse.json(await automationView(db(), env()), { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  const body = (await req.json().catch(() => null)) as { op?: unknown; settings?: unknown; topic?: unknown; id?: unknown } | null;
  await ensureSchema();
  const client = db();
  if (body?.op === "save") {
    const out = await saveAutomation(client, body.settings, { env: env(), by: who.login });
    if ("error" in out && out.error) return fail("refused", 400, out.error);
  } else if (body?.op === "add-topic") {
    if (typeof body.topic !== "string" || body.topic.length > 1000) return fail("bad_request", 400);
    const out = await addTopic(client, body.topic, { by: who.login });
    if ("error" in out && out.error) return fail("refused", 400, out.error);
  } else if (body?.op === "remove-topic") {
    if (!Number.isInteger(body.id)) return fail("bad_request", 400);
    if (!(await removeTopic(client, body.id as number))) return fail("not_found", 404, "That topic was already used or removed.");
  } else return fail("bad_request", 400);
  return NextResponse.json(await automationView(client, env()), { headers: PRIVATE });
}
