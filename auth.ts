import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

// JWT sessions (no DB adapter): the GitHub numeric id is the stable rater_id,
// the login is for display. Reads AUTH_GITHUB_ID / AUTH_GITHUB_SECRET /
// AUTH_SECRET from env.
declare module "next-auth" {
  interface Session {
    githubId?: string;
    login?: string;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  callbacks: {
    jwt({ token, profile }) {
      if (profile) {
        token.githubId = String(profile.id);
        token.login = String(profile.login);
      }
      return token;
    },
    session({ session, token }) {
      session.githubId = token.githubId as string | undefined;
      session.login = token.login as string | undefined;
      return session;
    },
  },
});
