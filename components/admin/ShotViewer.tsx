"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { btnGhost, btnIcon, btnSecondary } from "@/components/ui/styles";
import { frameOf } from "@/lib/shot-url";

// The large screenshot viewer of the owner's review queue
// (components/admin/StatusReviewQueue.tsx): a thumbnail opens it on that view.
// It shows the whole capture, scrollable inside the viewer: the full-page
// frame (full.jpg, lib/shots.ts fullOf) when the capture has one, else the
// stored top screenshot at full size (hero.jpg on a desktop, mobile.jpg on a
// phone). Desktop and Phone are tabs (the tablist pattern: arrow keys, Home
// and End move between them). Confirm and Reject act on the row, through the
// same handler as the row's own buttons, with the same pending, done and
// error states.
//
// A native <dialog> opened with showModal(): the page behind is inert, so
// focus stays inside, Esc closes it, and focus goes back to the thumbnail
// that opened it. On a phone it fills the screen, the image scrolls and the
// buttons stay in the footer.

export type ViewerFrame = "desktop" | "phone";

const TABS: { id: ViewerFrame; label: string }[] = [
  { id: "desktop", label: "Desktop" },
  { id: "phone", label: "Phone" },
];

export function ShotViewer({
  domain,
  url,
  base,
  frame: initial,
  proposed,
  busy,
  error,
  done,
  onDecide,
  onClose,
  returnFocus,
  prompt = null,
}: {
  domain: string;
  url: string;
  /** `${SHOTS_BASE_URL}/${shot_key}`, or null without a capture. */
  base: string | null;
  frame: ViewerFrame;
  proposed: "relist" | "remove" | "review";
  busy: boolean;
  error: string | null;
  /** The decision once it went through, else null. */
  done: "confirm" | "reject" | null;
  onDecide: (action: "confirm" | "reject") => void;
  onClose: () => void;
  /** The thumbnail that opened the viewer, focused again when it closes (when it is still on the page). */
  returnFocus: HTMLElement | null;
  /** The grading prompt's version, when the row recorded it. */
  prompt?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [frame, setFrame] = useState<ViewerFrame>(initial);
  // The desktop view tries the full-page frame first and falls back to the top screenshot.
  const [noFull, setNoFull] = useState(false);
  const id = useId();
  const title = `${id}-title`;
  const panel = `${id}-panel`;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    // The page behind doesn't scroll while the viewer is open.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    tabs.current[TABS.findIndex((t) => t.id === initial)]?.focus();
    return () => {
      root.style.overflow = overflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
    // Opened once per mount; the parent mounts a new viewer for each thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const src = !base ? null : frame === "phone" ? frameOf(base, "mobile.jpg") : frameOf(base, noFull ? "hero.jpg" : "full.jpg");

  function onTabKey(e: React.KeyboardEvent, i: number) {
    const last = TABS.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setFrame(TABS[next].id);
    tabs.current[next]?.focus();
  }

  const confirmLabel = proposed === "review" ? "Mark checked" : "Confirm";
  const doneText = done === "confirm" ? (proposed === "review" ? "Marked checked." : "Confirmed: the change is applied.") : done === "reject" ? "Rejected: nothing changed." : null;

  return (
    <dialog
      ref={ref}
      aria-labelledby={title}
      aria-modal="true"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        // Tab wraps around inside the viewer (a modal dialog would otherwise hand focus to the browser's own controls).
        if (e.key !== "Tab" || !ref.current) return;
        const all = [...ref.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
        if (!all.length) return;
        const first = all[0];
        const last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its box) closes it.
        if (e.target === ref.current) onClose();
      }}
      className="m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden bg-card p-0 text-ink backdrop:bg-black/70 sm:m-auto sm:h-[calc(100dvh-4rem)] sm:w-[min(72rem,calc(100vw-4rem))] sm:rounded-2xl sm:ring-1 sm:ring-edge"
      data-review-viewer
    >
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-edge px-4 py-3 sm:px-5">
          <h2 id={title} className="min-w-0 flex-1 truncate text-base font-bold">
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1.5 hover:text-accent">
              <span className="truncate">{domain}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden />
              <span className="sr-only">(opens the site)</span>
            </a>
          </h2>
          <div role="tablist" aria-label="Screenshot" className="order-last flex w-full gap-1 rounded-lg bg-raised p-1 sm:order-none sm:w-auto">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${t.id}`}
                aria-selected={frame === t.id}
                aria-controls={panel}
                tabIndex={frame === t.id ? 0 : -1}
                onClick={() => setFrame(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
                className="inline-flex h-9 flex-1 items-center justify-center rounded-md px-4 text-sm font-semibold text-mute transition hover:text-ink aria-selected:bg-card aria-selected:text-ink aria-selected:shadow-[var(--card-hi)] sm:flex-none"
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className={`${btnIcon} h-10 w-10`} onClick={onClose} aria-label="Close the screenshot" data-review-viewer-close>
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div
          id={panel}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${frame}`}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          data-review-viewer-scroll
        >
          {src ? (
            // The whole capture at its own size (scaled down only to fit the width), scrolled here.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={src}
              src={src}
              alt={`${domain} on a ${frame}, the whole capture`}
              onError={() => {
                if (frame === "desktop" && !noFull) setNoFull(true);
              }}
              className={`mx-auto block h-auto ${frame === "phone" ? "w-[390px] max-w-full" : "w-full max-w-[1440px]"}`}
              data-review-viewer-image={frame}
            />
          ) : (
            <p className="grid h-full place-items-center p-6 text-sm text-mute">No capture to show.</p>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-edge bg-card px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
          {doneText ? (
            <p className="mr-auto text-sm font-semibold" role="status">
              {doneText}
            </p>
          ) : (
            <>
              <button type="button" className={btnSecondary} disabled={busy} onClick={() => onDecide("confirm")} data-review-viewer-confirm>
                <Check className="h-4 w-4" aria-hidden /> {busy ? "Working..." : confirmLabel}
              </button>
              <button type="button" className={btnGhost} disabled={busy} onClick={() => onDecide("reject")} data-review-viewer-reject>
                <X className="h-4 w-4" aria-hidden /> Reject
              </button>
              {error && (
                <p className="text-sm text-down" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
          {doneText && (
            <button type="button" className={btnGhost} onClick={onClose}>
              Close
            </button>
          )}
          {prompt && (
            <p className="ml-auto text-xs text-mute" data-review-viewer-prompt>
              Graded with prompt <span className="font-mono text-ink">{prompt}</span>
            </p>
          )}
        </footer>
      </div>
    </dialog>
  );
}
