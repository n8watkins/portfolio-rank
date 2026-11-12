"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, Check, ChevronLeft, ChevronRight, ImageIcon, Inbox, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { useUndoToast } from "@/components/UndoToast";
import { EmptyState } from "@/components/ui/EmptyState";
import { ALT_MAX, SUBJECT_MAX, SUBJECT_MIN, TAGS_MAX, cleanAlt, cleanSubject, cleanTags } from "@/lib/content/library.mjs";
import { VIEWS, arrivalView, countsText, describeMake, filterImages, idleReason, imageTags, makeChoices, progressText, searchImages, tagCounts, viewCounts, withStatuses } from "@/lib/content/library-view.mjs";

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
const LABEL: Record<Action, string> = { keep: "Approve", drop: "Drop", retire: "Retire" };
const KEY: Partial<Record<Action, string>> = { keep: "a", drop: "d" };
const ICON: Record<Action, typeof Check> = { keep: Check, drop: X, retire: Archive };
const STATUS_LABEL: Record<string, string> = { pending: "To review", approved: "Approved", rejected: "Dropped", "rejected-auto": "Failed the check", retired: "Retired" };
const STATUS_TONE: Record<string, string> = { pending: "text-accent", approved: "text-up", rejected: "text-mute", "rejected-auto": "text-down", retired: "text-mute" };
const HINT: Record<string, string> = {
  review: "Passed the Gemini check. Approve adds it to the library; Drop takes it out (Undo brings it back).",
  approved: "Used by posts when their tags match. Retire stops it being used again.",
  dropped: "Dropped by you. Never used, never deleted.",
  failed: "The Gemini check found a problem (the note says which). Approve one anyway if the check was wrong.",
  all: "Every image, whatever its status.",
};
const EMPTY: Record<string, string> = {
  review: "Nothing to review",
  approved: "Nothing approved yet",
  dropped: "Nothing dropped",
  failed: "Nothing failed the check",
  all: "No images yet",
};
const KIND_LABEL: Record<string, string> = { used: "Used in", considered: "Considered for", made: "Made for" };

const btn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-edge-strong bg-raised px-3 text-sm font-semibold hover:border-accent disabled:opacity-50";
const small = "inline-flex min-h-9 items-center rounded-lg border border-edge-strong px-3 text-xs font-semibold hover:border-accent disabled:opacity-50";
const panel = "group rounded-xl border border-edge bg-card";
const summary = "flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-bold [&::-webkit-details-marker]:hidden";
const imageUrl = (id: string) => `/api/admin/library/${id}/image`;

function Spinner() {
  return <span aria-hidden className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-edge-strong border-t-accent" />;
}

function Chevron() {
  return (
    <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-mute transition group-open:rotate-90 motion-reduce:transition-none" />
  );
}

/** True when a key press comes from a field, where letters and arrows belong to the text. */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

/**
 * The image library: the images are the page. Tabs with counts and the
 * search stay at the top while the thumbnail grid scrolls; a thumbnail opens
 * the image large with its alt text, tags, decision and the drafts that used
 * it. Making images, your own subject, the queue and how images are made sit
 * in compact panels beside the grid (below it on phones). The tab and the
 * open image live in the address (?view=, ?image=), so reload and Back work.
 */
