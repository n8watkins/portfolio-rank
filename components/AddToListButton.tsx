"use client";

import { useId, useState } from "react";
import { Modal } from "@/components/Modal";
import { useSignIn } from "@/components/SignInModal";

type List = {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  count: number;
  contains: boolean;
};

const SIGN_IN_PROMPT = {
  title: "Sign in to use lists",
  body: "Create named lists of portfolios and share them. Sign in to get started.",
};

/**
 * "Save to a list" dialog. Lazily loads the rater's lists (with a per-url
 * `contains` flag) on open, toggles membership inline, and can create a new
 * list that the url is added to immediately. Anon raters get the sign-in dialog.
 * A dialog rather than a popover: it stays on screen at any width.
 */
export function AddToListButton({
  url,
  label = "Add to list",
  className = "",
}: {
  url: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const [lists, setLists] = useState<List[]>([]);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const openSignIn = useSignIn();
  const inputId = useId();

  const askToSignIn = () => {
    setOpen(false);
    openSignIn(SIGN_IN_PROMPT);
  };

  /** Fetches the rater's lists; false when they aren't signed in. */
  const load = async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/lists?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      const isSignedIn = data.signedIn !== false;
      setSignedIn(isSignedIn);
      setLists(data.lists ?? []);
      setLoaded(true);
      if (!isSignedIn) askToSignIn();
      return isSignedIn;
    } catch {
      setLists([]);
      setLoaded(true);
      return true;
    }
  };

  // Lists load before anything opens, so a signed-out visitor goes straight to
  // the sign-in dialog instead of seeing this one flash first.
  const onOpen = async () => {
    if (loaded && !signedIn) return openSignIn(SIGN_IN_PROMPT);
    if (!loaded) {
      setOpening(true);
      const ok = await load();
      setOpening(false);
      if (!ok) return;
    }
    setOpen(true);
  };

  const toggleMembership = async (list: List) => {
    if (busyId !== null) return;
    if (!signedIn) return askToSignIn();
    setBusyId(list.id);
    const add = !list.contains;
    // optimistic
    setLists((ls) =>
      ls.map((l) =>
        l.id === list.id
          ? { ...l, contains: add, count: Math.max(0, l.count + (add ? 1 : -1)) }
          : l
      )
    );
    try {
      const res = add
        ? await fetch(`/api/lists/${list.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          })
        : await fetch(
            `/api/lists/${list.id}/items?url=${encodeURIComponent(url)}`,
            { method: "DELETE" }
          );
      if (res.status === 403) {
        await load();
      } else if (res.ok) {
        const data = await res.json();
        if (typeof data.count === "number") {
          setLists((ls) =>
            ls.map((l) => (l.id === list.id ? { ...l, count: data.count } : l))
          );
        }
      } else {
        await load(); // unknown error → resync truth
      }
    } catch {
      await load();
    }
    setBusyId(null);
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 403) {
        askToSignIn();
      } else if (res.ok) {
        const list = await res.json();
        setNewName("");
        // Add the url to the brand-new list, but only reflect membership if the
        // add actually lands - otherwise show the new (empty) list honestly.
        let contains = false;
        let count = 0;
        try {
          const add = await fetch(`/api/lists/${list.id}/items`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url }),
          });
          if (add.ok) {
            const d = await add.json();
            contains = true;
            count = typeof d.count === "number" ? d.count : 1;
          }
        } catch {
          /* list exists but the add failed; leave it empty so state stays honest */
        }
        setLists((ls) => [{ ...list, contains, count }, ...ls]);
      }
    } catch {
      /* leave the input as-is so the user can retry */
    }
    setCreating(false);
  };

  return (
    <div className={className}>
      <button
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-busy={opening}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink ${
          opening ? "cursor-progress opacity-70" : ""
        }`}
      >
        <span aria-hidden>📑</span> {label}
      </button>

      <Modal open={open && signedIn} onClose={() => setOpen(false)} title="Save to a list">
        {lists.length > 0 ? (
          <ul className="-mx-2 mt-4 max-h-[50vh] overflow-y-auto">
            {lists.map((l) => (
              <li key={l.id}>
                <button
                  onClick={() => toggleMembership(l)}
                  disabled={busyId === l.id}
                  role="checkbox"
                  aria-checked={l.contains}
                  className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-edge disabled:opacity-60"
                >
                  <span
                    aria-hidden
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs ${
                      l.contains ? "border-accent bg-accent text-bg" : "border-mute"
                    }`}
                  >
                    {l.contains ? "✓" : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="text-xs tabular-nums text-mute">
                    {l.count} <span className="sr-only">{l.count === 1 ? "portfolio" : "portfolios"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-mute">No lists yet. Name your first one below.</p>
        )}
        <form
          className="mt-4 border-t border-edge pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            createAndAdd();
          }}
        >
          <label htmlFor={inputId} className="text-xs font-semibold text-mute">
            New list
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              id={inputId}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Inspiration"
              maxLength={60}
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-edge bg-bg px-3 text-base outline-none transition placeholder:text-mute focus:border-mute sm:text-sm"
            />
            <button
              type="submit"
              disabled={!newName.trim() || creating}
              className="min-h-11 shrink-0 rounded-lg bg-accent px-3 text-sm font-semibold text-bg transition hover:opacity-85 disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create & add"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
