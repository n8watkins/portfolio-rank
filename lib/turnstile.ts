import { randomUUID } from "crypto";

// Cloudflare Turnstile (managed widget; the pages render it with
// appearance "interaction-only", so most visitors never see it). Checked on
// the server with the TURNSTILE_SECRET_KEY Worker secret. Each form names its
// action ("poll-vote", "grade", "grade-email", "report-email"), and a token
// made for another action is refused.
//
// Fails closed on the deployed Workers (production and staging, NODE_ENV
// "production" with SITE_ENV other than "test"): no secret, or one of
// Cloudflare's test secrets, refuses every request, and the hostname Siteverify
// reports must be the Worker's own (SITE_URL). Only local runs (`next dev`,
// the end-to-end suite with SITE_ENV=test) may go without the secret, and
// they may use Cloudflare's test keys.
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type Env = Record<string, string | undefined>;

/** True on the deployed Workers; false only for `next dev`, unit tests and the SITE_ENV=test suite. */
export function isDeployed(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" && env.SITE_ENV !== "test";
}

/** Cloudflare's always-pass / always-fail / forced-challenge test secrets. */
export function isTestSecret(secret: string): boolean {
  return /^[123]x0+AA$/.test(secret);
}

/** Siteverify answers a test secret with this hostname, whatever the page was. */
const TEST_HOSTNAME = "example.com";

/** Hostnames a token may come from: this Worker's own (SITE_URL), plus localhost when not deployed. */
export function allowedHostnames(env: Env = process.env): string[] {
  const hosts = new Set<string>();
  if (env.SITE_URL) {
    try {
      hosts.add(new URL(env.SITE_URL).hostname);
    } catch {
      // A malformed SITE_URL allows no host, which fails closed.
    }
  }
  if (!isDeployed(env)) {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
  }
  return [...hosts];
}

/** Whether a visitor needs a token: always when deployed, else only once a secret is set. */
export const turnstileRequired = (env: Env = process.env) => isDeployed(env) || Boolean(env.TURNSTILE_SECRET_KEY);

/** "ok", "skipped" (local run with no secret) or "failed" (including a deployed Worker with no usable secret). */
export async function verifyTurnstile(
  token: unknown,
  ip: string,
  { action, fetchImpl = fetch, env = process.env }: { action: string; fetchImpl?: typeof fetch; env?: Env }
): Promise<"ok" | "skipped" | "failed"> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (!isDeployed(env)) return "skipped";
    console.error(JSON.stringify({ event: "turnstile_not_configured", site_env: env.SITE_ENV ?? null }));
    return "failed";
  }
  // A test secret accepts a dummy token, so a deployed Worker never trusts one.
  if (isDeployed(env) && isTestSecret(secret)) {
    console.error(JSON.stringify({ event: "turnstile_test_secret_in_production", site_env: env.SITE_ENV ?? null }));
    return "failed";
  }
  if (typeof token !== "string" || !token || token.length > 2048) return "failed";
  try {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    body.set("idempotency_key", randomUUID());
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const out = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
    if (out.success !== true) return "failed";
    if (isTestSecret(secret)) return out.hostname === TEST_HOSTNAME ? "ok" : "failed";
    if (!out.hostname || !allowedHostnames(env).includes(out.hostname)) return "failed";
    return out.action === action ? "ok" : "failed";
  } catch {
    return "failed";
  }
}