export function LibraryReview({
  images,
  queue,
  subjects,
  usage: initialUsage,
  room: initialRoom,
  themes,
  houseStyle,
  howMade,
}: {
  images: LibraryImage[];
  queue: QueueItem[];
  subjects: number;
  usage: Usage;
  room: Room;
  themes: { id: string; label: string }[];
  houseStyle: string;
  /** "How images are made", rendered on the server from the counters. */
  howMade?: React.ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const showToast = useUndoToast();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [overlay, setOverlay] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [actError, setActError] = useState("");
  const [progress, setProgress] = useState<{ index: number; total: number; avgMs: number | null } | null>(null);
  const [usage, setUsage] = useState<Usage>(initialUsage);
  const [pick, setPick] = useState(0);
  const pushed = useRef(false);

  // The server's numbers win whenever the page reloads its data.
  const [seen, setSeen] = useState(initialUsage);
  if (seen !== initialUsage) {
    setSeen(initialUsage);
    setUsage(initialUsage);
  }

  const shown: LibraryImage[] = withStatuses(images, overlay);
  const counts = viewCounts(shown);
  // With nothing to review, the page opens on the approved images, so there is always something to see.
  const [arrival] = useState(() => arrivalView(counts));
  // The tab and the open image, mirrored in the address (?view=, ?image=); Back and Forward read them back.
  const [address, setAddress] = useState(() => ({ view: params.get("view"), image: params.get("image") }));
  const asked = address.view;
  const view = VIEWS.some((v: { id: string }) => v.id === asked) ? (asked as string) : arrival;
  const inView: LibraryImage[] = filterImages(shown, view);
  const list = searchImages<LibraryImage>(inView, { query, tag });
  const tags = tagCounts(shown);
  const openId = address.image;
  const open = openId ? (shown.find((i) => i.id === openId) ?? null) : null;
  const at = open ? list.findIndex((i) => i.id === open.id) : -1;

  // What is left now: the server's room, narrowed by what this page has made since it loaded.
  const made = Math.max(0, usage.images - initialUsage.images);
  const remaining = Math.max(0, Math.min(initialRoom.remaining - made, usage.maxImages - usage.images, usage.perHour - usage.lastHour));
  const choices = initialRoom.off || initialRoom.quiet ? [] : makeChoices(remaining);
  // "Make up to N": what is left of the day.
  const upTo = remaining;
  const count = choices.includes(pick) ? pick : (choices.find((c) => c >= 2) ?? choices[choices.length - 1] ?? 0);
  const idle = idleReason({ ...initialRoom, remaining }, usage);

  /** Changes the tab or the open image, and ?view= and ?image= with them: a new image is a new history entry, the rest replace it. */
  const setUrl = (next: { view?: string; image?: string | null }, mode: "push" | "replace") => {
    const sp = new URLSearchParams(window.location.search);
    if (next.view !== undefined) sp.set("view", next.view);
    if (next.image !== undefined) {
      if (next.image) sp.set("image", next.image);
      else sp.delete("image");
    }
    setAddress({ view: sp.get("view"), image: sp.get("image") });
    const q = sp.toString();
    const url = q ? `${window.location.pathname}?${q}` : window.location.pathname;
    if (mode === "push") window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  };
  const setView = (v: string) => setUrl({ view: v, image: null }, "replace");
  const openImage = (id: string) => {
    pushed.current = true;
    setUrl({ image: id }, "push");
  };
  const closeImage = () => {
    // Opened from the grid: go Back, so the history has no leftover entry. Opened from a link: just drop ?image=.
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else setUrl({ image: null }, "replace");
  };
  const step = (by: number) => {
    const next = list[at + by];
    if (next) setUrl({ image: next.id }, "replace");
  };
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
      const sp = new URLSearchParams(window.location.search);
      setAddress({ view: sp.get("view"), image: sp.get("image") });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

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
    setActError("");
    const to = action === "keep" ? "approved" : action === "retire" ? "retired" : "rejected";
    // Deciding in the large view moves on to the next image of the tab, so a review is one decision after another.
    if (open?.id === img.id && view !== "all") {
      const i = list.findIndex((x) => x.id === img.id);
      const next = list[i + 1] ?? list[i - 1];
      if (next) setUrl({ image: next.id }, "replace");
      else closeImage();
    }
    // The image moves at once; a refusal puts it back and says why.
    setOverlay((o) => ({ ...o, [img.id]: to }));
    const r = await post("/api/admin/library", { id: img.id, action });
    if (!r.ok) {
      unlay(img.id);
      setActError(`Could not ${LABEL[action].toLowerCase()} that image: ${String(r.data?.error ?? "error")}. It is back where it was.`);
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

  const live = queue.filter((q) => !q.skipped).length;
  const libraryEmpty = counts.all === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start xl:grid-cols-[minmax(0,1fr)_22rem]">
      <section aria-labelledby="h-images" className="min-w-0">
        <h2 id="h-images" className="sr-only">
          Images
        </h2>
        {/* Tabs and search stay in view under the site header while the grid scrolls. */}
        <div className="sticky top-16 z-10 rounded-xl border border-edge bg-card/95 p-2 shadow-[var(--card-hi)] backdrop-blur" data-library-toolbar>
          <div role="tablist" aria-label="Image status" className="flex gap-1.5 overflow-x-auto [scrollbar-width:none]">
            {VIEWS.map((v: { id: string; label: string }) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                id={`tab-${v.id}`}
                aria-selected={view === v.id}
                aria-controls="image-panel"
                onClick={() => setView(v.id)}
                className={`min-h-11 shrink-0 whitespace-nowrap rounded-lg border px-3 text-sm font-semibold ${view === v.id ? "border-accent bg-raised text-ink" : "border-edge text-mute hover:border-edge-strong hover:text-ink"}`}
              >
                {v.label} <span className="tabular-nums text-mute">({counts[v.id]})</span>
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label className="sr-only" htmlFor="image-search">
              Search images
            </label>
            <input
              id="image-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 100))}
              placeholder="Search alt text, subject, tags"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-edge-strong bg-card px-3 text-sm sm:max-w-80"
            />
            <label className="sr-only" htmlFor="image-tag">
              Filter by tag
            </label>
            <select id="image-tag" value={tag} onChange={(e) => setTag(e.target.value)} className="min-h-10 w-32 shrink-0 rounded-lg border border-edge-strong bg-card px-2 text-sm sm:w-44">
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
        </div>
        <div id="image-panel" role="tabpanel" aria-labelledby={`tab-${view}`}>
          <p className="mt-3 text-sm text-mute">
            {HINT[view]}
            {(query || tag) && ` Showing ${list.length} of ${inView.length}.`}
          </p>
          {actError && (
            <p className="mt-2 text-sm text-down" role="alert">
              {actError}
            </p>
          )}
          {list.length === 0 ? (
            libraryEmpty ? (
              <EmptyState icon={ImageIcon} title="The library is empty" className="mt-4" action={<a href="#h-make" className={btn}>Make images</a>}>
                No images have been made on this site yet. Make some now, or the hourly run adds them while the library is on.
              </EmptyState>
            ) : query || tag ? (
              <EmptyState icon={Inbox} title="No image matches that search" className="mt-4" action={<button type="button" className={btn} onClick={() => (setQuery(""), setTag(""))}>Clear the search</button>} />
            ) : (
              <EmptyState
                icon={Inbox}
                title={EMPTY[view]}
                className="mt-4"
                action={
                  view !== "approved" && counts.approved > 0 ? (
                    <button type="button" className={btn} onClick={() => setView("approved")}>
                      See the {counts.approved} approved
                    </button>
                  ) : view === "approved" && counts.review > 0 ? (
                    <button type="button" className={btn} onClick={() => setView("review")}>
                      Review {counts.review}
                    </button>
                  ) : undefined
                }
              >
                {view === "review" ? "New images land here after their Gemini check. Make some with Make images, or wait for the hourly run." : undefined}
              </EmptyState>
            )
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5" aria-label={`${VIEWS.find((v: { id: string }) => v.id === view)?.label} images`}>
              {list.map((img) => (
                <Tile key={img.id} img={img} showStatus={view === "all"} onOpen={() => openImage(img.id)} onAct={act} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside aria-label="Make images and settings" className="grid gap-3 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto lg:pb-2">
        <section aria-labelledby="h-make" className="rounded-xl border border-edge bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="h-make" className="scroll-mt-24 text-sm font-bold" tabIndex={-1}>
              Make images
            </h2>
            <span className="text-xs font-semibold tabular-nums text-mute" data-ai-counts>
              {countsText(usage)}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
            <div role="status" aria-live="polite" className="mt-3 space-y-1.5">
              <p className="flex items-center gap-2 text-sm" data-make-progress>
                <Spinner />
                {progressText(progress.index, progress.total, progress.avgMs)}
              </p>
              <progress className="h-1.5 w-full accent-[#fbbf24]" max={progress.total} value={progress.index - 1} aria-label="Images made" />
            </div>
          ) : (
            <p className="mt-3 text-xs text-mute" role="status" aria-live="polite" data-make-message>
              {message || idle || `${usage.maxImages} a day at most, none from 8 pm to midnight Pacific, within the free Workers AI allowance. About 5 to 10 seconds an image.`}
            </p>
          )}
        </section>

        <MakeYourOwn busy={busy} themes={themes} houseStyle={houseStyle} disabled={!choices.length} onMake={(c) => make(1, c)} />

        <details className={panel} data-up-next>
          <summary className={summary}>
            <span>
              Up next <span className="font-semibold text-mute" data-queue-count>({live} of {subjects} left{queue.length - live ? `, ${queue.length - live} skipped` : ""})</span>
            </span>
            <Chevron />
          </summary>
          <div className="border-t border-edge px-4 pb-4 pt-3">
            <UpNext queue={queue} busy={busy} onChanged={() => router.refresh()} post={post} />
          </div>
        </details>

        {howMade}
      </aside>

      {/* Always mounted, like every Modal: opening one that mounts already open would close it again under React's effect replay. */}
      <Modal open={open != null} onClose={closeImage} size="xl" title={open?.themeLabel ?? "Image"} className="sm:p-7">
        {open && (
          <Detail
            key={open.id}
            img={open}
            position={at >= 0 ? { at: at + 1, of: list.length } : null}
            onStep={step}
            canStep={{ prev: at > 0, next: at >= 0 && at < list.length - 1 }}
            onAct={act}
            onTag={(t) => {
              setTag(t);
              closeImage();
            }}
            post={post}
            onSaved={() => router.refresh()}
          />
        )}
      </Modal>
    </div>
  );
}

/** One thumbnail: the picture opens the large view; images waiting for a decision get Approve and Drop right here. */
function Tile({ img, showStatus, onOpen, onAct }: { img: LibraryImage; showStatus: boolean; onOpen: () => void; onAct: (img: LibraryImage, a: Action) => void }) {
  const quick = img.status === "pending" || img.status === "rejected-auto" ? (ACTIONS_FOR[img.status] ?? []) : [];
  return (
    <li className="flex flex-col overflow-hidden rounded-xl border border-edge bg-card transition hover:border-edge-strong" data-image={img.id}>
      <button type="button" onClick={onOpen} className="group block text-left" aria-label={`Open: ${img.alt}`}>
        <span className="block aspect-video overflow-hidden bg-raised">
          {/* eslint-disable-next-line @next/next/no-img-element -- the admin-only library route */}
          <img src={imageUrl(img.id)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03] motion-reduce:transition-none" />
        </span>
        <span className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1.5 text-xs">
          <span className="truncate font-semibold text-ink">{img.themeLabel}</span>
          <span className={`shrink-0 tabular-nums ${showStatus ? (STATUS_TONE[img.status] ?? "text-mute") : "text-mute"}`}>
            {showStatus ? (STATUS_LABEL[img.status] ?? img.status) : img.status === "approved" || img.status === "retired" ? `${img.uses} use${img.uses === 1 ? "" : "s"}` : img.createdAt.slice(5, 10)}
          </span>
        </span>
      </button>
      {quick.length > 0 && (
        <div className="mt-auto grid grid-cols-2 border-t border-edge">
          {quick.map((a) => {
            const Icon = ICON[a];
            return (
              <button
                key={a}
                type="button"
                onClick={() => onAct(img, a)}
                className={`inline-flex min-h-10 items-center justify-center gap-1 text-xs font-semibold hover:bg-raised ${a === "keep" ? "text-up" : "border-l border-edge text-mute hover:text-ink"}`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden /> {LABEL[a]}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

/** The large view: the image, its decision, alt text and tags (editable), and every draft tied to it. */
function Detail({
  img,
  position,
  onStep,
  canStep,
  onAct,
  onTag,
  post,
  onSaved,
}: {
  img: LibraryImage;
  position: { at: number; of: number } | null;
  onStep: (by: number) => void;
  canStep: { prev: boolean; next: boolean };
  onAct: (img: LibraryImage, a: Action) => void;
  onTag: (t: string) => void;
  post: Post;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [alt, setAlt] = useState(img.alt);
  const [tagText, setTagText] = useState(img.tags.join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Moving to another image replaces this view; keep the focus in it so the keys keep working.
  useEffect(() => {
    if (box.current?.closest("dialog")?.open) box.current.focus({ preventScroll: true });
  }, []);
  const altCheck = cleanAlt(alt);
  const tagCheck = cleanTags(tagText);
  const actions = ACTIONS_FOR[img.status] ?? [];
  const save = async () => {
    if (!altCheck.ok || !tagCheck.ok) return;
    setSaving(true);
    const r = await post("/api/admin/library", { id: img.id, action: "edit", alt: altCheck.alt, tags: tagCheck.tags });
    setSaving(false);
    if (!r.ok) return setError(`Could not save, try again (${String(r.data?.error ?? "error")}). Your text is kept.`);
    setError("");
    setEditing(false);
    onSaved();
  };
  const posts = img.posts.filter((p, i, all) => all.findIndex((q) => q.postId === p.postId && q.kind === p.kind) === i);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft" && canStep.prev) onStep(-1);
    else if (e.key === "ArrowRight" && canStep.next) onStep(1);
    else {
      const a = actions.find((x) => KEY[x] === e.key.toLowerCase());
      if (a) onAct(img, a);
      else return;
    }
    e.preventDefault();
  };

  return (
    <div ref={box} tabIndex={-1} onKeyDown={onKeyDown} className="mt-4 grid gap-5 outline-none lg:grid-cols-[minmax(0,1fr)_20rem]" data-image-detail={img.id}>
      <div className="min-w-0">
        <div className="overflow-hidden rounded-xl border border-edge bg-raised">
          {/* eslint-disable-next-line @next/next/no-img-element -- the admin-only library route */}
          <img src={imageUrl(img.id)} alt={img.alt} className="aspect-video w-full object-contain" />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-sm text-mute">
          <button type="button" onClick={() => onStep(-1)} disabled={!canStep.prev} className={small} aria-keyshortcuts="ArrowLeft">
            <ChevronLeft className="h-4 w-4" aria-hidden /> Previous
          </button>
          {position && (
            <span className="tabular-nums">
              {position.at} of {position.of}
            </span>
          )}
          <button type="button" onClick={() => onStep(1)} disabled={!canStep.next} className={small} aria-keyshortcuts="ArrowRight">
            Next <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="min-w-0 space-y-4 text-sm">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`font-semibold ${STATUS_TONE[img.status] ?? "text-mute"}`}>{STATUS_LABEL[img.status] ?? img.status}</span>
          <span className="text-mute">
            · {img.model ?? "unknown model"} · {img.createdAt.slice(0, 10)}
            {img.status === "approved" || img.status === "retired" ? ` · used in ${img.uses} post${img.uses === 1 ? "" : "s"}` : ""}
          </span>
        </p>
        {img.note && img.note !== "ok" && <p className="rounded-lg border border-edge bg-raised p-2 text-xs text-mute">Check: {img.note}</p>}
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {actions.map((a) => {
              const Icon = ICON[a];
              return (
                <button
                  key={a}
                  type="button"
                  onClick={() => onAct(img, a)}
                  aria-keyshortcuts={KEY[a]?.toUpperCase()}
                  className={`inline-flex min-h-10 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold ${a === "keep" ? "bg-fill text-on-fill" : "border border-edge-strong hover:border-accent"}`}
                >
                  <Icon className="h-4 w-4" aria-hidden /> {LABEL[a]}
                  {KEY[a] && <kbd className="ml-1 hidden rounded border border-current/30 px-1 text-[10px] font-semibold uppercase opacity-70 pointer-fine:inline">{KEY[a]}</kbd>}
                </button>
              );
            })}
          </div>
        )}

        {editing ? (
          <div className="space-y-2">
            <label className="block text-xs font-semibold" htmlFor={`alt-${img.id}`}>
              Alt text
            </label>
            <textarea id={`alt-${img.id}`} value={alt} onChange={(e) => setAlt(e.target.value.slice(0, ALT_MAX + 40))} rows={4} className="w-full rounded-lg border border-edge-strong bg-raised p-2 text-sm" />
            <p className={`text-xs ${altCheck.ok ? "text-mute" : "text-down"}`}>{altCheck.ok ? `${altCheck.alt.length} of ${ALT_MAX}` : altCheck.error}</p>
            <label className="block text-xs font-semibold" htmlFor={`tags-${img.id}`}>
              Tags, separated by commas
            </label>
            <input id={`tags-${img.id}`} value={tagText} onChange={(e) => setTagText(e.target.value.slice(0, 600))} className="min-h-10 w-full rounded-lg border border-edge-strong bg-raised px-2 text-sm" />
            <p className={`text-xs ${tagCheck.ok ? "text-mute" : "text-down"}`}>{tagCheck.ok ? `${tagCheck.tags.length} of ${TAGS_MAX}` : tagCheck.error}</p>
            {error && (
              <p className="text-xs text-down" role="alert">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={save} disabled={saving || !altCheck.ok || !tagCheck.ok} className="inline-flex min-h-9 items-center rounded-lg bg-fill px-3 text-sm font-semibold text-on-fill disabled:opacity-50">
                {saving ? "Saving..." : "Save alt and tags"}
              </button>
              <button type="button" onClick={() => (setEditing(false), setAlt(img.alt), setTagText(img.tags.join(", ")), setError(""))} className={small}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <p className="text-xs font-semibold text-mute">Alt text</p>
              <p className="mt-0.5" data-alt>
                {img.alt}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-mute">Tags</p>
              <ul className="mt-1 flex flex-wrap gap-1" aria-label="Tags (choose one to filter the library)">
                {imageTags(img).map((t: string) => (
                  <li key={t}>
                    <button type="button" onClick={() => onTag(t)} className={`rounded-full border px-2 py-0.5 text-xs hover:border-accent ${t === img.style ? "border-dashed border-edge-strong text-mute" : "border-edge text-mute"}`}>
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <button type="button" onClick={() => setEditing(true)} className={small}>
              Edit alt and tags
            </button>
          </div>
        )}

        {img.subject && (
          <div>
            <p className="text-xs font-semibold text-mute">Subject</p>
            <p className="mt-0.5 text-mute">{img.subject}</p>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold text-mute">Drafts</p>
          {posts.length ? (
            <ul className="mt-1 space-y-1" aria-label="Drafts that used this image" data-posts>
              {posts.map((p) => (
                <li key={`${p.kind}:${p.postId}`}>
                  <span className="text-mute">{KIND_LABEL[p.kind] ?? p.kind}</span>{" "}
                  <Link href={`/admin/blog/${p.postId}`} className="font-semibold text-ink underline-offset-2 hover:underline">
                    {p.title ?? "a removed draft"}
                  </Link>
                  {p.status && <span className="text-mute"> ({p.status})</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-0.5 text-mute">No draft has used it yet.</p>
          )}
        </div>
      </div>
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
    <details className={panel}>
      <summary className={summary}>
        Make your own
        <Chevron />
      </summary>
      <div className="space-y-3 border-t border-edge px-4 pb-4 pt-3">
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
          className="w-full rounded-lg border border-edge-strong bg-raised p-2 text-sm"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <label htmlFor="own-theme" className="font-semibold">
            Theme (optional)
          </label>
          <select id="own-theme" value={theme} onChange={(e) => setTheme(e.target.value)} className="min-h-10 max-w-full rounded-lg border border-edge-strong bg-raised px-2">
            <option value="">None</option>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <span className={`text-xs ${!cleaned.ok && subject ? "text-down" : "text-mute"}`}>{cleaned.ok ? `${cleaned.subject.length} of ${SUBJECT_MAX}` : subject ? cleaned.error : `${SUBJECT_MIN} to ${SUBJECT_MAX} characters`}</span>
        </div>
        <div>
          <p className="text-xs font-semibold text-mute">The prompt Workers AI will get (your words, then the house style)</p>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-raised p-2 text-xs text-mute" data-own-prompt>
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

/** The queued subjects: what the hourly run will make next, each editable or skippable. */
function UpNext({ queue, busy, onChanged, post }: { queue: QueueItem[]; busy: boolean; onChanged: () => void; post: Post }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
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
    <>
      <p className="text-xs text-mute">The hourly run makes these in order, one from each theme in turn. Edit the wording or skip one before it is made; every prompt ends with the house style (flat 2D vector, warm greys with one amber accent, no text, no people).</p>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      <ol className="mt-3 space-y-2">
        {rows.map((q) => (
          <li key={key(q)} className={`rounded-lg border border-edge bg-raised p-2.5 text-sm ${q.skipped ? "opacity-60" : ""}`} data-queue={key(q)}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-xs font-semibold">
                {q.themeLabel}{" "}
                <span className="font-normal text-mute">
                  #{q.index + 1}
                  {q.edited ? " · edited" : ""}
                  {q.skipped ? " · skipped" : ""}
                </span>
              </p>
              <div className="flex gap-1.5">
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
                <textarea id={`edit-${key(q)}`} value={draft} onChange={(e) => setDraft(e.target.value.slice(0, SUBJECT_MAX + 50))} rows={3} className="w-full rounded-lg border border-edge-strong bg-card p-2 text-sm" />
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
        <button type="button" onClick={() => setAll(!all)} className="mt-2 min-h-11 text-sm font-semibold text-mute hover:text-ink">
          {all ? "Show fewer" : `Show all ${queue.length}`}
        </button>
      )}
    </>
  );
}
