import { getCloudflareContext } from "@opennextjs/cloudflare";
import { db } from "@/lib/db";
import { rateLimit } from "@/lib/polls/store.mjs";

// The one gate every email passes (owner decisions 2026-11-10, DECISIONS.md
// "Newsletter and email"): sent through Cloudflare Email Service (the
// Worker's `send_email` binding named EMAIL) from EMAIL_FROM, and stopped
// at a hard daily cap (EMAIL_DAILY_CAP, default 50, under the beta's
// conservative daily limit) that no bug or abuse can get past.
// Not wired until the owner adds the binding and EMAIL_FROM (DEPLOY.md):
// until then emailAvailable() is false and nothing is sent.

type SendEmail = {
  send(message: { to: string; from: { email: string; name?: string }; subject: string; text: string; html?: string }): Promise<unknown>;
};

export const EMAIL_DAILY_CAP_DEFAULT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function binding(): SendEmail | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const b = env.EMAIL as SendEmail | undefined;
    return b && typeof b.send === "function" ? b : null;
  } catch {
    return null; // not on Workers (next dev, next start)
  }
}

/** "Name <address>" or a bare address from EMAIL_FROM; null when unset or malformed. */
function sender(): { email: string; name?: string } | null {
  const raw = (process.env.EMAIL_FROM ?? "").trim();
  const m = raw.match(/^(?:(.*?)\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))$/);
  if (!m) return null;
  return m[2] ? { email: m[2], ...(m[1] ? { name: m[1] } : {}) } : { email: m[3] };
}

export const emailAvailable = () => Boolean(binding() && sender());

function dailyCap(): number {
  const n = Number(process.env.EMAIL_DAILY_CAP ?? EMAIL_DAILY_CAP_DEFAULT);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : EMAIL_DAILY_CAP_DEFAULT;
}

/**
 * Sends one email through the gate. "sent", "unavailable" (no sender
 * configured), "capped" (the day's cap is spent) or "failed".
 */
export async function sendEmail(msg: { to: string; subject: string; text: string; html?: string }): Promise<"sent" | "unavailable" | "capped" | "failed"> {
  const b = binding();
  const from = sender();
  if (!b || !from) return "unavailable";
  const hit = await rateLimit(db(), "email:all", { limit: dailyCap(), windowMs: DAY_MS, now: Date.now() });
  if (!hit.ok) return "capped";
  try {
    await b.send({ to: msg.to, from, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}) });
    return "sent";
  } catch {
    return "failed";
  }
}
