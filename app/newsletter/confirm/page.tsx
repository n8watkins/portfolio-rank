import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MailCheck, MailWarning } from "lucide-react";
import { NewsletterAction } from "@/components/newsletter/NewsletterAction";
import { db, ensureSchema } from "@/lib/db";
import { newsletterEnabled } from "@/lib/newsletter/server";
import { peekConfirm } from "@/lib/newsletter/store.mjs";
import { maskEmail } from "@/lib/signin/store.mjs";

// Where the newsletter's confirm link lands (lib/newsletter/store.mjs). It
// only reads the link; the button confirms, so a mail scanner can't
// subscribe anyone. Never cached, never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm your subscription - PortfolioRank", robots: { index: false, follow: false } };

const WHY = {
  invalid: "This link isn't one we sent, was copied only in part, or was already used. If you confirmed already, you're all set.",
  expired: "This link ran out: confirm links work for 3 days. Sign up again from the blog to get a new one.",
} as const;

export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  if (!newsletterEnabled()) notFound();
  const { t } = await searchParams;
  await ensureSchema();
  const peek = await peekConfirm(db(), t ?? "");
  const ok = "email" in peek && peek.email;
  return (
    <div className="mx-auto flex w-full max-w-md px-4 py-14 sm:py-20">
      <section aria-labelledby="nl-confirm" className="card rise w-full p-6 text-center sm:p-8">
        <span className="icon-tile mx-auto h-12 w-12">{ok ? <MailCheck className="h-6 w-6" aria-hidden /> : <MailWarning className="h-6 w-6" aria-hidden />}</span>
        {ok ? (
          <>
            <h1 id="nl-confirm" className="mt-4 text-2xl font-bold tracking-tight">
              Confirm your subscription
            </h1>
            <p className="mt-2 text-[15px] text-mute">
              New blog posts by email to <span className="font-semibold text-ink">{maskEmail(peek.email)}</span>, at most two a week.
            </p>
            <NewsletterAction
              endpoint="/api/newsletter/confirm"
              body={{ t: t! }}
              label="Confirm my subscription"
              busyLabel="Confirming..."
              done={
                <>
                  You&apos;re subscribed. The next post comes to your inbox.{" "}
                  <Link href="/blog" className="underline underline-offset-2">
                    Read the blog
                  </Link>
                </>
              }
              failed="That didn't work: the link may have just been used or run out. Sign up again from the blog for a new one."
            />
            <p className="mt-4 text-xs text-mute">Didn&apos;t sign up? Close the page: nothing happens without the button.</p>
          </>
        ) : (
          <>
            <h1 id="nl-confirm" className="mt-4 text-2xl font-bold tracking-tight">
              This confirm link doesn&apos;t work
            </h1>
            <p className="mt-2 text-[15px] text-mute">{WHY[("error" in peek ? peek.error : "invalid") as keyof typeof WHY] ?? WHY.invalid}</p>
            <Link href="/blog" className="mt-6 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-4 hover:underline">
              Go to the blog
            </Link>
          </>
        )}
      </section>
    </div>
  );
}
