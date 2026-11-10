"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Modal } from "@/components/Modal";
import { EmailReport } from "@/components/preview/EmailReport";

/** PDF download: signed-in visitors get it at once; others sign in or use a one-time email link. */
export function DownloadReport({ signedIn, domain, reportHref, initialOpen = false }: { signedIn: boolean; domain: string; reportHref: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button
        type="button"
        onClick={() => (signedIn ? window.print() : setOpen(true))}
        className="group inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-edge bg-card px-4 text-sm font-semibold shadow-[var(--card-hi)] transition hover:border-edge-strong active:scale-[0.97]"
      >
        <Download className="nudge-up h-4 w-4" aria-hidden /> Download PDF
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Download your report" description="PDFs are for the site's owner. Sign in with GitHub, or get a one-time link by email." className="max-w-md">
        <div className="mt-4 grid grid-cols-1 gap-3">
          <button type="button" disabled className="flex h-11 items-center justify-center rounded-lg bg-ink text-sm font-semibold text-bg opacity-60">
            Sign in with GitHub
          </button>
          <p className="text-center text-xs text-mute">or</p>
          <EmailReport domain={domain} reportHref={reportHref} />
        </div>
      </Modal>
    </>
  );
}
