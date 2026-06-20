"use client";

import { useState } from "react";
import { ShareButton } from "@/components/ShareButton";

export type ListItem = { url: string; name: string; domain: string };

/**
 * Renders a shared list. Visitors get a read-only grid + share. The owner also
 * gets an inline edit bar (rename, public/private, delete) and a remove (✕) on
 * each card. All mutations are owner-scoped server-side; this is UI + optimistic
 * state. Adding portfolios happens from a portfolio's "Add to list" picker.
 */
export function ListView({
  listId,
  slug,
  initialName,
  initialPublic,
  isOwner,
  items: initialItems,
  shareUrl,
}: {
  listId: number;
  slug: string;
  initialName: string;
  initialPublic: boolean;
  isOwner: boolean;
  items: ListItem[];
  shareUrl: string;
}) {
  const [name, setName] = useState(initialName);
  const [isPublic, setIsPublic] = useState(initialPublic);
  const [items, setItems] = useState(initialItems);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialName);
  const [busy, setBusy] = useState(false);

  const saveName = async () => {
    const next = draft.trim();
    if (!next || next === name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/lists/${listId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        setName(next);
        setEditing(false); // only close on success, so a failed save keeps the draft
      }
    } catch {
      /* keep the editor open so the typed name isn't silently lost */
    }
    setBusy(false);
  };

  const togglePublic = async () => {
    setBusy(true);
    const next = !isPublic;
    setIsPublic(next);
    try {
      const res = await fetch(`/api/lists/${listId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPublic: next }),
      });
      if (!res.ok) setIsPublic(!next);
    } catch {
      setIsPublic(!next);
    }
    setBusy(false);
  };

  const del = async () => {
    if (!window.confirm(`Delete "${name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lists/${listId}`, { method: "DELETE" });
      if (res.ok) {
        window.location.href = "/profile";
        return;
      }
    } catch {
      /* ignore */
    }
    setBusy(false);
  };

  const removeItem = async (url: string) => {
    setItems((it) => it.filter((x) => x.url !== url)); // optimistic
    try {
      await fetch(`/api/lists/${listId}/items?url=${encodeURIComponent(url)}`, {
        method: "DELETE",
      });
    } catch {
      /* the page reloads to truth on next visit */
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") setEditing(false);
                }}
                maxLength={60}
                autoFocus
                className="rounded-md border border-edge bg-bg px-2 py-1 text-2xl font-bold outline-none focus:border-mute"
              />
              <button
                onClick={saveName}
                disabled={busy}
                className="text-sm font-semibold text-accent"
              >
                Save
              </button>
            </div>
          ) : (
            <h1 className="truncate text-3xl font-bold tracking-tight">{name}</h1>
          )}
          <p className="mt-1 text-sm text-mute">
            {items.length} portfolio{items.length === 1 ? "" : "s"}
            {isOwner && !isPublic && " · private (only you can see this)"}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {(isPublic || isOwner) && (
            <ShareButton url={shareUrl} title={name} label="Share list" />
          )}
          {isOwner && (
            <>
              <button
                onClick={togglePublic}
                disabled={busy}
                className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${
                  isPublic
                    ? "border-accent/50 text-accent"
                    : "border-edge text-mute hover:border-mute"
                }`}
              >
                {isPublic ? "Public" : "Private"}
              </button>
              {!editing && (
                <button
                  onClick={() => {
                    setDraft(name);
                    setEditing(true);
                  }}
                  className="rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-mute transition hover:border-mute hover:text-ink"
                >
                  Rename
                </button>
              )}
              <button
                onClick={del}
                disabled={busy}
                className="rounded-lg border border-edge px-3 py-2 text-sm font-semibold text-mute transition hover:border-rose-400/50 hover:text-rose-400"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-edge py-12 text-center text-sm text-mute">
          This list is empty
          {isOwner && " — add portfolios with “Add to list” on any portfolio page"}
          .
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 pb-12 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <div
              key={p.url}
              className="group relative flex items-center gap-2.5 rounded-xl border border-edge bg-card p-4 transition hover:border-mute"
            >
              <a
                href={`/p/${encodeURIComponent(p.url)}`}
                className="flex min-w-0 flex-1 items-center gap-2.5"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://www.google.com/s2/favicons?domain=${p.domain}&sz=64`}
                  alt=""
                  loading="lazy"
                  className="h-7 w-7 shrink-0 rounded-md bg-edge"
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="truncate text-xs text-mute">{p.domain}</p>
                </div>
              </a>
              {isOwner && (
                <button
                  onClick={() => removeItem(p.url)}
                  title="Remove from list"
                  aria-label={`Remove ${p.name}`}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-mute opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
