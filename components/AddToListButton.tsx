"use client";

import { useEffect, useState } from "react";
import { SignInModal } from "@/components/SignInModal";

type List = {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  count: number;
  contains: boolean;
};

/**
 * "Save to a list" picker. Lazily loads the rater's lists (with a per-url
 * `contains` flag) on open, toggles membership inline, and can create a new
 * list that the url is added to immediately. Anon raters see a sign-in prompt.
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
  const [signInOpen, setSignInOpen] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Esc closes the picker (the click-away backdrop is mouse-only otherwise).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const load = async () => {
    try {
      const res = await fetch(`/api/lists?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      setSignedIn(data.signedIn !== false);
      setLists(data.lists ?? []);
    } catch {
      setLists([]);
    }
    setLoaded(true);
  };

  const onOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && !loaded) load();
  };

  const toggleMembership = async (list: List) => {
    if (busyId !== null) return;
    if (!signedIn) {
      setSignInOpen(true);
      return;
    }
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
        setSignInOpen(true);
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
        setSignInOpen(true);
      } else if (res.ok) {
        const list = await res.json();
        setNewName("");
        // Add the url to the brand-new list, but only reflect membership if the
        // add actually lands — otherwise show the new (empty) list honestly.
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
    <div className={`relative ${className}`}>
      <button
        onClick={onOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink"
      >
        📑 {label}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute right-0 z-40 mt-1 w-64 overflow-hidden rounded-lg border border-edge bg-card text-sm shadow-xl"
          >
            {!loaded ? (
              <p className="px-3 py-4 text-center text-xs text-mute">Loading…</p>
            ) : !signedIn ? (
              <div className="px-3 py-4 text-center">
                <p className="text-xs text-mute">
                  Sign in to save portfolios to lists.
                </p>
                <button
                  onClick={() => setSignInOpen(true)}
                  className="mt-2 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-bg transition hover:opacity-85"
                >
                  Sign in
                </button>
              </div>
            ) : (
              <>
                {lists.length > 0 && (
                  <ul className="max-h-60 overflow-y-auto py-1">
                    {lists.map((l) => (
                      <li key={l.id}>
                        <button
                          onClick={() => toggleMembership(l)}
                          disabled={busyId === l.id}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-edge disabled:opacity-60"
                        >
                          <span
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                              l.contains
                                ? "border-accent bg-accent text-bg"
                                : "border-edge"
                            }`}
                          >
                            {l.contains ? "✓" : ""}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{l.name}</span>
                          <span className="text-xs tabular-nums text-mute">
                            {l.count}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-edge p-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
                    placeholder="New list name…"
                    maxLength={60}
                    className="w-full rounded-md border border-edge bg-bg px-2 py-1.5 text-xs outline-none transition placeholder:text-mute focus:border-mute"
                  />
                  <button
                    onClick={createAndAdd}
                    disabled={!newName.trim() || creating}
                    className="mt-1.5 w-full rounded-md bg-accent px-2 py-1.5 text-xs font-semibold text-bg transition hover:opacity-85 disabled:opacity-50"
                  >
                    {creating ? "Creating…" : "+ Create & add"}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}

      <SignInModal
        open={signInOpen}
        onClose={() => setSignInOpen(false)}
        title="Sign in to use lists"
        body="Create named lists of portfolios and share them. Sign in to get started."
      />
    </div>
  );
}
