import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { PRIVATE, fail, keyed, readJsonBody, sameOrigin } from "@/lib/grader/server";
import { controlProof } from "@/lib/games/claims.mjs";
import { siteKeyOf } from "@/lib/grader/url.mjs";
import { networkOf } from "@/lib/grader/caps.mjs";
import { clientIp } from "@/lib/polls/server";
import { toolsEnabled } from "@/lib/tools/server";
import { reservePage, runAllChecks } from "@/lib/tools/run";
import { profilePath } from "@/lib/profile";

// "Re-check my site" on a portfolio's profile: the verified owner (signed in,
// proven by POST /api/owner/verify, lib/games/claims.mjs) runs every check again, at most once an hour
// per portfolio, within the tools' daily caps (lib/tools/caps.mjs). The
// results replace the saved ones, so the profile's fix list updates.
//
// GET  /api/recheck?url=<listed address>  { owner, nextAt }
// POST /api/recheck { url }  200 { ok, nextAt } | 403 not_owner | 429 too_soon { nextAt } | daily_limit
export const dynamic = "force-dynamic";

const HOUR = 60 * 60 * 1000;
const lastKey = (url: string) => `recheck:${siteKeyOf(url)}`;

async function ownerOf(url: string): Promise<string | null> {
  const session = await auth();
  const owner = session?.raterId;
  // Only an owner proven with code they deployed (the verification file or
  // meta tag) or by GitHub Pages: a link from the page to a GitHub profile
  // isn't enough (lib/ownership/verify.mjs, lib/games/claims.mjs controlProof).
  if (!owner || !(await controlProof(db(), { url, owner }))) return null;
  return owner;
}

async function nextAt(url: string): Promise<string | null> {
  const r = (await db().execute({ sql: "SELECT at FROM cache WHERE k = ?", args: [lastKey(url)] })).rows[0];
  const at = r ? Number(r.at) + HOUR : 0;
  return at > Date.now() ? new Date(at).toISOString() : null;
}

export async function GET(req: Request) {
  if (!toolsEnabled()) return fail("not_found", 404);
  const url = new URL(req.url).searchParams.get("url") ?? "";
  await ensureSchema();
  const owner = url ? await ownerOf(url) : null;
  return NextResponse.json({ owner: Boolean(owner), nextAt: owner ? await nextAt(url) : null }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  if (!toolsEnabled()) return fail("not_found", 404);
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const body = await readJsonBody(req);
  const url = typeof body?.url === "string" ? body.url : "";
  if (!url) return fail("bad_request", 400);
  await ensureSchema();
  const owner = await ownerOf(url);
  if (!owner) return fail("not_owner", 403, { message: "Only the portfolio's verified owner can re-check it." });
  // One re-check an hour per portfolio: the lease row is taken only when it is older than an hour.
  const now = Date.now();
  const took = await db().execute({
    sql: `INSERT INTO cache (k, v, at) VALUES (?, '', ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at WHERE cache.at <= ?`,
    args: [lastKey(url), now, now - HOUR],
  });
  if (took.rowsAffected === 0) return fail("too_soon", 429, { nextAt: await nextAt(url), message: "You can re-check once an hour." });
  const net = networkOf(clientIp(req));
  const who = { visitor: keyed("visitor", owner), network: net ? keyed("network", net) : "", network48: "" };
  const page = await reservePage(who);
  if (!page.ok) return fail("daily_limit", 429, { scope: page.scope, resetAt: page.resetAt, message: "Today's checks are used up. They reset at midnight Pacific time." });
  await runAllChecks({ url, siteKey: siteKeyOf(url) }, who);
  revalidatePath(profilePath(url));
  return NextResponse.json({ ok: true, nextAt: new Date(now + HOUR).toISOString() }, { headers: PRIVATE });
}
