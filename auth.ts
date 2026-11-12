import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { db, ensureSchema } from "@/lib/db";
import { consumeToken } from "@/lib/signin/store.mjs";
import { authLogger } from "@/lib/log";
import { SESSION_VERSION, isCurrentSession } from "@/lib/session-version.mjs";

// JWT sessions (no DB adapter). Two ways in:
// - GitHub: raterId is the stable GitHub identity (gh:<github numeric id>);
//   login is the GitHub login, for display only.
// - Email: a one-time link (lib/signin, POST /api/signin/email sends it, the
//   page /signin/email asks for one click so mail scanners can't use it up);
//   the "email-link" provider below consumes the link's token once, and
//   raterId is em:<random account id>; login is the address, shown only to
//   its owner.
// Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET / AUTH_SECRET from env.
declare module "next-auth" {
  interface Session {
    raterId?: string;
    login?: string;
    /** When the account was created (ISO 8601): GitHub's date, for MIN_GITHUB_ACCOUNT_AGE_DAYS, or the email account's. */
    accountCreatedAt?: string;
    /**
     * This is the admin's account (ADMIN_GITHUB_ID), so the menus show an
     * "Admin" link. Display only: every admin page and API checks again on
     * the server (lib/admin.ts requireAdmin).
     */
    isAdmin?: boolean;
    /** How the account signs in. */
    provider?: "github" | "email";
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub,
    Credentials({
      id: "email-link",
      name: "Email link",
      credentials: { token: {} },
      async authorize(credentials) {
        await ensureSchema();
        const out = await consumeToken(db(), String(credentials?.token ?? ""), { secret: process.env.AUTH_SECRET });
        const account = "account" in out ? out.account : null;
        if (!account) return null;
        return { id: account.id, email: account.email, createdAt: account.createdAt } as { id: string; email: string };
      },
    }),
  ],
  trustHost: true,
  // Sign-in and its errors open the site's own dialog (components/SignInModal),
  // never Auth.js's unstyled stock pages.
  pages: { signIn: "/?signin=1", error: "/?signin=1" },
  // Error type and a masked message only; see lib/log.ts.
  logger: authLogger,
  callbacks: {
    jwt({ token, account, profile, user }) {
      if (account?.provider === "github" && profile) {
        token.sv = SESSION_VERSION;
        token.raterId = `gh:${profile.id}`;
        token.login = String(profile.login);
        if (typeof profile.created_at === "string") token.accountCreatedAt = profile.created_at;
        token.provider = "github";
      }
      if (account?.provider === "email-link" && user?.id && user.email) {
        token.sv = SESSION_VERSION;
        token.raterId = user.id;
        token.login = user.email;
        token.accountCreatedAt = (user as { createdAt?: string }).createdAt;
        token.provider = "email";
      }
      // Returning null ends the session (the cookie is cleared): a session
      // from before the current version is signed out, once.
      return isCurrentSession(token) ? token : null;
    },
    session({ session, token }) {
      session.raterId = token.raterId as string | undefined;
      session.login = token.login as string | undefined;
      session.accountCreatedAt = token.accountCreatedAt as string | undefined;
      const admin = (process.env.ADMIN_GITHUB_ID ?? "").trim();
      session.isAdmin = /^\d{1,12}$/.test(admin) && token.raterId === `gh:${admin}`;
      session.provider = (token.provider as "github" | "email" | undefined) ?? (String(token.raterId ?? "").startsWith("em:") ? "email" : "github");
      return session;
    },
  },
});
