"use client";

import { useState } from "react";
import { Modal } from "@/components/Modal";

// "What did we ask?" on the Gemini report card (./GeminiOpinion.tsx): a small
// button that opens the site's one modal with what the model was shown and
// asked. The text is made on the server and passed in.

export function AskedButton({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center text-xs font-semibold text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        What did we ask?
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="What we asked the model">
        <div className="space-y-3 text-sm text-mute">{children}</div>
      </Modal>
    </>
  );
}
