"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { isTextField } from "@/lib/dom";
import { createUndoQueue, type UndoEntry, type UndoQueue, type UndoToast } from "@/lib/undo-queue";

// "List deleted · Undo": reversible actions happen at once and this toast offers the way back.
// It lives in the root layout, so it survives the client navigation that follows a delete.

type Show = (entry: Omit<UndoEntry, "id"> & { id?: string }) => void;

const UndoContext = createContext<Show | null>(null);

/** Shows an Undo toast; see lib/undo-queue.ts for when undo and commit run. */
export function useUndoToast() {
  const show = useContext(UndoContext);
  if (!show) throw new Error("useUndoToast must be used inside UndoToastProvider");
  return show;
}

/** Fired after an Undo restored a list, so views that list them reload. */
export const LISTS_CHANGED = "portfoliorank:lists-changed";

/** The "“Name” deleted · Undo" toast for a list that was just soft-deleted. */
export function listDeletedToast(id: number, name: string) {
  const trash = (action: "restore" | "finalize") =>
    fetch(`/api/lists/${id}/trash`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      keepalive: action === "finalize",
    });
  return {
    id: `list:${id}`,
    message: `“${name}” deleted`,
    undo: async () => {
      const res = await trash("restore");
      if (!res.ok) throw new Error("restore_failed");
      window.dispatchEvent(new Event(LISTS_CHANGED));
    },
    commit: () => trash("finalize").then(() => undefined, () => undefined),
  };
}


export function UndoToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<UndoToast[]>([]);
  const [notice, setNotice] = useState("");
  const [queue] = useState<UndoQueue>(() =>
    createUndoQueue({
      onChange: setToasts,
      onUndoError: () => setNotice("That can no longer be restored."),
    })
  );

  useEffect(() => {
    // A closed or backgrounded tab commits now; commits use keepalive requests to finish.
    const flush = () => queue.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [queue]);

  useEffect(() => {
    // Ctrl/Cmd+Z undoes the newest toast while one shows, unless the user is typing.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (!queue.size || isTextField(e.target)) return;
      e.preventDefault();
      void queue.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue]);

  // The pointer or focus that paused the countdown leaves with the last toast.
  useEffect(() => {
    if (!toasts.length) queue.resume();
  }, [toasts, queue]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const show = useCallback<Show>(
    (entry) => {
      setNotice("");
      queue.push({ ...entry, id: entry.id ?? crypto.randomUUID() });
    },
    [queue]
  );

  const value = useMemo(() => show, [show]);

  return (
    <UndoContext.Provider value={value}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-[60] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2"
        onPointerEnter={() => queue.pause()}
        onPointerLeave={() => queue.resume()}
        onFocus={() => queue.pause()}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) queue.resume();
        }}
      >
        {/* A polite live region: announced without moving focus. */}
        <div aria-live="polite" aria-relevant="additions text" className="flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="toast-in pointer-events-auto flex min-h-[52px] items-center gap-1 rounded-xl border border-edge bg-[#1c1c21] py-1.5 pl-4 pr-1.5 text-sm text-ink shadow-2xl shadow-black/60"
            >
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.message}</span>
              <button
                type="button"
                onClick={() => void queue.undo(t.id)}
                className="min-h-11 min-w-11 rounded-lg px-3.5 font-semibold text-accent transition hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-accent"
              >
                Undo
              </button>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => queue.dismiss(t.id)}
                className="grid min-h-11 min-w-11 place-items-center rounded-lg text-mute transition hover:bg-white/10 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
              >
                ✕
              </button>
            </div>
          ))}
          {notice && (
            <div className="toast-in pointer-events-auto rounded-xl border border-edge bg-[#1c1c21] px-4 py-3.5 text-sm text-ink shadow-2xl shadow-black/60">
              {notice}
            </div>
          )}
        </div>
      </div>
    </UndoContext.Provider>
  );
}
