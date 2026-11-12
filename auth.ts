import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { authLogger } from "@/lib/log";
import { SESSION_VERSION, isCurrentSession } from "@/lib/session-version.mjs";

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
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  // Sign-in and its errors open the site's own dialog (components/SignInModal),
  // never Auth.js's unstyled stock pages.
  pages: { signIn: "/?signin=1", error: "/?signin=1" },
  // Error type and a masked message only; see lib/log.ts.
  logger: authLogger,
  callbacks: {
    jwt({ token, account, profile }) {
      if (account?.provider === "github" && profile) {
        token.sv = SESSION_VERSION;
        token.raterId = `gh:${profile.id}`;
        token.login = String(profile.login);
        if (typeof profile.created_at === "string") token.accountCreatedAt = profile.created_at;
      }
      // Returning null ends the session (the cookie is cleared): a session
      // from before the current version is signed out, once.
      return isCurrentSession(token) ? token : null;
    },
    session({ session, token }) {
      session.raterId = token.raterId as string | undefined;
      session.login = token.login as string | undefined;
      session.accountCreatedAt = token.accountCreatedAt as string | undefined;
      return session;
    },
  },
});
