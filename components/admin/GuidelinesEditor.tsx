"use client";

import Link from "next/link";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { btnGhost, btnPrimary, btnSecondary } from "@/components/ui/styles";

// Editing the editor's guidelines (POST /api/admin/content/guidelines): add,
// edit and remove rules, and turn a note from a rejected or rewritten draft
// into a rule.

type Guideline = { id: number; text: string; fromPost: string | null };
type Suggestion = { postId: string; title: string; note: string };

export function GuidelinesEditor({ initial, suggestions, max }: { initial: Guideline[]; suggestions: Suggestion[]; max: number }) {
  const [list, setList] = useState(initial);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState<Set<string>>(new Set());

  const send = async (body: Record<string, unknown>) => {
    setError(null);
    const res = await fetch("/api/admin/content/guidelines", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as { error?: string; guidelines?: Guideline[] };
    if (!res.ok) {
      setError(data.error ?? "That didn't work. Try again.");
      return false;
    }
    setList(data.guidelines ?? []);
    return true;
  };

  return (
    <div className="space-y-8">
      <section aria-labelledby="h-rules">
        <h2 id="h-rules" className="text-lg font-bold tracking-tight">
          Rules <span className="text-mute tabular-nums">{list.length}</span>
        </h2>
        {list.length === 0 && <p className="mt-2 text-sm text-mute">No rules yet. Add one below, or turn a note from a draft into one.</p>}
        <ol className="mt-3 grid gap-2">
          {list.map((g, i) => (
            <li key={g.id} className={`card flex flex-wrap gap-3 p-3 text-sm ${editing === g.id ? "items-start" : "items-center"}`} data-guideline={g.id}>
              <span className="w-6 shrink-0 font-semibold text-mute tabular-nums">{i + 1}.</span>
              {editing === g.id ? (
                <div className="grid min-w-0 flex-1 gap-2">
                  <label className="sr-only" htmlFor={`g-${g.id}`}>
                    Rule {i + 1}
                  </label>
                  <textarea id={`g-${g.id}`} value={editText} onChange={(e) => setEditText(e.target.value.slice(0, max + 20))} rows={2} className="w-full rounded-lg border border-edge bg-raised px-3 py-2" />
                  <div className="flex gap-2">
                    <button type="button" className={btnPrimary} onClick={async () => (await send({ op: "edit", id: g.id, text: editText })) && setEditing(null)}>
                      Save
                    </button>
                    <button type="button" className={btnGhost} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="min-w-0 flex-1">{g.text}</span>
                  <span className="flex gap-1">
                    <button type="button" className={btnGhost} onClick={() => (setEditing(g.id), setEditText(g.text))}>
                      Edit
                    </button>
                    <button type="button" className={btnGhost} aria-label={`Remove rule ${i + 1}`} onClick={() => send({ op: "remove", id: g.id })}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
        <div className="mt-4 grid gap-2">
          <label htmlFor="new-rule" className="text-sm font-semibold">
            Add a rule
          </label>
          <textarea id="new-rule" value={draft} onChange={(e) => setDraft(e.target.value.slice(0, max + 20))} rows={2} placeholder="Name one real portfolio that does it well." className="w-full rounded-lg border border-edge bg-card px-3 py-2 text-sm" />
          <div className="flex items-center gap-3">
            <button type="button" className={btnSecondary} onClick={async () => (await send({ op: "add", text: draft })) && setDraft("")}>
              <Plus className="h-4 w-4" aria-hidden /> Add
            </button>
            <span className={`text-xs ${draft.length > max ? "text-down" : "text-mute"}`}>
              {draft.trim().length} of {max}
            </span>
          </div>
          {error && (
            <p role="alert" className="text-sm text-down">
              {error}
            </p>
          )}
        </div>
      </section>
      <section aria-labelledby="h-notes">
        <h2 id="h-notes" className="text-lg font-bold tracking-tight">
          From your notes on drafts
        </h2>
        <p className="mt-1 text-sm text-mute">Notes you wrote when rejecting or rewriting a draft. Add one as a rule to apply it to every future draft; shorten it first if it is long.</p>
        {suggestions.filter((s) => !used.has(s.postId + s.note)).length === 0 ? (
          <p className="mt-2 text-sm text-mute">No notes waiting.</p>
        ) : (
          <ul className="mt-3 grid gap-2">
            {suggestions
              .filter((s) => !used.has(s.postId + s.note))
              .map((s) => (
                <li key={s.postId + s.note} className="card p-3 text-sm">
                  <p>&ldquo;{s.note}&rdquo;</p>
                  <p className="mt-1 text-xs text-mute">
                    on{" "}
                    <Link href={`/admin/blog/${s.postId}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                      {s.title}
                    </Link>
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className={btnSecondary} disabled={s.note.length > max} onClick={async () => (await send({ op: "add", text: s.note, fromPost: s.postId })) && setUsed(new Set([...used, s.postId + s.note]))}>
                      <Plus className="h-4 w-4" aria-hidden /> Add as a rule
                    </button>
                    <button type="button" className={btnGhost} onClick={() => setDraft(s.note.slice(0, max))}>
                      Edit first
                    </button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
