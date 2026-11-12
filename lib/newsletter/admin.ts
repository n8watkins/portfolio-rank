import { emailGate, workerEnv } from "@/lib/grader/server";
import { postFromRow } from "@/lib/content/store.mjs";
import { validEmail } from "@/lib/email/gate.mjs";
import { emailForPost } from "@/lib/newsletter/send.mjs";
import { siteBase } from "@/lib/newsletter/server";

// The admin's "Send test to me" (app/admin/(tools)/blog/newsletter): the
// latest live post's newsletter email, marked as a test, to the owner's
// address from OWNER_EMAIL (the same Worker variable or secret the owner
// alerts use; never written in code). It goes through the same gate and
// mailroom app as the real emails, so it counts against the same caps.

/** The owner's address for tests, or null when OWNER_EMAIL isn't set. */
export async function ownerEmail(): Promise<string | null> {
  const env = await workerEnv();
  return validEmail(String(env.OWNER_EMAIL ?? "")) ?? null;
}

/** The post a test shows: the newest live post, else the newest post of any kind. */
async function samplePost(db: { execute: (q: { sql: string; args: unknown[] } | string) => Promise<{ rows: Record<string, unknown>[] }> }) {
  const now = new Date().toISOString();
  const live = (await db.execute({ sql: "SELECT * FROM posts WHERE status = 'published' AND publish_at <= ? ORDER BY publish_at DESC LIMIT 1", args: [now] })).rows[0];
  const any = live ?? (await db.execute({ sql: "SELECT * FROM posts ORDER BY created_at DESC LIMIT 1", args: [] })).rows[0];
  return any ? postFromRow(any) : null;
}

export async function sendTestEmail(db: Parameters<typeof samplePost>[0]): Promise<{ ok: true; to: string; post: string } | { ok: false; error: "no_owner_email" | "no_post" | string }> {
  const to = await ownerEmail();
  if (!to) return { ok: false, error: "no_owner_email" };
  const post = await samplePost(db);
  if (!post) return { ok: false, error: "no_post" };
  const base = siteBase();
  const mail = emailForPost(post, { base, unsubscribe: `${base}/newsletter/unsubscribe?test=1`, test: true });
  const gate = await emailGate(db, { via: "mailroom-news" });
  const sent = await gate.send({ kind: "newsletter", to, ...mail, key: `nl-test-${Date.now()}` });
  if (!sent.sent) return { ok: false, error: String(sent.reason ?? "error").replace(/[^\s@]+@[^\s@]+/g, "[email]").slice(0, 160) };
  return { ok: true, to, post: post.title };
}
