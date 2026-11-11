"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type LibraryImage = {
  id: string;
  theme: string;
  subject: string | null;
  alt: string;
  model: string | null;
  status: string;
  note: string | null;
  uses: number;
  createdAt: string;
};

type Action = "keep" | "drop" | "retire";

const SECTIONS: { status: string; title: string; hint: string; actions: Action[] }[] = [
  { status: "pending", title: "Waiting for you", hint: "Passed the Gemini check. Keep adds it to the library; drop removes it for good.", actions: ["keep", "drop"] },
  { status: "rejected-auto", title: "Failed the check", hint: "The Gemini check found a problem (the note says which). Keep one anyway if the check was wrong.", actions: ["keep", "drop"] },
  { status: "approved", title: "In the library", hint: "Used by posts when their tags match. Retire stops it being used again.", actions: ["retire"] },
  { status: "retired", title: "Retired", hint: "No longer used.", actions: [] },
  { status: "rejected", title: "Dropped", hint: "Never used.", actions: [] },
];

const LABEL: Record<Action, string> = { keep: "Keep", drop: "Drop", retire: "Retire" };

/** The review grid: decisions go to /api/admin/library, one-click manual batches to /generate. */
export function LibraryReview({ images }: { images: LibraryImage[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  const act = async (id: string, action: Action) => {
    setBusy(id);
    setMessage("");
    const r = await post("/api/admin/library", { id, action });
    if (!r.ok) setMessage(`Could not ${action} ${id}: ${r.data?.error ?? "error"}`);
    setBusy(null);
    router.refresh();
  };

  const generate = async () => {
    setBusy("generate");
    setMessage("Making up to 2 images; this takes about half a minute...");
    const r = await post("/api/admin/library/generate", { count: 2 });
    const made = (r.data?.made ?? []) as { status: string }[];
    setMessage(r.ok ? `Made ${made.length}: ${made.map((m) => m.status).join(", ") || "none"}${r.data?.stopped ? `. Stopped: ${r.data.stopped}` : ""}` : `Not started: ${r.data?.stopped ?? r.data?.error ?? "error"}`);
    setBusy(null);
    router.refresh();
  };

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={generate}
          disabled={busy !== null}
          className="rounded-lg border border-edge-strong bg-raised px-3 py-1.5 text-sm font-semibold hover:border-accent disabled:opacity-50"
        >
          Make 2 now
        </button>
        <span className="text-sm text-mute" role="status" aria-live="polite">
          {message || "Up to 2 new images an hour (none from 20:00 to midnight Pacific), at most 40 a day, within the free Workers AI allowance."}
        </span>
      </div>
      {SECTIONS.map((section) => {
        const list = images.filter((i) => i.status === section.status);
        if (!list.length && section.status !== "pending") return null;
        return (
          <section key={section.status} aria-labelledby={`h-${section.status}`}>
            <h2 id={`h-${section.status}`} className="text-xl font-bold tracking-tight">
              {section.title} <span className="text-mute">({list.length})</span>
            </h2>
            <p className="mt-1 text-sm text-mute">{section.hint}</p>
            {list.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-edge bg-card p-6 text-sm text-mute">Nothing waiting. New images arrive after the nightly run.</p>
            ) : (
              <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {list.map((img) => (
                  <li key={img.id} className="overflow-hidden rounded-xl border border-edge bg-card" data-image={img.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/admin/library/${img.id}/image`} alt={img.alt} loading="lazy" className="aspect-video w-full bg-raised object-cover" />
                    <div className="space-y-2 p-3 text-sm">
                      <p className="font-semibold">{img.theme}</p>
                      {img.subject && <p className="line-clamp-3 text-mute">{img.subject}</p>}
                      <p className="text-xs text-mute">
                        {img.model ?? "unknown model"} · {img.createdAt.slice(0, 10)}
                        {section.status === "approved" || section.status === "retired" ? ` · used ${img.uses} time${img.uses === 1 ? "" : "s"}` : ""}
                      </p>
                      {img.note && img.note !== "ok" && <p className="text-xs text-mute">Check: {img.note}</p>}
                      {section.actions.length > 0 && (
                        <div className="flex gap-2 pt-1">
                          {section.actions.map((a) => (
                            <button
                              key={a}
                              type="button"
                              onClick={() => act(img.id, a)}
                              disabled={busy !== null}
                              className={`rounded-lg px-3 py-1 text-sm font-semibold disabled:opacity-50 ${a === "keep" ? "bg-fill text-on-fill" : "border border-edge-strong hover:border-accent"}`}
                            >
                              {LABEL[a]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
