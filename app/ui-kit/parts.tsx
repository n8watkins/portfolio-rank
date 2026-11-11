"use client";

import { ChevronLeft, ChevronRight, Pause } from "lucide-react";
import { EmailSignupForm } from "@/components/ui/EmailSignupForm";
import { btnIcon } from "@/components/ui/styles";

/** The sign-up with a stand-in sender: an address with "fail" in it shows the error state. */
export function KitSignup() {
  return (
    <EmailSignupForm
      onSubmit={async (email) => {
        await new Promise((r) => setTimeout(r, 600));
        return email.includes("fail") ? { ok: false, error: "That address bounced. Check it and try again." } : { ok: true };
      }}
    />
  );
}

export function KitIconButtons() {
  return (
    <>
      <button type="button" aria-label="Previous" className={btnIcon}>
        <ChevronLeft className="h-5 w-5" aria-hidden />
      </button>
      <button type="button" aria-label="Pause" className={btnIcon}>
        <Pause className="h-4 w-4" aria-hidden />
      </button>
      <button type="button" aria-label="Next" className={btnIcon}>
        <ChevronRight className="h-5 w-5" aria-hidden />
      </button>
    </>
  );
}
