import { db, ensureSchema } from "@/lib/db";
import { JOB_ID, readJob } from "@/lib/grader/jobs.mjs";
import { disabled, fail, graderEnabled, readGradeShot } from "@/lib/grader/server";

// A grade's screenshots (hero.jpg, mobile.jpg). They sit under a private
// prefix of the SHOTS bucket (private/grades/<id>/) that the public /shots
// route never serves; only someone with the report's link gets them, never
// from a shared cache.
export const dynamic = "force-dynamic";

const FILES = new Set(["hero.jpg", "mobile.jpg"]);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  if (!graderEnabled()) return disabled();
  const { id, file } = await params;
  if (!JOB_ID.test(id) || !FILES.has(file)) return fail("not_found", 404);
  await ensureSchema();
  const job = await readJob(db(), id);
  if (!job?.shot_key || !job.captured_at) return fail("not_found", 404);
  const bytes = await readGradeShot(String(job.shot_key), file as "hero.jpg" | "mobile.jpg");
  if (!bytes) return fail("not_found", 404);
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, max-age=3600",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}
