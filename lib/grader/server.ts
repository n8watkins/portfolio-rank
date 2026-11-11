import { createHmac } from "crypto";
import { cookies } from "next/headers";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";
import { clientIp, currentVoter, sameOrigin } from "@/lib/polls/server";
import { OWNER_COOKIE, ownerCookieValue, readOwnerCookie } from "./links.mjs";
import { networkOf } from "./caps.mjs";
import { createEmailGate, emailCaps, emailTransport } from "@/lib/email/gate.mjs";
import type { Fetcher } from "./quick";
import { publicFetcher } from "./quick";

// Request-side helpers for the grader API (app/api/grade): the feature flag,
// who is asking (visitor and network, as keyed hashes), the report-owner
// cookie, the Worker's bindings, and the test stand-ins.

export { clientIp, sameOrigin };

/** "Grade my portfolio" answers only when GRADER_ENABLED is "true" (off until the redesign ships its UI). */
export const graderEnabled = () => /^true$/i.test(String(process.env.GRADER_ENABLED ?? ""));

export const PRIVATE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" } as const;

export const fail = (error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: { ...PRIVATE, ...headers } });

/** The 404 every grader route answers while the flag is off: nothing about the feature is exposed. */
export const disabled = () => fail("not_found", 404);

const secret = () => process.env.AUTH_SECRET ?? "";
export const authSecret = secret;

/** A small JSON body (at most `max` bytes), or null when it is missing, too big or not an object. */
export async function readJsonBody(req: Request, max = 8192): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > max) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > max) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A keyed hash, so the database never stores who asked or from where. */
export const keyed = (scope: string, value: string) => createHmac("sha256", secret()).update(`grader-${scope}\n${value}`).digest("base64url").slice(0, 22);

/**
 * Who is asking: the visitor (signed-in account, else the signed browser
 * cookie, issued when missing) and the network, both as keyed hashes.
 */
export async function requester(req: Request): Promise<{ visitor: string; network: string; ip: string }> {
  const voter = (await currentVoter({ create: true }))!;
  const ip = clientIp(req);
  const net = networkOf(ip);
  return { visitor: keyed("visitor", voter.voter), network: net ? keyed("network", net) : "", ip };
}

/** The report ids this browser owns (the signed pr_grades cookie). */
export async function ownedJobs(): Promise<string[]> {
  const jar = await cookies();
  return readOwnerCookie(jar.get(OWNER_COOKIE)?.value, secret());
}

/** Adds a report to this browser's owner cookie. */
export async function addOwnedJob(id: string): Promise<void> {
  const jar = await cookies();
  const ids = [...readOwnerCookie(jar.get(OWNER_COOKIE)?.value, secret()), id];
  jar.set(OWNER_COOKIE, ownerCookieValue(ids, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !/^http:/.test(process.env.AUTH_URL ?? ""),
    maxAge: 60 * 60 * 24 * 180,
    path: "/",
  });
}

/** The site's own address for links in emails: AUTH_URL (staging or production), else SITE_URL. */
export function siteBase(): string {
  return (process.env.AUTH_URL || SITE_URL).replace(/\/+$/, "");
}

/**
 * A test stand-in's setting, honoured only off the deployed Workers
 * (SITE_ENV "production" or "staging" ignore them all), so a stray variable
 * can never reroute production traffic.
 */
export function testSeam(
  name: "GRADER_TEST_SITE" | "GRADER_TEST_GITHUB_API" | "GRADER_TEST_GEMINI_API" | "GRADER_TEST_SHOTS_DIR" | "GAMES_TEST_GITHUB_API"
): string | undefined {
  const env = process.env.SITE_ENV;
  if (env === "production" || env === "staging") return undefined;
  return process.env[name] || undefined;
}

/**
 * How the free checks fetch: safeFetch, or in tests a local stand-in that
 * serves the "site" (GRADER_TEST_SITE, given the address in ?u=).
 */
export function graderFetcher(): Fetcher {
  const base = testSeam("GRADER_TEST_SITE");
  if (!base) return publicFetcher;
  return async (url, init) => {
    try {
      const res = await fetch(`${base}/site?u=${encodeURIComponent(url)}`, { method: init.method ?? "GET", signal: AbortSignal.timeout(init.timeoutMs) });
      return { res, finalUrl: url };
    } catch {
      return null;
    }
  };
}

type Env = Partial<CloudflareEnv> & Record<string, unknown>;

/**
 * The Worker's bindings with the process's variables on top, or process.env
 * alone off Workers. On a deployed Worker both hold the same vars and
 * secrets; under `next start` the context is a local simulation that carries
 * wrangler.jsonc's production vars, which must not override the test run's.
 */
export async function workerEnv(): Promise<Env> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return { ...(env as unknown as Env), ...(process.env as Record<string, unknown>) };
  } catch {
    return process.env as unknown as Env;
  }
}

/** The shared email gate for this request (lib/email/gate.mjs), with whatever transport the environment has. */
export async function emailGate(db: unknown) {
  const env = await workerEnv();
  const transport = emailTransport(env, { db });
  return createEmailGate({ db, transport, caps: emailCaps(String(env.EMAIL_CAPS ?? "") || undefined), secret: secret() });
}

/** Reads a grade screenshot (private/grades/<id>/<file>) from the SHOTS bucket, or the test directory. */
export async function readGradeShot(shotKey: string, file: "hero.jpg" | "mobile.jpg"): Promise<Uint8Array | null> {
  const dir = testSeam("GRADER_TEST_SHOTS_DIR");
  if (dir) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    try {
      return new Uint8Array(await fs.readFile(path.join(dir, shotKey, file)));
    } catch {
      return null;
    }
  }
  const env = await workerEnv();
  const bucket = env.SHOTS as CloudflareEnv["SHOTS"] | undefined;
  if (!bucket) return null;
  const obj = await bucket.get(`${shotKey}/${file}`);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

/** Deletes a job's screenshots from the bucket (owner delete, retention). */
export async function deleteGradeShots(shotKey: string | null): Promise<void> {
  if (!shotKey || !shotKey.startsWith("private/grades/")) return;
  const env = await workerEnv();
  const bucket = env.SHOTS as CloudflareEnv["SHOTS"] | undefined;
  if (!bucket) return;
  await bucket.delete([`${shotKey}/hero.jpg`, `${shotKey}/mobile.jpg`]);
}
