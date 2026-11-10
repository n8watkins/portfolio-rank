import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { openLinkToken } from "@/lib/grader/links.mjs";
import { PRIVATE, addOwnedJob, authSecret, disabled, graderEnabled } from "@/lib/grader/server";

// The one-time link from a report email.
//
// GET /api/grade/link?t=<token> -> 303 to /grade/<id>. The first open makes
// this browser the report's owner (the pr_grades cookie); a used or expired
// link still leads to the report (reports are shareable by their link) with
// ?link=used or ?link=expired, and grants nothing. A forged token -> 303 to
// /grade?link=bad.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!graderEnabled()) return disabled();
  const token = new URL(req.url).searchParams.get("t") ?? "";
  await ensureSchema();
  const r = await openLinkToken(db(), token.slice(0, 1024), { secret: authSecret() });
  const to = (path: string) => NextResponse.redirect(new URL(path, req.url), { status: 303, headers: { ...PRIVATE, "referrer-policy": "no-referrer" } });
  if (r.ok) {
    await addOwnedJob(r.jobId);
    return to(`/grade/${r.jobId}`);
  }
  if (r.jobId) return to(`/grade/${r.jobId}?link=${r.error}`);
  return to("/grade?link=bad");
}
