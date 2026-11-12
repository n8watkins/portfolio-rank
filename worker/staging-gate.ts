// The staging lock (DEPLOY.md "Staging"), in the Worker's front entrypoint so
// it runs before Next.js and costs about a millisecond. Active only when
// SITE_ENV is "staging"; production never reaches any of it.
//
// Let through: /healthz (answered ahead of this), the web app manifest and
// its icons (browsers fetch the manifest without cookies, so the gate would
// break it on every page; both are the same public files production serves),
// a request carrying the
// header `x-staging-gate` equal to the STAGING_GATE_KEY secret, or one with a
// valid `__Host-staging_gate` cookie (an HMAC of an expiry, 30 days).
// `GET /__gate?key=<secret>` sets that cookie and redirects to `/`; a wrong key
// is a 404 and counts against a per-IP limit in the rate_limits table, so the
// key cannot be brute-forced. Everything else is a plain 404 that says
// nothing about staging.
import { createClient, type Client } from "@libsql/client";
import { rateLimit } from "../lib/polls/store.mjs";

export const GATE_HEADER = "x-staging-gate";
export const GATE_COOKIE = "__Host-staging_gate";
export const GATE_PATH = "/__gate";
export const COOKIE_DAYS = 30;
/** Wrong keys one address may try in a day. */
export const FAILED_PER_DAY = 10;
const DAY_MS = 86_400_000;
/** Public files a browser fetches without cookies: the manifest and the icons it names (app/manifest.ts). */
const OPEN_PATHS = /^\/(?:manifest\.webmanifest|icons\/[\w.-]+\.png)$/;

export type GateEnv = {
  SITE_ENV?: string;
  STAGING_GATE_KEY?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
};
export type GateOptions = {
  /** The counter's database; defaults to the Worker's own Turso database. */
  db?: () => Client;
  now?: number;
};

const enc = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Constant-time: both sides are hashed to the same length first, so neither the content nor the length leaks. */
async function sameSecret(given: string, secret: string): Promise<boolean> {
  return bytesEqual(await hmac(secret, `gate-compare\n${given}`), await hmac(secret, `gate-compare\n${secret}`));
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The cookie value: `<expiry ms>.<HMAC of the expiry>`. */
export async function gateCookieValue(secret: string, now = Date.now()): Promise<string> {
  const expires = String(now + COOKIE_DAYS * DAY_MS);
  return `${expires}.${b64url(await hmac(secret, `gate-cookie\n${expires}`))}`;
}

async function cookieValid(value: string, secret: string, now: number): Promise<boolean> {
  const [expires, sig, ...rest] = value.split(".");
  if (!expires || !sig || rest.length || !/^\d{1,16}$/.test(expires) || Number(expires) <= now) return false;
  return sameSecret(sig, b64url(await hmac(secret, `gate-cookie\n${expires}`)));
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function defaultDb(env: GateEnv): Client {
  return createClient({ url: env.TURSO_DATABASE_URL ?? "", authToken: env.TURSO_AUTH_TOKEN });
}

async function ensureTable(db: Client): Promise<void> {
  await db.execute("CREATE TABLE IF NOT EXISTS rate_limits (k TEXT PRIMARY KEY, window_start INTEGER NOT NULL, n INTEGER NOT NULL)");
}

/** Whether this address has used up its failed attempts. Fails closed. */
async function blocked(db: Client, key: string, now: number): Promise<boolean> {
  try {
    await ensureTable(db);
    const res = await db.execute({ sql: "SELECT n, window_start FROM rate_limits WHERE k = ?", args: [key] });
    const row = res.rows[0];
    return !!row && Number(row.window_start) > now - DAY_MS && Number(row.n) >= FAILED_PER_DAY;
  } catch {
    return true;
  }
}

async function addressKey(secret: string, request: Request): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "";
  return `staging-gate:${b64url(await hmac(secret, `gate-ip\n${ip}`)).slice(0, 22)}`;
}

/**
 * The gate: null lets the request through to the app, a Response answers it.
 * Always null off staging.
 */
export async function stagingGate(request: Request, env: GateEnv, options: GateOptions = {}): Promise<Response | null> {
  if (env.SITE_ENV !== "staging") return null;
  const secret = env.STAGING_GATE_KEY;
  // Locked, not open, while the secret is missing.
  if (!secret) return notFound();
  const now = options.now ?? Date.now();
  const url = new URL(request.url);
  if ((request.method === "GET" || request.method === "HEAD") && OPEN_PATHS.test(url.pathname)) return null;

  if (url.pathname === GATE_PATH) {
    if (request.method !== "GET") return notFound();
    const key = url.searchParams.get("key") ?? "";
    const db = (options.db ?? (() => defaultDb(env)))();
    const address = await addressKey(secret, request);
    if (key && (await sameSecret(key, secret)) && !(await blocked(db, address, now))) {
      const value = await gateCookieValue(secret, now);
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Cache-Control": "no-store",
          "Set-Cookie": `${GATE_COOKIE}=${value}; Max-Age=${COOKIE_DAYS * 86_400}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    try {
      await ensureTable(db);
      await rateLimit(db, address, { limit: FAILED_PER_DAY, windowMs: DAY_MS, now });
    } catch {
      // The answer is the same 404 either way.
    }
    return notFound();
  }

  const header = request.headers.get(GATE_HEADER);
  if (header && (await sameSecret(header, secret))) return null;
  const cookie = readCookie(request, GATE_COOKIE);
  if (cookie && (await cookieValid(cookie, secret, now))) return null;
  return notFound();
}
