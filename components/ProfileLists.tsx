"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SITE_URL } from "@/lib/site";
import { ShareButton } from "@/components/ShareButton";
import { LISTS_CHANGED, listDeletedToast, useUndoToast } from "@/components/UndoToast";

type List = {
  id: number;
  name: string;
  slug: string;
  isPublic: boolean;
  count: number;
};

/**
 * Lists manager for the profile: create, rename, delete, toggle public/private,
 * share, and open. Talks to /api/lists; all mutations are owner-scoped server
 * side, so this is purely the UI + optimistic state.
 */
export function ProfileLists() {
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const showUndo = useUndoToast();
  const router = useRouter();

  const load = useCallback(() => {
    fetch("/api/lists")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setLists(d?.lists ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // An Undo (here or after deleting from a list's own page) brings a list back;
    // the server-rendered list count above follows along.
    const restored = () => {
      router.refresh();
      load();
    };
    window.addEventListener(LISTS_CHANGED, restored);
    return () => window.removeEventListener(LISTS_CHANGED, restored);
  }, [load, router]);

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const list = await res.json();
        setLists((ls) => [{ ...list }, ...ls]);
        setNewName("");
      }
    } catch {
      /* keep the input so the user can retry */
    }
    setCreating(false);
  };

  const rename = async (id: number) => {
    const name = editName.trim();
    if (!name) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/lists/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setLists((ls) => ls.map((l) => (l.id === id ? { ...l, name } : l)));
        setEditingId(null);
      }
    } catch {
      /* ignore */
    }
    setBusyId(null);
  };

  const togglePublic = async (list: List) => {
    setBusyId(list.id);
    const next = !list.isPublic;
    setLists((ls) =>
      ls.map((l) => (l.id === list.id ? { ...l, isPublic: next } : l))
    );
    try {
      const res = await fetch(`/api/lists/${list.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: next }),
      });
      if (!res.ok) {
        setLists((ls) =>
          ls.map((l) => (l.id === list.id ? { ...l, isPublic: !next } : l))
        );
      }
    } catch {
      setLists((ls) =>
        ls.map((l) => (l.id === list.id ? { ...l, isPublic: !next } : l))
      );
    }
    setBusyId(null);
  };

  // Deletes at once; the toast's Undo restores the list with its items and place.
  const remove = async (list: List) => {
    const index = lists.findIndex((l) => l.id === list.id);
    setError("");
    setLists((ls) => ls.filter((l) => l.id !== list.id));
    const res = await fetch(`/api/lists/${list.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setLists((ls) =>
        ls.some((l) => l.id === list.id) ? ls : [...ls.slice(0, index), list, ...ls.slice(index)]
      );
      setError(`Couldn't delete “${list.name}”. Try again.`);
      return;
    }
    showUndo(listDeletedToast(list.id, list.name));
    router.refresh();
  };

  return (
    <div>
      <div className="mb-4 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="New list name…"
          maxLength={60}
          className="flex-1 rounded-lg border border-edge bg-card px-3 py-2 text-sm outline-none transition placeholder:text-mute focus:border-mute"
        />
        <button
          onClick={create}
          disabled={!newName.trim() || creating}
          className="rounded-lg bg-fill px-4 py-2 text-sm font-semibold text-on-fill transition hover:opacity-85 disabled:opacity-50"
        >
          {creating ? "Creating…" : "+ New list"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm text-rose-400">
          {error}
        </p>
      )}
      {loading ? (
        <p className="py-6 text-center text-sm text-mute">Loading your lists…</p>
      ) : lists.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge py-8 text-center text-sm text-mute">
          No lists yet. Create one above, or hit “Add to list” on any portfolio.
        </p>
      ) : (
        <ul className="space-y-2">
          {lists.map((l) => (
            <li
              key={l.id}
              className="rounded-lg border border-edge bg-card px-4 py-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                {editingId === l.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") rename(l.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      maxLength={60}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-edge bg-bg px-2 py-1 text-sm outline-none focus:border-mute"
                    />
                    <button
                      onClick={() => rename(l.id)}
                      disabled={busyId === l.id}
                      className="text-xs font-semibold text-accent"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-mute"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <a
                    href={`/list/${l.slug}`}
                    className="min-w-0 basis-full truncate text-sm font-semibold hover:underline sm:basis-0 sm:flex-1"
                  >
                    {l.name}
                    <span className="ml-2 text-xs font-normal text-mute">
                      {l.count} item{l.count === 1 ? "" : "s"}
                    </span>
                  </a>
                )}

                <div className="flex shrink-0 items-center gap-2 text-xs">
                  <button
                    onClick={() => togglePublic(l)}
                    disabled={busyId === l.id}
                    title={
                      l.isPublic
                        ? "Public - anyone with the link can view"
                        : "Private - only you can view"
                    }
                    className={`rounded-full border px-2 py-0.5 font-semibold transition ${
                      l.isPublic
                        ? "border-accent/50 text-accent"
                        : "border-edge text-mute"
                    }`}
                  >
                    {l.isPublic ? "Public" : "Private"}
                  </button>
                  {l.isPublic && (
                    <ShareButton
                      url={`${SITE_URL}/list/${l.slug}`}
                      title={l.name}
                      label="Share"
                      className="!px-2 !py-0.5 !text-xs"
                    />
                  )}
                  <button
                    onClick={() => {
                      setEditingId(l.id);
                      setEditName(l.name);
                    }}
                    className="font-semibold text-mute transition hover:text-ink"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => remove(l)}
                    disabled={busyId === l.id}
                    aria-label={`Delete ${l.name}`}
                    className="font-semibold text-mute transition hover:text-rose-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
