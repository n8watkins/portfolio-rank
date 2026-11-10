"use client";

import { Modal } from "@/components/Modal";

/** Preview stand-in for the real sign-in window (components/SignInModal.tsx). */
export function MockSignIn({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Sign in to PortfolioRank" description="Your votes count officially, and your portfolio follows you to every device.">
      <div className="mt-5 grid grid-cols-1 gap-2">
        <button type="button" disabled className="flex h-11 items-center justify-center gap-2 rounded-lg bg-ink text-sm font-semibold text-bg opacity-60">
          Continue with GitHub
        </button>
        <button type="button" onClick={onClose} className="h-11 rounded-lg text-sm font-semibold text-mute transition hover:text-ink">
          Continue with just your email
        </button>
        <p className="text-center text-xs text-mute">Grade without an account: we email you a one-time link to your report.</p>
      </div>
      <p className="mt-4 rounded-lg bg-raised px-3 py-2 text-xs text-mute">
        Preview: sign-in is off here. Pick a signed-in visitor in the preview bar at the top to see those states.
      </p>
    </Modal>
  );
}
