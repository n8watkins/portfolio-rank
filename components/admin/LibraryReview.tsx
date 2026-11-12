"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUndoToast } from "@/components/UndoToast";
import { ALT_MAX, SUBJECT_MAX, SUBJECT_MIN, TAGS_MAX, cleanAlt, cleanSubject, cleanTags } from "@/lib/content/library.mjs";
import { VIEWS, countsText, describeMake, filterImages, idleReason, imageTags, makeChoices, progressText, searchImages, tagCounts, viewCounts, withStatuses } from "@/lib/content/library-view.mjs";

export type PostLink = { postId: string; title: string | null; status: string | null; slot: string; kind: string };
export type LibraryImage = {
  id: string;
  theme: string;
  themeLabel: string;
  subject: string | null;
  alt: string;
  tags: string[];
  style: string;
  model: string | null;
  status: string;
  note: string | null;
  uses: number;
  createdAt: string;
  posts: PostLink[];
};
export type QueueItem = { theme: string; themeLabel: string; index: number; subject: string; original: string; edited: boolean; skipped: boolean; prompt: string; alt: string; tags: string[] };
export type Usage = { images: number; maxImages: number; lastHour: number; perHour: number; neurons: number; ceiling: number };
export type Room = { remaining: number; blocker: string | null; nextAt: string | null; quiet: boolean; off: string | null };
type Action = "keep" | "drop" | "retire";
type Batch = { made?: { id: string; status: string }[]; reason?: string; nextAt?: string; stopped?: string; error?: string; usage?: Usage; gatewayLimit?: number };
type Post = (url: string, body: unknown) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

const ACTIONS_FOR: Record<string, Action[]> = { pending: ["keep", "drop"], "rejected-auto": ["keep", "drop"], approved: ["retire"] };
const LABEL: Record<Action, string> = { keep: "Keep", drop: "Drop", retire: "Retire" };
const STATUS_LABEL: Record<string, string> = { pending: "To review", approved: "Approved", rejected: "Dropped", "rejected-auto": "Failed the check", retired: "Retired" };
const HINT: Record<string, string> = {
  review: "Passed the Gemini check. Keep adds it to the library; Drop takes it out (Undo brings it back).",
  approved: "Used by posts when their tags match. Retire stops it being used again.",
  dropped: "Dropped by you. Never used, never deleted.",
  failed: "The Gemini check found a problem (the note says which). Keep one anyway if the check was wrong.",
  all: "Every image, whatever its status.",
};
const EMPTY: Record<string, string> = {
  review: "Nothing to review. Make some above, or new ones arrive with the daily run.",
  approved: "Nothing approved yet.",
  dropped: "Nothing dropped.",
  failed: "Nothing failed the check.",
  all: "No images yet.",
};
const KIND_LABEL: Record<string, string> = { used: "used in", considered: "considered for", made: "made for" };

const btn = "inline-flex min-h-10 items-center rounded-lg border border-edge-strong bg-raised px-3 text-sm font-semibold hover:border-accent disabled:opacity-50";
const small = "inline-flex min-h-9 items-center rounded-lg border border-edge-strong px-3 text-xs font-semibold hover:border-accent disabled:opacity-50";

function Spinner() {
  return <span aria-hidden className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-edge-strong border-t-accent" />;
}

