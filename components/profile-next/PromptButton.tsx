"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Copy, X } from "lucide-react";
import { copyToClipboard } from "@/components/ShareButton";
import s from "./profile-next.module.css";

// "Copy a prompt to fix this" and "Copy as a prompt": the recommendations as
// one prompt for an AI coding tool (lib/profile-next/report.mjs fixPrompt),
// shown in a dialog to read and copy. Written by code from the measurements
// on the page, never by a model.

export function PromptButton({ prompt, className, children }: { prompt: string; className: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const copy = async () => {
    setStatus((await copyToClipboard(prompt)) ? "Copied. Paste it into your AI coding tool." : "Could not copy. Select the text and copy it.");
  };

  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="dialog"
        onClick={() => {
          setStatus("");
          setOpen(true);
        }}
      >
        {children}
      </button>
      <dialog
        ref={ref}
        className={s.dlg}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}
      >
        <div className={s.dlgIn}>
          <h3 id={titleId} className={s.dlgH}>
            A prompt to fix this
          </h3>
          <p className={s.dlgP}>Paste it into your AI coding tool, opened on this site&apos;s code. It lists only what was measured here and falls short, with the numbers.</p>
          <textarea className={s.fixText} readOnly rows={12} aria-label="The prompt" value={prompt} onFocus={(e) => e.currentTarget.select()} />
          <div className={s.dlgActs}>
            <span className={s.copyStatus} role="status">
              {status}
            </span>
            <button type="button" className={s.doneBtn} onClick={copy}>
              <Copy className={s.icS} aria-hidden />
              Copy prompt
            </button>
          </div>
          <p className={s.dlgFine}>Written from fixed instructions and this page&apos;s measurements, with no AI.</p>
          <button type="button" className={s.dlgClose} aria-label="Close" onClick={() => setOpen(false)}>
            <X aria-hidden />
          </button>
        </div>
      </dialog>
    </>
  );
}
