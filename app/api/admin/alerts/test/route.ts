import { NextResponse } from "next/server";
import { db, ensureSchema } from "@/lib/db";
import { adminErrorStatus, requireAdminPost } from "@/lib/admin";
import { workerEnv } from "@/lib/grader/server";
import { emailSender } from "@/pipeline/alerts.mjs";

// A test owner alert, to check end to end that alerts reach the owner: one
// email through the same path every owner alert takes (pipeline/alerts.mjs
// emailSender: the shared email gate, kind "owner-alert", counted in
// email_sends, from EMAIL_FROM through the send_email binding to
// OWNER_EMAIL). Nothing is recorded in owner_alerts.
//   POST /api/admin/alerts/test {}  (from the signed-in admin's browser, e.g.
//     fetch("/api/admin/alerts/test", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
//     -> 200 { sent: true } | 503 { error: "no_sender", missing: [...] } |
//        502 { error: "not_sent", reason } (the gate's reason: a cap,
//        no_transport, bad_address or the provider's error) | 401 | 403
export const dynamic = "force-dynamic";

const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

export async function POST(req: Request) {
  const who = await requireAdminPost(req);
  if ("error" in who) return NextResponse.json({ error: who.error }, { status: adminErrorStatus(who.error), headers: PRIVATE });
  await ensureSchema();
  const env = (await workerEnv()) as Record<string, unknown>;
  const sender = emailSender(env, { db: db() });
  if (!sender) {
    const missing = ["OWNER_EMAIL", "EMAIL_FROM", "SEND_EMAIL"].filter((k) => !env[k]);
    return NextResponse.json({ error: "no_sender", missing }, { status: 503, headers: PRIVATE });
  }
  try {
    await sender.send({
      to: String(env.OWNER_EMAIL),
      subject: "Test: PortfolioRank site alerts (Cloudflare Email Service)",
      text: `Test: PortfolioRank site alerts (Cloudflare Email Service).\n\nThis is a test owner alert, sent at ${new Date().toISOString()} by ${who.login} from /admin/alerts.\n\nReal alerts (a missed or stuck end-of-day run, a stopped stage, email caps, held removals, model changes) arrive the same way, once a day while they hold.`,
    });
  } catch (e) {
    return NextResponse.json({ error: "not_sent", reason: String((e as Error)?.message ?? e).slice(0, 200) }, { status: 502, headers: PRIVATE });
  }
  return NextResponse.json({ sent: true }, { headers: PRIVATE });
}
