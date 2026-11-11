import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { workerEnv } from "@/lib/grader/server";
import { MAX_MANUAL, runLibraryBatch } from "@/pipeline/content/library-stage.mjs";
import { withGateway } from "@/lib/ai-gateway.mjs";

// One manual batch of library images, for when the owner doesn't want to
// wait for the next hourly tick (docs/CONTENT-ENGINE.md, "The image
// library"): the same work for at most 2 queue items, through the AI Gateway,
// with the same limits (pipeline/content/library-stage.mjs runLibraryBatch:
// 40 a UTC day, 2 a rolling hour, quiet from 20:00 to midnight Pacific).
//   POST /api/admin/library/generate { count?: 1..2 }
//     -> { made: [{ id, status }], stopped? }; 400, 401, 403,
//        409 production_only | off (with why), 429 no_gemini_budget,
//        503 no_ai | no_gemini_key
// Production only: the neuron counter lives in each environment's database,
// and only production's guards the account (staging's ceiling is 0).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status, headers: PRIVATE });

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return fail(who.error, adminErrorStatus(who.error));
  let body: { count?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const count = body?.count == null ? MAX_MANUAL : Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_MANUAL) return fail("bad_request", 400);
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
  const out = await runLibraryBatch({ db: db(), env, ai: withGateway(env.AI), store, apiKey, runId: `manual:${who.login}`, count });
  if (out.error === "off") return NextResponse.json(out, { status: 409, headers: PRIVATE });
  if (out.error) return fail(out.error, 429);
  return NextResponse.json(out, { headers: PRIVATE });
}
