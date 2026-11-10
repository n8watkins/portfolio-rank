import { randomUUID } from "crypto";

// Cloudflare Turnstile (managed widget; the pages render it with
// appearance "interaction-only", so most visitors never see it). Checked on
// the server when the TURNSTILE_SECRET_KEY Worker secret is set; without it
// the check is skipped ("skipped"), so local runs and the tests work, and a
// deploy without the secret behaves as before. Each form names its action
// ("poll-vote", "grade", "grade-email"), and a token made for another action
// is refused.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export const turnstileRequired = () => Boolean(process.env.TURNSTILE_SECRET_KEY);

/** "ok", "skipped" (no secret set) or "failed". */
export async function verifyTurnstile(
  token: unknown,
  ip: string,
  { action, fetchImpl = fetch }: { action: string; fetchImpl?: typeof fetch }
): Promise<"ok" | "skipped" | "failed"> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return "skipped";
  if (typeof token !== "string" || !token || token.length > 2048) return "failed";
  try {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    body.set("idempotency_key", randomUUID());
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const out = (await res.json()) as { success?: boolean; action?: string };
    return out.success === true && (!out.action || out.action === action) ? "ok" : "failed";
  } catch {
    return "failed";
  }
}
