import { auth } from "@/auth";
import { sameOrigin } from "@/lib/polls/server";

/**
 * The signed-in admin's GitHub login, or why not: "signin_required" when no
 * one is signed in, "forbidden" for anyone whose GitHub account isn't
 * ADMIN_GITHUB_ID (wrangler.jsonc vars; no admin at all when it's unset).
 * The admin is matched by the account's numeric id (raterId gh:<id>), never
 * by login: a login can be renamed and then registered by someone else, an
 * id never changes hands. Both come from the signed session cookie.
 */
export async function requireAdmin(): Promise<{ login: string } | { error: "signin_required" | "forbidden" }> {
  const session = await auth();
  const login = session?.login;
  if (!login || !session?.raterId) return { error: "signin_required" };
  const admin = (process.env.ADMIN_GITHUB_ID ?? "").trim();
  if (!/^\d{1,12}$/.test(admin) || session.raterId !== `gh:${admin}`) return { error: "forbidden" };
  return { login };
}

/**
 * A state-changing admin request: the same checks as requireAdmin, plus
 * CSRF protection. The Origin header must be this site's (lib/polls/server
 * sameOrigin), and the body must be JSON: a cross-site form can send neither
 * without a CORS preflight, which this site never allows.
 */
export async function requireAdminPost(req: Request): Promise<{ login: string } | { error: "bad_origin" | "bad_request" | "signin_required" | "forbidden" }> {
  if (!sameOrigin(req)) return { error: "bad_origin" };
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) return { error: "bad_request" };
  return requireAdmin();
}

/** The HTTP status for an admin error. */
export const adminErrorStatus = (error: string) => (error === "signin_required" ? 401 : error === "bad_request" ? 400 : 403);
