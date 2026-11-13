import NextAuth, { type NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import { authLogger } from "@/lib/log";
import { SESSION_VERSION, isCurrentSession } from "@/lib/session-version.mjs";
import { adminRaterId, revokedAt, sessionValid, signedInAt } from "@/lib/session-revocation.mjs";
import { db, ensureSchema } from "@/lib/db";

// JWT sessions (no DB adapter): raterId is the stable GitHub identity
// (gh:<github numeric id>); login is for display only. GitHub-only by design —
// the audience is developers, and dropping Google avoids maintaining a Google
// Cloud project (see HANDOFF). Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET /
// AUTH_SECRET from env.
declare module "next-auth" {
  interface Session {
    raterId?: string;
    login?: string;
    /** When the GitHub account was created (ISO 8601), for MIN_GITHUB_ACCOUNT_AGE_DAYS. */
    accountCreatedAt?: string;
    /**
     * This is the admin's account (ADMIN_GITHUB_ID), so the menus show an
     * "Admin" link. Display only: every admin page and API checks again on
     * the server (lib/admin.ts requireAdmin).
     */
    isAdmin?: boolean;
  }
}

/**
 * Whether a signed-in session may go on (lib/session-revocation.mjs): not
 * signed out by "Sign out everywhere" or account deletion, and for the
 * admin, signed in within ADMIN_SESSION_MS. If the database can't say, an
 * admin session ends (it signs in again) and anyone else's goes on.
 */
async function stillValid(token: Record<string, unknown>): Promise<boolean> {
  const raterId = typeof token.raterId === "string" ? token.raterId : null;
  if (!raterId) return true;
  const isAdmin = raterId === adminRaterId();
  try {
    await ensureSchema();
    return sessionValid(token, { revokedAt: await revokedAt(db(), raterId), isAdmin, now: Date.now() });
  } catch (e) {
    console.error(JSON.stringify({ event: "session_check_failed", admin: isAdmin, error: String((e as Error)?.message ?? e).slice(0, 200) }));
    return !isAdmin;
  }
}

const config: NextAuthConfig = {
  providers: [GitHub],
  trustHost: true,
  // Sign-in and its errors open the site's own dialog (components/SignInModal),
  // never Auth.js's unstyled stock pages.
  pages: { signIn: "/?signin=1", error: "/?signin=1" },
  // Error type and a masked message only; see lib/log.ts.
  logger: authLogger,
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "github" && profile) {
        token.sv = SESSION_VERSION;
        token.raterId = `gh:${profile.id}`;
        token.login = String(profile.login);
        if (typeof profile.created_at === "string") token.accountCreatedAt = profile.created_at;
        token.at = Date.now();
      }
      // Returning null ends the session (the cookie is cleared): a session
      // from before the current version is signed out, once.
      if (!isCurrentSession(token)) return null;
      // A session from before the sign-in time was kept counts from its issue time.
      token.at ??= signedInAt(token) ?? Date.now();
      return (await stillValid(token)) ? token : null;
    },
    session({ session, token }) {
      session.raterId = token.raterId as string | undefined;
      session.login = token.login as string | undefined;
      session.accountCreatedAt = token.accountCreatedAt as string | undefined;
      const admin = (process.env.ADMIN_GITHUB_ID ?? "").trim();
      session.isAdmin = /^\d{1,12}$/.test(admin) && token.raterId === `gh:${admin}`;
      return session;
    },
  },
};

// Auth.js takes the site's address (its callback URL is
// <address>/api/auth/callback/github) from AUTH_URL; the site has one address
// setting, SITE_URL (lib/site.ts, wrangler.jsonc), so it is copied over before
// each use. The function form runs per request, after the Worker has filled
// process.env. Without SITE_URL (`next dev`) Auth.js uses the request's host.
export const { handlers, auth, signIn, signOut } = NextAuth(() => {
  if (process.env.SITE_URL) process.env.AUTH_URL = process.env.SITE_URL;
  return config;
});
