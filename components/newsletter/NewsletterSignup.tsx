"use client";

import { useNewsletterOn } from "./useNewsletterOn";
import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Mail } from "lucide-react";
import { EmailSignupForm } from "@/components/ui/EmailSignupForm";
import { Turnstile, prefetchTurnstile, type TurnstileHandle } from "@/components/ui/Turnstile";
import { eyebrow } from "@/components/ui/styles";

/** Where the form sits; sent to Kit as the sign-up's referrer (lib/newsletter/store.mjs cleanSource). */
export type SignupForm = "sidebar" | "after-post" | "blog" | "footer";


const ERRORS: Record<string, string> = {
  bad_email: "Enter an email address like you@example.com.",
  rate_limited: "That's a lot of sign-ups for now. Check your inbox for the last confirm email, or try again tomorrow.",
  turnstile_failed: "We couldn't check that this is a person. Reload the page and try again.",
  email_unavailable: "We can't send email right now. Try again later.",
};

/**
 * The blog newsletter's sign-up (AUTOMATION.md "Newsletter"): an address,
 * then POST /api/newsletter/subscribe adds it to Kit, which emails a confirm link; nothing is sent
 * until it is used. Turnstile (action "newsletter") loads on first hover or
 * focus and stays invisible for most people. Two layouts: "stack" (a card
 * for the post's sidebar or the end of a post) and "wide" (text beside the
 * form, for /blog and the footer). Renders nothing until the newsletter is
 * known to be live (useNewsletterOn: the build flag and the owner's switch).
 */
export function NewsletterSignup({ form, layout = "stack", className = "" }: { form: SignupForm; layout?: "stack" | "wide"; className?: string }) {
  const token = useRef<string | null>(null);
  const failed = useRef(false);
  const widget = useRef<TurnstileHandle>(null);
  const [armed, setArmed] = useState(false);
  const path = usePathname() ?? "";
  const on = useNewsletterOn();
  if (!on) return null;
  // The blog's pages have their own sign-up, which the footer's would repeat
  // just below; the admin and the newsletter's own pages need none.
  if (form === "footer" && /^\/(blog|admin|newsletter)(\/|$)/.test(path)) return null;
  const arm = () => {
    if (armed) return;
    prefetchTurnstile();
    setArmed(true);
  };
  const id = `newsletter-${form}`;

  const signup = (
    <>
      <EmailSignupForm
        label="Email for new posts"
        button="Subscribe"
        busyLabel="Subscribing..."
        helper="We email you a link to confirm. Unsubscribe in one click from any email."
        success="Almost there: check your inbox and press Confirm. Nothing comes until you do."
        onSubmit={async (email) => {
          arm();
          for (let k = 0; k < 30 && !token.current && !failed.current; k++) await new Promise((r) => setTimeout(r, 150));
          try {
            const res = await fetch("/api/newsletter/subscribe", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email, source: window.location.pathname, form, ...(token.current ? { turnstileToken: token.current } : {}) }),
            });
            token.current = null;
            widget.current?.reset();
            if (res.ok) return { ok: true };
            const b = await res.json().catch(() => ({}));
            return { ok: false, error: ERRORS[String(b.error)] ?? "That didn't work. Try again in a moment." };
          } catch {
            return { ok: false, error: "We couldn't reach PortfolioRank. Check your connection; your address is still here." };
          }
        }}
      />
      {armed && (
        <Turnstile
          ref={widget}
          action="newsletter"
          onToken={(t) => (token.current = t)}
          onExpire={() => (token.current = null)}
          onError={() => (failed.current = true)}
          className="mt-2 empty:hidden"
        />
      )}
    </>
  );

  const intro = (
    <>
      <p className={`${eyebrow} flex items-center gap-1.5`}>
        <Mail className="h-3.5 w-3.5" aria-hidden /> Newsletter
      </p>
      <h2 id={id} className={`mt-2 font-bold tracking-tight text-balance ${layout === "wide" ? "text-xl sm:text-2xl" : "text-lg"}`}>
        New posts by email
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-mute text-pretty">
        What the best developer portfolios do, from PortfolioRank&apos;s own data. One email a post, at most two a week.
      </p>
    </>
  );

  if (layout === "wide") {
    const wide = (
      <section aria-labelledby={id} onFocus={arm} onPointerEnter={arm} className={`grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] md:gap-10 ${className}`} data-newsletter={form}>
        <div className="max-w-xl">{intro}</div>
        <div className="min-w-0">{signup}</div>
      </section>
    );
    // The footer's band runs edge to edge, with its line under it.
    return form === "footer" ? <div className="border-b border-edge">{wide}</div> : wide;
  }
  return (
    <section aria-labelledby={id} onFocus={arm} onPointerEnter={arm} className={`card p-5 ${className}`} data-newsletter={form}>
      {intro}
      <div className="mt-4">{signup}</div>
    </section>
  );
}
