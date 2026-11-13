"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight } from "lucide-react";
import { useSignIn } from "@/components/SignInModal";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

/**
 * The one click that uses an emailed sign-in link (app/signin/email): mail
 * scanners open links but don't press buttons, so the link isn't used up
 * before you see it. Signing in goes back to where you asked for the link.
 */
export function EmailLinkConfirm({ token, callback }: { token: string; callback: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ask = useSignIn();

  if (failed)
    return (
      <div className="mt-6">
        <p role="alert" className="text-sm text-down">
          That link didn&apos;t work: it may have just been used or run out. Ask for a new one; it takes a few seconds.
        </p>
        <button type="button" onClick={() => ask({ title: "Sign in to PortfolioRank" })} className={`${btnSecondary} mt-4 w-full`}>
          Send a new link
        </button>
      </div>
    );

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await signIn("email-link", { token, redirect: false }).catch(() => null);
        if (res?.ok && !res.error) {
          window.location.assign(callback);
          return;
        }
        setBusy(false);
        setFailed(true);
      }}
      className={`${btnPrimary} mt-6 h-12 w-full text-[15px]`}
    >
      {busy ? "Signing in..." : "Sign in"} {!busy && <ArrowRight className="nudge h-4 w-4" aria-hidden />}
    </button>
  );
}
