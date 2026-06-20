import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

// JWT sessions (no DB adapter): raterId is the stable GitHub identity
// (gh:<github numeric id>); login is for display only. GitHub-only by design —
// the audience is developers, and dropping Google avoids maintaining a Google
// Cloud project (see HANDOFF). Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET /
// AUTH_SECRET from env.
declare module "next-auth" {
  interface Session {
    raterId?: string;
    login?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  callbacks: {
    jwt({ token, account, profile }) {
      if (account?.provider === "github" && profile) {
        token.raterId = `gh:${profile.id}`;
        token.login = String(profile.login);
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
