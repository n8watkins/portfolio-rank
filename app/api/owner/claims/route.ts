import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/polls/server";
import { isKnownPortfolio } from "@/lib/roster";
import { MAX_VERIFIED, META_NAME, NOTE_MAX, autoProof, listClaims, metaProof, openClaim, ownerState, setClaimStatus, verifiedCount } from "@/lib/games/claims.mjs";
import { fetchPage, githubProfile, templateOf } from "@/lib/games/owner";
import { PRIVATE, fail, overLimit, rateLimited } from "@/lib/games/server";
import { accountTooNew, guardConfig } from "@/lib/rater";

// Claim your portfolio: always on, so removal is self-serve. Signed in with GitHub only.
// GET  /api/owner/claims -> { claims: [{ url, status, method, meta, state, ... }] }
// POST /api/owner/claims { url, method?: "auto" | "meta" | "manual", note? }
//   auto    (default) checks that the home page links to github.com/<you>
//           (never the GitHub profile's Website field, which anyone can set)
//   meta    checks for <meta name="portfoliorank-verify" content="<token>">
//           on the home page (the token is in every claim this returns)
//   manual  asks the site owner to review it (note: up to 500 characters)
//   200 { claim } with claim.status "verified", "pending" (not proven yet:
//       add the meta tag or ask for review), "review" or "rejected"
//   400 bad_request | unknown_portfolio, 401 signin_required,
//   403 bad_origin, 429 rate_limited
// An account verifies at most 3 portfolios by itself; more go to review, and
// so does every claim from a GitHub account younger than
// MIN_GITHUB_ACCOUNT_AGE_DAYS.
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

type Claim = { id: number; url: string; owner: string; login: string; status: string; method: string | null; token: string; note: string | null; createdAt: string; updatedAt: string };

async function shape(c: Claim) {
  return {
    url: c.url,
    status: c.status,
    method: c.method,
    meta: { name: META_NAME, content: c.token, tag: `<meta name="${META_NAME}" content="${c.token}">` },
    state: await ownerState(db(), c.url),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function signedIn() {
  const s = await auth();
  return s?.raterId?.startsWith("gh:") && s.login ? { id: s.raterId, login: s.login, tooNew: accountTooNew({ type: "human", accountCreatedAt: s.accountCreatedAt }) } : null;
}

export async function GET() {
  // Always on: owners can prove a site is theirs whatever the feature switches say.
  const me = await signedIn();
  if (!me) return fail("signin_required", 401);
  await ensureSchema();
  const claims = (await listClaims(db(), me.id)) as Claim[];
  return NextResponse.json({ claims: await Promise.all(claims.map(shape)) }, { headers: PRIVATE });
}

export async function POST(req: Request) {
  // Always on: owners can prove a site is theirs whatever the feature switches say.
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const me = await signedIn();
  if (!me) return fail("signin_required", 401);
  let body: { url?: unknown; method?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const url = typeof body?.url === "string" ? body.url : "";
  const method = body?.method ?? "auto";
  if (!url || !["auto", "meta", "manual"].includes(String(method))) return fail("bad_request", 400);
  if (method === "manual" && body.note != null && (typeof body.note !== "string" || body.note.length > NOTE_MAX)) return fail("bad_request", 400);
  if (!isKnownPortfolio(url)) return fail("unknown_portfolio", 400);

  await ensureSchema();
  // Each attempt may fetch the portfolio and GitHub.
  const over = await overLimit([{ key: `claim:${me.id}`, limit: 10, windowMs: HOUR }]);
  if (over) return rateLimited(over);

  const now = new Date();
  let claim = (await openClaim(db(), { url, owner: me.id, login: me.login, token: randomBytes(12).toString("base64url"), now })) as Claim;
  if (claim.status === "verified" || claim.status === "rejected") return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });

  if (method === "manual") {
    const note = typeof body.note === "string" ? body.note.trim() : "";
    claim = (await setClaimStatus(db(), { claim, status: "review", method: "manual", note: note || null, actor: me.id, now })) as Claim;
    return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });
  }

  const page = await fetchPage(url);
  let proof: string | null = null;
  if (method === "meta") {
    proof = metaProof({ url, page, token: claim.token }) ? "meta" : null;
  } else {
    // The account's current login (by numeric id, so a renamed account still matches its links).
    const profile = await githubProfile(me.id.slice(3));
    proof = autoProof({ url, page, login: profile?.login ?? me.login, template: await templateOf(url) });
  }
  if (!proof) return NextResponse.json({ claim: await shape(claim), reason: page ? "no_proof" : "unreachable" }, { headers: PRIVATE });

  // Proof holds; past the automatic limit, or from a GitHub account younger
  // than MIN_GITHUB_ACCOUNT_AGE_DAYS, the site owner confirms by hand.
  const over3 = (await verifiedCount(db(), me.id)) >= MAX_VERIFIED;
  const hold = me.tooNew ? `proof ${proof}; the GitHub account is younger than ${guardConfig().minAccountAgeDays} days` : over3 ? `proof ${proof}; over the automatic limit of ${MAX_VERIFIED}` : null;
  claim = (await setClaimStatus(db(), {
    claim,
    status: hold ? "review" : "verified",
    method: proof,
    note: hold,
    actor: me.id,
    now,
  })) as Claim;
  return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });
}