/** The review page: make images (with progress), tabs with counts, search and tags, drop with Undo, and the queue. */
export function LibraryReview({
  images,
  queue,
  subjects,
  usage: initialUsage,
  room: initialRoom,
  themes,
  houseStyle,
}: {
  images: LibraryImage[];
  queue: QueueItem[];
  subjects: number;
  usage: Usage;
  room: Room;
  themes: { id: string; label: string }[];
  houseStyle: string;
}) {
  const router = useRouter();
  const showToast = useUndoToast();
  const [view, setView] = useState("review");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [overlay, setOverlay] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState<{ index: number; total: number; avgMs: number | null } | null>(null);
  const [usage, setUsage] = useState<Usage>(initialUsage);
  const [pick, setPick] = useState(0);

  // The server's numbers win whenever the page reloads its data.
  const [seen, setSeen] = useState(initialUsage);
  if (seen !== initialUsage) {
    setSeen(initialUsage);
    setUsage(initialUsage);
  }

  const shown: LibraryImage[] = withStatuses(images, overlay);
  const counts = viewCounts(shown);
  const inView: LibraryImage[] = filterImages(shown, view);
  const list = searchImages<LibraryImage>(inView, { query, tag });
  const tags = tagCounts(shown);
  // What is left now: the server's room, narrowed by what this page has made since it loaded.
  const made = Math.max(0, usage.images - initialUsage.images);
  const remaining = Math.max(0, Math.min(initialRoom.remaining - made, usage.maxImages - usage.images, usage.perHour - usage.lastHour));
  const choices = initialRoom.off || initialRoom.quiet ? [] : makeChoices(remaining);
  // "Make up to N": what is left of the day.
  const upTo = remaining;
  const count = choices.includes(pick) ? pick : (choices.find((c) => c >= 2) ?? choices[choices.length - 1] ?? 0);
  const idle = idleReason({ ...initialRoom, remaining }, usage);

  const post: Post = async (url, body) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
  };

  const unlay = (id: string) =>
    setOverlay((o) => {
      const rest = { ...o };
      delete rest[id];
      return rest;
    });

  const act = async (img: LibraryImage, action: Action) => {
    setMessage("");
    const to = action === "keep" ? "approved" : action === "retire" ? "retired" : "rejected";
    // The card moves at once; a refusal puts it back and says why.
    setOverlay((o) => ({ ...o, [img.id]: to }));
    const r = await post("/api/admin/library", { id: img.id, action });
    if (!r.ok) {
      unlay(img.id);
      setMessage(`Could not ${action} that image: ${String(r.data?.error ?? "error")}`);
      return;
    }
    if (action === "drop") {
      const back = img.status;
      showToast({
        id: `image:${img.id}`,
        message: "Image dropped",
        undo: async () => {
          const u = await post("/api/admin/library", { id: img.id, action: "restore", to: back });
          if (!u.ok) throw new Error("restore_failed");
          setOverlay((o) => ({ ...o, [img.id]: back }));
          router.refresh();
        },
      });
    }
    router.refresh();
  };

  /** Runs `n` images one request at a time, so each gets its own progress and result. */
  const make = async (n: number, custom?: { subject: string; theme?: string }) => {
    setBusy(true);
    setMessage("");
    const done: { id: string; status: string }[] = [];
    let last: Batch = {};
    const started = Date.now();
    for (let i = 1; i <= n; i++) {
      setProgress({ index: i, total: n, avgMs: done.length ? (Date.now() - started) / done.length : null });
      const r = await post("/api/admin/library/generate", custom ? { count: 1, custom } : { count: 1 });
      const data = r.data as Batch;
      last = r.ok || data.reason ? data : { reason: "error", stopped: String(data.error ?? "the request failed"), usage: last.usage };
      if (data.usage) setUsage(data.usage);
      done.push(...(data.made ?? []));
      if (data.reason || data.error || !data.made?.length) break;
    }
    setProgress(null);
    setMessage(describeMake({ requested: n, made: done, reason: last.reason, nextAt: last.nextAt, stopped: last.stopped, usage: last.usage ?? usage, gatewayLimit: last.gatewayLimit }));
    setBusy(false);
    router.refresh();
    if (done.length) setView(done.some((m) => m.status === "pending") ? "review" : "failed");
    return done.length;
  };

  return (
    <div className="space-y-10">
      <section aria-labelledby="h-make" className="space-y-3 rounded-xl border border-edge bg-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="h-make" className="text-lg font-bold tracking-tight">
            Make images
          </h2>
          <span className="text-sm font-semibold tabular-nums" data-ai-counts>
            {countsText(usage)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {choices.length > 0 && (
            <>
              <label className="sr-only" htmlFor="make-count">
                How many images
              </label>
              <select id="make-count" value={count} onChange={(e) => setPick(Number(e.target.value))} disabled={busy} className="min-h-10 rounded-lg border border-edge-strong bg-raised px-2 text-sm">
                {choices.map((c: number) => (
                  <option key={c} value={c}>
                    {c === remaining && c > 1 ? `${c} (the rest of today)` : c}
                  </option>
                ))}
              </select>
            </>
          )}
          <button type="button" onClick={() => make(count)} disabled={busy || !count} className={btn}>
            {count ? `Make ${count} now` : "Make now"}
          </button>
          {choices.length > 0 && count !== upTo && upTo > 1 && (
            <button type="button" onClick={() => make(upTo)} disabled={busy} className={btn}>
              Make up to {upTo}
            </button>
          )}
        </div>
        {progress ? (
          <div role="status" aria-live="polite" className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm" data-make-progress>
              <Spinner />
              {progressText(progress.index, progress.total, progress.avgMs)}
            </p>
            <progress className="h-1.5 w-full max-w-sm accent-[#fbbf24]" max={progress.total} value={progress.index - 1} aria-label="Images made" />
          </div>
        ) : (
          <p className="text-sm text-mute" role="status" aria-live="polite" data-make-message>
            {message || idle || `${usage.maxImages} a day at most, none from 8 pm to midnight Pacific, within the free Workers AI allowance. About 5 to 10 seconds an image.`}
          </p>
        )}
        <MakeYourOwn busy={busy} themes={themes} houseStyle={houseStyle} disabled={!choices.length} onMake={(c) => make(1, c)} />
      </section>

      <section aria-labelledby="h-images">
        <h2 id="h-images" className="sr-only">
          Images
        </h2>
        <div role="tablist" aria-label="Image status" className="flex flex-wrap gap-2">
          {VIEWS.map((v: { id: string; label: string }) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              id={`tab-${v.id}`}
              aria-selected={view === v.id}
              aria-controls="image-panel"
              onClick={() => setView(v.id)}
              className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${view === v.id ? "border-accent bg-raised" : "border-edge hover:border-edge-strong"}`}
            >
              {v.label} <span className="text-mute">({counts[v.id]})</span>
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="image-search">
            Search images
          </label>
          <input
            id="image-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 100))}
            placeholder="Search alt text, subject, tags"
            className="min-h-10 w-full rounded-lg border border-edge-strong bg-card px-3 text-sm sm:w-72"
          />
          <label className="sr-only" htmlFor="image-tag">
            Filter by tag
          </label>
          <select id="image-tag" value={tag} onChange={(e) => setTag(e.target.value)} className="min-h-10 max-w-full rounded-lg border border-edge-strong bg-card px-2 text-sm">
            <option value="">All tags</option>
            {tags.map((t: { tag: string; n: number }) => (
              <option key={t.tag} value={t.tag}>
                {t.tag} ({t.n})
              </option>
            ))}
          </select>
          {(query || tag) && (
            <button type="button" onClick={() => (setQuery(""), setTag(""))} className={small}>
              Clear
            </button>
          )}
        </div>
        <div id="image-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
          <p className="mt-3 text-sm text-mute">
            {HINT[view]}
            {(query || tag) && ` Showing ${list.length} of ${inView.length}.`}
          </p>
          {list.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-edge bg-card p-6 text-sm text-mute">{query || tag ? "No image matches that search." : EMPTY[view]}</p>
          ) : (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((img) => (
                <ImageCard key={img.id} img={img} showStatus={view === "all"} onAct={act} onTag={setTag} post={post} onSaved={() => router.refresh()} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <UpNext queue={queue} subjects={subjects} busy={busy} onChanged={() => router.refresh()} post={post} />
    </div>
  );
}

/** "Make your own": a subject (and a theme), the final prompt with the house style, then Make. */
function MakeYourOwn({ busy, themes, houseStyle, disabled, onMake }: { busy: boolean; themes: { id: string; label: string }[]; houseStyle: string; disabled: boolean; onMake: (c: { subject: string; theme?: string }) => Promise<number> }) {
  const [subject, setSubject] = useState("");
  const [theme, setTheme] = useState("");
  const cleaned = cleanSubject(subject);
  const finalPrompt = cleaned.ok ? `${cleaned.subject}. ${houseStyle}` : "";
  const go = async () => {
    if (!cleaned.ok) return;
    const n = await onMake({ subject: cleaned.subject, ...(theme ? { theme } : {}) });
    if (n) setSubject("");
  };
  return (
    <details className="rounded-lg border border-edge bg-raised p-3">
      <summary className="cursor-pointer text-sm font-semibold">Make your own</summary>
      <div className="mt-3 space-y-3">
        <label className="block text-sm font-semibold" htmlFor="own-subject">
          What should it show?
        </label>
        <textarea
          id="own-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value.slice(0, SUBJECT_MAX + 50))}
          rows={3}
          maxLength={SUBJECT_MAX + 50}
          placeholder="A flat browser window with a row of project cards, one raised in amber"
          className="w-full rounded-lg border border-edge-strong bg-card p-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor="own-theme" className="font-semibold">
            Theme (optional)
          </label>
          <select id="own-theme" value={theme} onChange={(e) => setTheme(e.target.value)} className="min-h-10 max-w-full rounded-lg border border-edge-strong bg-card px-2">
            <option value="">None</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <span className={!cleaned.ok && subject ? "text-down" : "text-mute"}>{cleaned.ok ? `${cleaned.subject.length} of ${SUBJECT_MAX}` : subject ? cleaned.error : `${SUBJECT_MIN} to ${SUBJECT_MAX} characters`}</span>
        </div>
        <div>
          <p className="text-xs font-semibold text-mute">The prompt Workers AI will get (your words, then the house style)</p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-card p-2 text-xs text-mute" data-own-prompt>
            {finalPrompt || "Write a subject to see the final prompt."}
          </pre>
        </div>
        <button type="button" onClick={go} disabled={busy || disabled || !cleaned.ok} className={btn}>
          Make this one
        </button>
        <p className="text-xs text-mute">It counts against the hour and the day, gets the same Gemini check, and lands in To review.</p>
      </div>
    </details>
  );
}

/** One image: the picture, alt text and tags (editable), the posts it is tied to, and its actions. */
function ImageCard({ img, showStatus, onAct, onTag, post, onSaved }: { img: LibraryImage; showStatus: boolean; onAct: (img: LibraryImage, a: Action) => void; onTag: (t: string) => void; post: Post; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [alt, setAlt] = useState(img.alt);
  const [tagText, setTagText] = useState(img.tags.join(", "));
  const [error, setError] = useState("");
  const altCheck = cleanAlt(alt);
  const tagCheck = cleanTags(tagText);
  const save = async () => {
    if (!altCheck.ok || !tagCheck.ok) return;
    const r = await post("/api/admin/library", { id: img.id, action: "edit", alt: altCheck.alt, tags: tagCheck.tags });
    if (!r.ok) return setError(String(r.data?.error ?? "Could not save"));
    setError("");
    setEditing(false);
    onSaved();
  };
  const posts = img.posts.filter((p, i, all) => all.findIndex((q) => q.postId === p.postId && q.kind === p.kind) === i);
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-edge bg-card" data-image={img.id}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`/api/admin/library/${img.id}/image`} alt={img.alt} loading="lazy" className="aspect-video w-full bg-raised object-cover" />
      <div className="flex flex-1 flex-col gap-2 p-3 text-sm">
        <p className="font-semibold">
          {img.themeLabel}
          {showStatus && <span className="ml-2 text-xs font-normal text-mute">{STATUS_LABEL[img.status] ?? img.status}</span>}
        </p>
        {editing ? (
          <div className="space-y-2">
            <label className="block text-xs font-semibold" htmlFor={`alt-${img.id}`}>
              Alt text
            </label>
            <textarea id={`alt-${img.id}`} value={alt} onChange={(e) => setAlt(e.target.value.slice(0, ALT_MAX + 40))} rows={3} className="w-full rounded-lg border border-edge-strong bg-raised p-2 text-sm" />
            <p className={`text-xs ${altCheck.ok ? "text-mute" : "text-down"}`}>{altCheck.ok ? `${altCheck.alt.length} of ${ALT_MAX}` : altCheck.error}</p>
            <label className="block text-xs font-semibold" htmlFor={`tags-${img.id}`}>
              Tags, separated by commas
            </label>
            <input id={`tags-${img.id}`} value={tagText} onChange={(e) => setTagText(e.target.value.slice(0, 600))} className="min-h-10 w-full rounded-lg border border-edge-strong bg-raised px-2 text-sm" />
            <p className={`text-xs ${tagCheck.ok ? "text-mute" : "text-down"}`}>{tagCheck.ok ? `${tagCheck.tags.length} of ${TAGS_MAX}` : tagCheck.error}</p>
            {error && <p className="text-xs text-down">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={save} disabled={!altCheck.ok || !tagCheck.ok} className="inline-flex min-h-9 items-center rounded-lg bg-fill px-3 text-sm font-semibold text-on-fill disabled:opacity-50">
                Save
              </button>
              <button type="button" onClick={() => (setEditing(false), setAlt(img.alt), setTagText(img.tags.join(", ")), setError(""))} className={small}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-mute" data-alt>
              <span className="sr-only">Alt text: </span>
              {img.alt}
            </p>
            <ul className="flex flex-wrap gap-1" aria-label="Tags">
              {imageTags(img).map((t: string) => (
                <li key={t}>
                  <button type="button" onClick={() => onTag(t)} className={`rounded-full border px-2 py-0.5 text-xs hover:border-accent ${t === img.style ? "border-dashed border-edge-strong text-mute" : "border-edge text-mute"}`}>
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {posts.length > 0 && (
          <ul className="space-y-0.5 text-xs text-mute" aria-label="Posts" data-posts>
            {posts.slice(0, 4).map((p) => (
              <li key={`${p.kind}:${p.postId}`} className="truncate">
                {KIND_LABEL[p.kind] ?? p.kind}{" "}
                <Link href={`/admin/blog/${p.postId}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                  {p.title ?? "a removed draft"}
                </Link>
                {p.status && ` (${p.status})`}
              </li>
            ))}
            {posts.length > 4 && <li>and {posts.length - 4} more</li>}
          </ul>
        )}
        <p className="text-xs text-mute">
          {img.model ?? "unknown model"} · {img.createdAt.slice(0, 10)}
          {img.status === "approved" || img.status === "retired" ? ` · used in ${img.uses} post${img.uses === 1 ? "" : "s"}` : ""}
        </p>
        {img.note && img.note !== "ok" && <p className="text-xs text-mute">Check: {img.note}</p>}
        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {(ACTIONS_FOR[img.status] ?? []).map((a) => (
            <button key={a} type="button" onClick={() => onAct(img, a)} className={`inline-flex min-h-9 items-center rounded-lg px-3 text-sm font-semibold ${a === "keep" ? "bg-fill text-on-fill" : "border border-edge-strong hover:border-accent"}`}>
              {LABEL[a]}
            </button>
          ))}
          {!editing && (
            <button type="button" onClick={() => setEditing(true)} className={small}>
              Edit alt and tags
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** The queued subjects: what the daily run and Make now will make next, each editable or skippable. */
function UpNext({ queue, subjects, busy, onChanged, post }: { queue: QueueItem[]; subjects: number; busy: boolean; onChanged: () => void; post: Post }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
  const live = queue.filter((q) => !q.skipped);
  const skipped = queue.length - live.length;
  const rows = all ? queue : queue.slice(0, 8);
  const key = (q: QueueItem) => `${q.theme}#${q.index}`;
  const check = cleanSubject(draft);

  const send = async (q: QueueItem, op: string, subject?: string) => {
    const r = await post("/api/admin/library/queue", { theme: q.theme, index: q.index, op, subject });
    if (!r.ok) return setError(String(r.data?.error ?? "Could not change that subject"));
    setError("");
    setEditing(null);
    onChanged();
  };

  return (
    <section aria-labelledby="h-next">
      <h2 id="h-next" className="text-xl font-bold tracking-tight">
        Up next <span className="text-mute" data-queue-count>({live.length} of {subjects} left{skipped ? `, ${skipped} skipped` : ""})</span>
      </h2>
      <p className="mt-1 text-sm text-mute">The daily run and Make now take these in order, one from each theme in turn. Edit the wording or skip one before it is made; every prompt ends with the house style (flat 2D vector, warm greys with one amber accent, no text, no people).</p>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <ol className="mt-4 space-y-2">
        {rows.map((q) => (
          <li key={key(q)} className={`rounded-xl border border-edge bg-card p-3 text-sm ${q.skipped ? "opacity-60" : ""}`} data-queue={key(q)}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-semibold">
                {q.themeLabel}{" "}
                <span className="text-xs font-normal text-mute">
                  #{q.index + 1}
                  {q.edited ? " · edited" : ""}
                  {q.skipped ? " · skipped" : ""}
                </span>
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(key(q));
                    setDraft(q.subject);
                  }}
                  className={small}
                >
                  Edit
                </button>
                <button type="button" disabled={busy} onClick={() => send(q, q.skipped ? "unskip" : "skip")} className={small}>
                  {q.skipped ? "Un-skip" : "Skip"}
                </button>
                {q.edited && (
                  <button type="button" disabled={busy} onClick={() => send(q, "reset")} className={small}>
                    Reset
                  </button>
                )}
              </div>
            </div>
            {editing === key(q) ? (
              <div className="mt-2 space-y-2">
                <label className="sr-only" htmlFor={`edit-${key(q)}`}>
                  Subject
                </label>
                <textarea id={`edit-${key(q)}`} value={draft} onChange={(e) => setDraft(e.target.value.slice(0, SUBJECT_MAX + 50))} rows={3} className="w-full rounded-lg border border-edge-strong bg-raised p-2 text-sm" />
                <p className={`text-xs ${check.ok ? "text-mute" : "text-down"}`}>{check.ok ? `${check.subject.length} of ${SUBJECT_MAX}` : check.error}</p>
                <div className="flex gap-2">
                  <button type="button" disabled={!check.ok || busy} onClick={() => send(q, "edit", draft)} className="inline-flex min-h-9 items-center rounded-lg bg-fill px-3 text-sm font-semibold text-on-fill disabled:opacity-50">
                    Save
                  </button>
                  <button type="button" onClick={() => setEditing(null)} className={small}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="mt-1 text-mute">{q.subject}</p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-mute">Full prompt, alt text and tags</summary>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-mute">{q.prompt}</p>
                  <p className="mt-1 text-xs text-mute">
                    <strong>Alt:</strong> {q.alt}
                  </p>
                  <p className="mt-1 text-xs text-mute">
                    <strong>Tags:</strong> {q.tags.join(", ")}
                  </p>
                </details>
              </>
            )}
          </li>
        ))}
      </ol>
      {queue.length > 8 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-3 min-h-11 text-sm font-semibold text-mute hover:text-ink">
          {all ? "Show fewer" : `Show all ${queue.length}`}
        </button>
      )}
    </section>
  );
}
