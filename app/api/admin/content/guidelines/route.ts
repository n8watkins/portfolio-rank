import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdmin, requireAdminPost } from "@/lib/admin";
import { editGuidelines, listGuidelines, noteSuggestions } from "@/lib/content/guidelines.mjs";

// The editor's guidelines (docs/CONTENT-ENGINE.md, "Quality tools"), only
// for the GitHub account in ADMIN_GITHUB_ID; the page is /admin/blog/guidelines.
//   GET  /api/admin/content/guidelines -> { guidelines, suggestions }
//   POST /api/admin/content/guidelines { op: "add", text, fromPost? } | { op: "edit", id, text } | { op: "remove", id }
//     -> { guidelines }; 400 (bad_request, or the cleaning message), 401, 403, 404 not_found
// POSTs must come from this site with a JSON body (CSRF).
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: PRIVATE });

export async function GET() {
  const who = await requireAdmin();
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  await ensureSchema();
  const client = db();
  const [guidelines, suggestions] = await Promise.all([listGuidelines(client), noteSuggestions(client)]);
  return NextResponse.json({ guidelines, suggestions }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  const body = (await req.json().catch(() => null)) as { op?: unknown; id?: unknown; text?: unknown; fromPost?: unknown } | null;
  const op = typeof body?.op === "string" ? body.op : "";
  if (!["add", "edit", "remove"].includes(op)) return fail("bad_request", 400);
  if (op !== "add" && !Number.isInteger(body?.id)) return fail("bad_request", 400);
  if (op !== "remove" && (typeof body?.text !== "string" || body.text.length > 1000)) return fail("bad_request", 400);
  const fromPost = typeof body?.fromPost === "string" && /^[0-9a-f]{16}$/.test(body.fromPost) ? body.fromPost : null;
  await ensureSchema();
  const client = db();
  const out = await editGuidelines(client, { op, id: body?.id as number | undefined, text: body?.text, fromPost });
  if (!out.ok) return fail(out.error ?? "bad_request", out.error === "not_found" ? 404 : 400);
  return NextResponse.json({ guidelines: await listGuidelines(client) }, { headers: PRIVATE });
}
