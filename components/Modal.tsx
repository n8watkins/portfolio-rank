"use client";

import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useIsClient } from "@/lib/client-state";

// The one modal for the whole site, on the browser's own <dialog>:
// showModal() puts it in the top layer (above every stacking context, so no
// ancestor's transform, filter or overflow can trap it), makes the rest of the
// page inert (focus stays inside), closes on Escape and returns focus to
// whatever opened it. On top of that this adds a portal to <body> (so it is
// never a DOM descendant of a link or a card), a scroll lock, a labelled title,
// a close button and backdrop-click to dismiss.

let locks = 0;
let saved: { overflow: string; paddingRight: string } | null = null;

function lockScroll() {
  if (locks++ > 0) return;
  const root = document.documentElement;
  const gutter = window.innerWidth - root.clientWidth;
  saved = { overflow: root.style.overflow, paddingRight: root.style.paddingRight };
  root.style.overflow = "hidden";
  if (gutter > 0) root.style.paddingRight = `${gutter}px`;
}

function unlockScroll() {
  if (--locks > 0 || !saved) return;
  const root = document.documentElement;
  root.style.overflow = saved.overflow;
  root.style.paddingRight = saved.paddingRight;
  saved = null;
}

/** True while any modal is open, so global shortcuts can stand down. */
export function isModalOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector("dialog[open]") !== null;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className = "",
}: {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name, shown as its heading. */
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Extra classes for the panel, e.g. a different max width or text alignment. */
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const pressedOnBackdrop = useRef(false);
  // The portal needs document.body, so the dialog renders only on the client.
  const mounted = useIsClient();

  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    lockScroll();
    return () => {
      unlockScroll();
      if (dialog.open) dialog.close();
      // Browsers restore focus on close too; this covers a dialog that unmounts while open.
      if (opener?.isConnected && document.activeElement !== opener) opener.focus({ preventScroll: true });
    };
  }, [open, mounted]);

  if (!mounted) return null;

  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      // Escape (and the browser's other close requests) close the native dialog;
      // this reports it so the owner's state follows.
      onClose={() => {
        if (open) onCloseRef.current();
      }}
      onMouseDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Portals still bubble React events to the opener's ancestors: stop here.
        e.stopPropagation();
        // The panel fills the dialog box, so a click on the dialog itself is a
        // click on the backdrop. A drag that starts inside doesn't count.
        if (e.target === e.currentTarget && pressedOnBackdrop.current) onCloseRef.current();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className="modal m-auto w-[calc(100%-2rem)] max-w-sm overflow-visible bg-transparent p-0 text-ink backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className={`relative rounded-2xl border border-edge bg-card p-6 shadow-2xl ${className}`}>
        {/* Clear of the close button; a centred title keeps both sides even. */}
        <h2
          id={titleId}
          className={`${className.includes("text-center") ? "px-8" : "pr-10"} text-lg font-bold tracking-tight`}
        >
          {title}
        </h2>
        {description && (
          <p id={descId} className="mt-2 text-sm text-mute">
            {description}
          </p>
        )}
        {children}
        {/* Last in the DOM, first on screen: opening focuses the dialog's own
            first control rather than Close. */}
        <button
          type="button"
          onClick={() => onCloseRef.current()}
          aria-label="Close"
          className="absolute right-1.5 top-1.5 grid h-11 w-11 place-items-center rounded-lg text-mute transition hover:bg-raised hover:text-ink"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
            <path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </dialog>,
    document.body
  );
}
