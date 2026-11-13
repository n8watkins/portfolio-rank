import { db, ensureSchema } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";
import { verifyTurnstile } from "@/lib/turnstile";
import { normalizeGradeUrl } from "@/lib/grader/url.mjs";
import { validOwnKey } from "@/lib/grader/own-key.mjs";
import { startGrade } from "@/lib/grader/start";
import { disabled, fail, graderEnabled, readJsonBody, requester, sameOrigin } from "@/lib/grader/server";

// "Grade my portfolio": start a grade (AUTOMATION.md "Grade my portfolio").
//
// POST /api/grade { url, turnstileToken?, geminiKey? }
//   202 { id, status, ...the job (GET /api/grade/<id>) }: the free checks are
//       done and in the answer; the screenshot and AI grade run on GitHub
//       Actions ("capturing"), wait for a later day ("waiting", past today's
//       share; the report is emailed), or can't start ("unavailable", no
//       dispatch token)
//   400 bad_request | <address error> (with a message) | own_key_invalid |
//       own_key_rejected
//   403 bad_origin | turnstile_failed
//   404 not_found (the feature is off: GRADER_ENABLED)
//   409 in_progress | cooldown { nextAt, report? (only for its owner) }
//   422 <page error> { checks }: the page can't be graded (unreachable, an
//       HTTP error, parked, not a web page); nothing is counted
//   429 rate_limited (Retry-After) | daily_limit { scope, resetAt }
//   503 busy: too many requests already wait for a later day
//
// geminiKey (optional) is the visitor's own Gemini key: checked here with a
// free metadata call, never stored or logged; the grade then waits for the
// browser to send it once more (POST /api/grade/<id>/finish).
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
/** Attempts (valid or not) per visitor and per IP an hour, before any work is done. */
const ATTEMPTS_PER_HOUR = { visitor: 20, ip: 60 };

export async function POST(req: Request) {
  if (!graderEnabled()) return disabled();
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const body = await readJsonBody(req);
  if (!body) return fail("bad_request", 400);
  const target = normalizeGradeUrl(body.url);
  if (!target.ok) return fail(target.error, 400, { message: target.message });
  const geminiKey = typeof body.geminiKey === "string" && body.geminiKey.trim() ? body.geminiKey.trim() : null;
  if (geminiKey !== null && !validOwnKey(geminiKey)) return fail("own_key_invalid", 400, { message: "That doesn't look like a Gemini API key." });

  await ensureSchema();
  const client = db();
  const who = await requester(req);
  const now = Date.now();
  const limits = [rateLimit(client, `grade:v:${who.visitor}`, { limit: ATTEMPTS_PER_HOUR.visitor, windowMs: HOUR, now })];
  if (who.ip) limits.push(rateLimit(client, `grade:ip:${who.network}`, { limit: ATTEMPTS_PER_HOUR.ip, windowMs: HOUR, now }));
  const over = (await Promise.all(limits)).find((h) => !h.ok);
  if (over) return fail("rate_limited", 429, {}, { "retry-after": String(over.retryAfterSec) });

  if ((await verifyTurnstile(body.turnstileToken, who.ip, { action: "grade" })) === "failed") return fail("turnstile_failed", 403);

  return startGrade(client, { who, target, geminiKey, now });
}
