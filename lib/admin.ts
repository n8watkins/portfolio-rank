import { auth } from "@/auth";

/**
 * The signed-in admin's GitHub login, or why not: "signin_required" when no
 * one is signed in, "forbidden" for anyone whose login isn't
 * ADMIN_GITHUB_LOGIN (wrangler.jsonc vars; no admin at all when it's unset).
 * The login comes from the signed session cookie, so it can't be forged.
 */
export async function requireAdmin(): Promise<{ login: string } | { error: "signin_required" | "forbidden" }> {
  const session = await auth();
  const login = session?.login;
  if (!login) return { error: "signin_required" };
  const admin = (process.env.ADMIN_GITHUB_LOGIN ?? "").trim().toLowerCase();
  if (!admin || login.toLowerCase() !== admin) return { error: "forbidden" };
  return { login };
}
