import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { editQueueItem, queueItems } from "@/lib/content/library.mjs";

// The image queue (docs/CONTENT-ENGINE.md, "The image library"): the subjects
// that have no image yet, with the owner's edits, and the owner's way to edit
// or skip one before it is made. Only for the GitHub account in ADMIN_GITHUB_ID.
//   GET  /api/admin/library/queue -> { items: [{ theme, themeLabel, index, subject, original, edited, skipped, prompt }] }
//   POST /api/admin/library/queue { theme, index, op: "edit" | "skip" | "unskip" | "reset", subject? }
//     -> { ok: true }; 400 bad_request (or the message for a subject that is too
//        short or too long), 401, 403, 409 already_made
// POSTs must come from this site with a JSON body (CSRF).
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: PRIVATE });

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  await ensureSchema();
  return NextResponse.json({ items: await queueItems(db()) }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  let body: { theme?: unknown; index?: unknown; op?: unknown; subject?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const { theme, index, op, subject } = body ?? {};
  if (typeof theme !== "string" || theme.length > 60 || !Number.isInteger(index) || typeof op !== "string") return fail("bad_request", 400);
  if (subject != null && (typeof subject !== "string" || subject.length > 2000)) return fail("bad_request", 400);
  await ensureSchema();
  const out = await editQueueItem(db(), { theme, index: index as number, op, subject: subject as string | undefined });
  if (!out.ok) return fail(out.error ?? "bad_request", out.error === "already_made" ? 409 : 400);
  return NextResponse.json({ ok: true }, { headers: PRIVATE });
}
