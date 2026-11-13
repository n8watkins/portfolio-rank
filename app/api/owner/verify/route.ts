import { randomBytes } from "crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db, ensureSchema } from "@/lib/db";
import { sameOrigin } from "@/lib/polls/server";
import { controlProof, openClaim, ownerState, pagesAccount, setClaimStatus } from "@/lib/games/claims.mjs";
import { PRIVATE, fail, overLimit, rateLimited } from "@/lib/games/server";
import { VERIFY_TIMEOUT_MS, VERIFY_TRIES_PER_HOUR, checkProof, verificationFileUrl, verificationPath, verificationTag } from "@/lib/ownership/verify.mjs";
import { siteHop } from "@/lib/ownership/hop";
import { loadProfile } from "@/lib/profile";
import { toolsEnabled } from "@/lib/tools/server";

// Prove you own a portfolio with code you deploy (lib/ownership/verify.mjs),
// while "Add your portfolio" is on (TOOLS_ENABLED; 404 otherwise). For a
// listed portfolio or one added through /add. Signed in with GitHub.
//
// POST /api/owner/verify { url, method }
//   method "start"  opens the claim and returns its token and both ways to
//                   use it; a GitHub Pages site of the signed-in account
//                   (<login>.github.io) is verified at once, with no fetch
//   method "file"   checks /portfoliorank-<token>.txt at the site root
//   method "meta"   checks <meta name="portfoliorank-verification"
//                   content="<token>"> on the home page
//   "file" and "meta" make one fetch (5 s, at most 3 redirects on the same
//   site), at most 5 tries an hour per account.
//   200 { claim, reason? } with claim.verified true once proven; reason
//       (not proven) "not_found" | "off_site" | "too_many_redirects" |
//       "unreachable" | "timeout"
//   400 bad_request | unknown_portfolio, 401 signin_required,
//   403 bad_origin, 404 not_found (TOOLS_ENABLED off), 429 rate_limited
// A verified owner can then re-check the site, hide its grade and remove it
// (/api/recheck, /api/owner/actions).
export const dynamic = "force-dynamic";
const HOUR = 60 * 60 * 1000;

type Claim = { id: number; url: string; owner: string; status: string; method: string | null; token: string };

async function shape(c: Claim) {
  const verified = c.status === "verified" && (await controlProof(db(), { url: c.url, owner: c.owner }));
  return {
    url: c.url,
    verified,
    method: verified ? c.method : null,
    token: c.token,
    file: { path: verificationPath(c.token), url: verificationFileUrl(c.url, c.token), content: c.token },
    meta: { tag: verificationTag(c.token) },
    state: await ownerState(db(), c.url),
  };
}

export async function POST(req: Request) {
  if (!toolsEnabled()) return fail("not_found", 404);
  if (!sameOrigin(req)) return fail("bad_origin", 403);
  const s = await auth();
  if (!s?.raterId?.startsWith("gh:") || !s.login) return fail("signin_required", 401);
  let body: { url?: unknown; method?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail("bad_request", 400);
  }
  const asked = typeof body?.url === "string" ? body.url.slice(0, 500) : "";
  const method = String(body?.method ?? "start");
  if (!asked || !["start", "file", "meta"].includes(method)) return fail("bad_request", 400);
  await ensureSchema();
  const profile = await loadProfile(asked);
  if (!profile) return fail("unknown_portfolio", 400);
  const url = profile.url;
  const owner = s.raterId;
  const now = new Date();
  let claim = (await openClaim(db(), { url, owner, login: s.login, token: randomBytes(16).toString("base64url"), now })) as Claim;
  if (claim.status === "verified" && (await controlProof(db(), { url, owner }))) return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });

  if (method === "start") {
    // GitHub says who owns a github.io site: no fetch needed.
    if (pagesAccount(url) === s.login.toLowerCase()) {
      claim = (await setClaimStatus(db(), { claim, status: "verified", method: "github_pages", note: null, actor: owner, now })) as Claim;
    }
    return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });
  }

  const over = await overLimit([{ key: `verify:${owner}`, limit: VERIFY_TRIES_PER_HOUR, windowMs: HOUR }]);
  if (over) return rateLimited(over);
  const result = await checkProof({ url, token: claim.token, method: method as "file" | "meta", hop: siteHop(VERIFY_TIMEOUT_MS) });
  if (!result.ok) return NextResponse.json({ claim: await shape(claim), reason: result.reason }, { headers: PRIVATE });
  claim = (await setClaimStatus(db(), { claim, status: "verified", method, note: null, actor: owner, now })) as Claim;
  return NextResponse.json({ claim: await shape(claim) }, { headers: PRIVATE });
}
