import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { workerEnv } from "@/lib/grader/server";
import { MAX_MANUAL, runLibraryBatch } from "@/pipeline/content/library-stage.mjs";
import { withGateway } from "@/lib/ai-gateway.mjs";

// One manual batch of library images, for when the owner doesn't want to
// wait for the next hourly tick (docs/CONTENT-ENGINE.md, "The image
// library"): the same work for queue items (within what is left of the
// day), or one image from the owner's own subject, through the AI Gateway,
// with the same limits (pipeline/content/library-stage.mjs runLibraryBatch:
// every call reserved first against 40 a UTC day and 2,500 neurons, quiet
// from 20:00 to midnight Pacific).
//   POST /api/admin/library/generate { count?: 1..40, custom?: { subject, theme? } }
//     -> { made: [{ id, status }], reason?, nextAt?, stopped?, usage }; 400
//        (bad_request, or bad_subject with the message in stopped), 401, 403,
//        409 production_only | off (with why), 429 no_room | no_gemini_budget
//        (reason says which limit; the body is the same shape), 503 no_ai |
//        no_gemini_key
// Production only: the neuron counter lives in each environment's database,
// and only production's guards the account (staging's ceiling is 0).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: PRIVATE });

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  let body: { count?: unknown; custom?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  let custom: { subject: string; theme?: string } | null = null;
  if (body?.custom != null) {
    const c = body.custom as { subject?: unknown; theme?: unknown };
    // Bounded before cleaning (lib/content/library.mjs cleanSubject does the rest).
    if (typeof c !== "object" || typeof c.subject !== "string" || c.subject.length > 2000 || (c.theme != null && (typeof c.theme !== "string" || c.theme.length > 60))) return fail("bad_request", 400);
    custom = { subject: c.subject, theme: typeof c.theme === "string" ? c.theme : undefined };
  }
  const count = body?.count == null ? (custom ? 1 : 2) : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_MANUAL || (custom && count !== 1)) return fail("bad_request", 400);
  const env = (await workerEnv()) as Record<string, unknown>;
  if (String(env.SITE_ENV ?? "") !== "production") return fail("production_only", 409);
  if (!env.AI) return fail("no_ai", 503);
  const apiKey = String(env.GEMINI_API_KEY ?? "");
  if (!apiKey) return fail("no_gemini_key", 503);
  await ensureSchema();
  const bucket = env.SHOTS as CloudflareEnv["SHOTS"];
  const store = async (key: string, bytes: Uint8Array, contentType: string) => {
    await bucket.put(key, bytes, { httpMetadata: { contentType } });
    return key;
  };
  const out = await runLibraryBatch({ db: db(), env, ai: withGateway(env.AI), store, apiKey, runId: `manual:${who.login}`, count, custom });
  if (out.error === "off") return NextResponse.json(out, { status: 409, headers: PRIVATE });
  if (out.error === "bad_subject") return NextResponse.json(out, { status: 400, headers: PRIVATE });
  // A refusal keeps the whole answer (reason, nextAt, usage): the page words it for the owner.
  if (out.error) return NextResponse.json(out, { status: 429, headers: PRIVATE });
  return NextResponse.json(out, { headers: PRIVATE });
}
