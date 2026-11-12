import type { Metadata } from "next";
import { MailX, MailWarning } from "lucide-react";
import { NewsletterAction } from "@/components/newsletter/NewsletterAction";
import { nlSecret } from "@/lib/newsletter/server";
import { validUnsub } from "@/lib/newsletter/store.mjs";

// Where a newsletter email's "Unsubscribe" link lands in a browser
// (app/api/newsletter/unsubscribe redirects a GET here). The button
// unsubscribes at once; mail apps' own one-click unsubscribe skips this page.
// Works even while NEWSLETTER_ENABLED is off. Never cached, never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Unsubscribe - PortfolioRank", robots: { index: false, follow: false } };

export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ s?: string; k?: string; test?: string }> }) {
  const { s, k, test } = await searchParams;
  const ok = validUnsub(s ?? "", k ?? "", nlSecret());
  return (
    <div className="mx-auto flex w-full max-w-md px-4 py-14 sm:py-20">
      <section aria-labelledby="nl-unsub" className="card rise w-full p-6 text-center sm:p-8">
        <span className="icon-tile mx-auto h-12 w-12">{ok ? <MailX className="h-6 w-6" aria-hidden /> : <MailWarning className="h-6 w-6" aria-hidden />}</span>
        {ok ? (
          <>
            <h1 id="nl-unsub" className="mt-4 text-2xl font-bold tracking-tight">
              Unsubscribe from the blog emails?
            </h1>
            <p className="mt-2 text-[15px] text-mute">You&apos;ll stop getting new posts by email. We delete your address 30 days later.</p>
            <NewsletterAction
              endpoint={`/api/newsletter/unsubscribe?s=${encodeURIComponent(s!)}&k=${encodeURIComponent(k!)}`}
              label="Unsubscribe"
              busyLabel="Unsubscribing..."
              done="You're unsubscribed. No more blog emails; your address is deleted in 30 days."
              failed="That didn't work. Try again in a moment."
            />
          </>
        ) : (
          <>
            <h1 id="nl-unsub" className="mt-4 text-2xl font-bold tracking-tight">
              {test ? "This was a test email" : "This unsubscribe link doesn't work"}
            </h1>
            <p className="mt-2 text-[15px] text-mute">
              {test
                ? "Test emails go only to the owner, so there is nothing to unsubscribe from. In a real email this link unsubscribes in one click."
                : "It was copied only in part. Use the Unsubscribe link at the bottom of any newsletter email, or your mail app's own Unsubscribe button."}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
