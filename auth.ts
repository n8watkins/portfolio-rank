import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";

// JWT sessions (no DB adapter): raterId is the stable per-provider identity
// (gh:<github numeric id>, g:<google sub>); login is for display only.
// Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET / AUTH_SECRET (+ optional
// AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET) from env.
declare module "next-auth" {
  interface Session {
    raterId?: string;
    login?: string;
  }
}

// Google only joins once its credentials exist, so /api/auth/providers (which
// drives the sign-in modal's buttons) stays honest about what's available.
const providers: Provider[] = [GitHub];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(Google);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  trustHost: true,
  callbacks: {
    jwt({ token, account, profile }) {
      if (account && profile) {
        if (account.provider === "github") {
          token.raterId = `gh:${profile.id}`;
          token.login = String(profile.login);
        } else if (account.provider === "google") {
          token.raterId = `g:${profile.sub}`;
          token.login = String(profile.given_name ?? profile.name ?? "voter");
        }
      }
      return token;
    },
    session({ session, token }) {
      session.raterId = token.raterId as string | undefined;
      session.login = token.login as string | undefined;
      return session;
    },
  },
});
