import type { Metadata } from "next";
import { Mail, MailWarning } from "lucide-react";
import { EmailLinkConfirm } from "@/components/signin/EmailLinkConfirm";
import { SignInButton } from "@/components/SignInModal";
import { btnSecondary } from "@/components/ui/styles";
import { db, ensureSchema } from "@/lib/db";
import { maskEmail, peekToken } from "@/lib/signin/store.mjs";

// Where an emailed sign-in link lands (lib/signin, auth.ts "email-link"). It
// only reads the link; the button uses it, so a mail scanner that opens the
// link can't sign anyone in or use it up. Never cached, never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in - PortfolioRank", robots: { index: false, follow: false } };

const WHY = {
  invalid: "This link isn't one we sent, or it was copied only in part.",
  expired: "This link ran out: sign-in links work for 15 minutes.",
  used: "This link was already used: each one works once.",
} as const;

export default async function EmailSignInPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const { t } = await searchParams;
  await ensureSchema();
  const peek = await peekToken(db(), t ?? "");
  const ok = "email" in peek && peek.email;

  return (
    <div className="mx-auto flex w-full max-w-md px-4 py-14 sm:py-20">
      <section aria-labelledby="signin-email" className="card rise w-full p-6 text-center sm:p-8">
        <span className="icon-tile mx-auto h-12 w-12">{ok ? <Mail className="h-6 w-6" aria-hidden /> : <MailWarning className="h-6 w-6" aria-hidden />}</span>
        {ok ? (
          <>
            <h1 id="signin-email" className="mt-4 text-2xl font-bold tracking-tight">
              Sign in to PortfolioRank
            </h1>
            <p className="mt-2 text-[15px] text-mute">
              as <span className="font-semibold text-ink">{maskEmail(peek.email)}</span>
            </p>
            <EmailLinkConfirm token={t!} callback={peek.callback ?? "/"} />
            <p className="mt-4 text-xs text-mute">Didn&apos;t ask for this? Close the page: nothing happens without the button.</p>
          </>
        ) : (
          <>
            <h1 id="signin-email" className="mt-4 text-2xl font-bold tracking-tight">
              This sign-in link doesn&apos;t work
            </h1>
            <p className="mt-2 text-[15px] text-mute">{WHY[("error" in peek ? peek.error : "invalid") as keyof typeof WHY] ?? WHY.invalid}</p>
            <SignInButton className={`${btnSecondary} mt-6 w-full`} title="Sign in to PortfolioRank" body="We'll email you a new link. It takes a few seconds.">
              Send a new link
            </SignInButton>
          </>
        )}
      </section>
    </div>
  );
}
