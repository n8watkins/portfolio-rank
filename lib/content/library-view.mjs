// The pure parts of the /admin/images page (components/admin/LibraryReview.tsx):
// which images each tab shows and the counts on the tabs, search and tag
// filters, the choices for "Make N now", the messages that say what a batch
// did or why it did not, and the progress line while images are made. Plain
// JavaScript with no browser or server imports, so the page and the tests
// share it.

/** The tabs, in order: id, label and the image statuses each one shows. "all" shows every status. */
export const VIEWS = [
  { id: "review", label: "To review", statuses: ["pending"] },
  { id: "approved", label: "Approved", statuses: ["approved"] },
  { id: "dropped", label: "Dropped", statuses: ["rejected"] },
  { id: "failed", label: "Failed check", statuses: ["rejected-auto"] },
  { id: "all", label: "All", statuses: null },
];

/** The images a tab shows (every image for "all"; an unknown id falls back to "To review"). */
export function filterImages(images, viewId) {
  const view = VIEWS.find((v) => v.id === viewId) ?? VIEWS[0];
  return view.statuses ? images.filter((i) => view.statuses.includes(i.status)) : images;
}

/** { review, approved, dropped, failed, all }: how many images each tab holds. */
export function viewCounts(images) {
  return Object.fromEntries(VIEWS.map((v) => [v.id, filterImages(images, v.id).length]));
}

/** The image list with the owner's just-made decisions laid over it ({ id: status }). */
export function withStatuses(images, overlay) {
  return images.map((i) => (overlay[i.id] && overlay[i.id] !== i.status ? { ...i, status: overlay[i.id] } : i));
}

/** An image's tags as shown and filtered: its own tags, then its style. */
export const imageTags = (img) => [...(img.tags ?? []), ...(img.style ? [img.style] : [])];

/**
 * Images matching a search and a tag: `query` matches words of the alt text,
 * subject, theme and tags (every word must match somewhere); `tag` must be
 * one of the image's tags exactly. Both are optional.
 * @template {{ alt?: string, subject?: string | null, theme?: string, themeLabel?: string, tags?: string[], style?: string }} T
 * @param {T[]} images
 * @param {{ query?: string, tag?: string }} [opts]
 * @returns {T[]}
 */
export function searchImages(images, { query = "", tag = "" } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return images.filter((img) => {
    const tags = imageTags(img);
    if (tag && !tags.includes(tag)) return false;
    if (!words.length) return true;
    const hay = [img.alt, img.subject, img.theme, img.themeLabel, ...tags].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The tags across `images`, most used first (then by name), with their counts: [{ tag, n }]. */
export function tagCounts(images) {
  const m = new Map();
  for (const img of images) for (const t of new Set(imageTags(img))) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
}

/** The largest fixed choice for "Make N now"; "Make up to N" takes the rest of the day. */
export const PER_CLICK = 10;

/** The choices for "Make N now": 1, 2, 5 and 10 that fit, and exactly what is left when that is between them. Empty when nothing is left. */
export function makeChoices(remaining) {
  const left = Math.min(PER_CLICK, Math.max(0, Math.floor(Number(remaining) || 0)));
  const picks = [1, 2, 5, 10].filter((n) => n <= left);
  if (left > 0 && !picks.includes(left)) picks.push(left);
  return picks.sort((a, b) => a - b);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Local clock time such as "3:45 PM" (the browser's own time zone and locale). */
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * Why nothing more can be made, in the owner's words. `r` is { reason,
 * nextAt?, stopped?, usage?, gatewayLimit? }; `fmt` turns an ISO time into
 * the owner's local time. Empty when there is no reason.
 */
export function reasonText(r, fmt = clock) {
  const day = r.usage?.maxImages ?? 40;
  const why = {
    hour: () => `This hour's limit is used: next batch at ${r.nextAt ? fmt(r.nextAt) : "the top of the hour"}`,
    day: () => `Today's ${day} are used`,
    neurons: () => `Today's neuron allowance is used (${(r.usage?.neurons ?? 0).toLocaleString("en-US")} of ${(r.usage?.ceiling ?? 2500).toLocaleString("en-US")})`,
    quiet: () => "Paused 8 pm to midnight Pacific",
    gateway: () => `The AI Gateway allows ${r.gatewayLimit ?? "fewer than " + (r.usage?.maxImages ?? 40)} an hour: raise it in AI Gateway settings`,
    no_gemini_budget: () => "The Gemini check has no room today (the library's share of the daily quota is used)",
    queue_empty: () => "Every queued subject already has an image or is skipped",
    deadline: () => "The image day resets at 00:00 UTC: the rest waits for tomorrow",
    bad_subject: () => r.stopped || "That subject could not be used",
    off: () => `Image making is off: ${r.stopped || "a setting turns it off"}`,
    error: () => `Stopped: ${r.stopped || "an error"}`,
  };
  if (!r.reason) return "";
  return (why[r.reason] ?? (() => `Stopped: ${r.stopped || r.reason}`))();
}

/**
 * One sentence for the outcome of "Make now": what was made, then why it
 * stopped, if it did. `r` is { requested, made: [{ status }], reason?,
 * nextAt?, stopped?, usage?, gatewayLimit? } (the generate route's answers,
 * added up over the calls).
 */
export function describeMake(r, fmt = clock) {
  const made = r.made ?? [];
  const failed = made.filter((m) => m.status === "rejected-auto").length;
  const pending = made.length - failed;
  const reason = reasonText(r, fmt);
  if (!made.length) return reason || "Nothing was made";
  const where = failed ? ` (${pending} to review, ${failed} failed the check)` : " (in To review)";
  const head = `Made ${made.length}${r.requested && r.requested > made.length ? ` of ${r.requested}` : ""}${where}`;
  return reason ? `${head}. ${reason}` : head;
}

/**
 * The line while a batch runs: "Making 1 of 2... about 5 seconds each".
 * @param {number} index @param {number} total @param {number | null} [avgMs]
 */
export function progressText(index, total, avgMs = null) {
  const each = Math.max(1, Math.round((avgMs ?? 5000) / 1000));
  return `Making ${index} of ${total}... about ${plural(each, "second")} each`;
}

/**
 * The daily automatic run in the owner's words: "Automatic images: once a day
 * at 3:15 pm Pacific, using what's left of the 40." (the run's UTC hour shown
 * in Pacific time for the day `now` falls in, so it follows daylight saving),
 * or that it is off.
 * @param {number | null} hourUtc @param {Date | number} [now]
 */
export function automaticText(hourUtc, now = new Date()) {
  if (hourUtc == null) return "Automatic images: off.";
  const d = new Date(now);
  const at = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 15));
  const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).replace("AM", "am").replace("PM", "pm");
  return `Automatic images: once a day at ${time} Pacific, using what's left of the 40.`;
}

/** The day's counter near the button: "Today 12 of 40 · 28 left". */
export function countsText(usage) {
  if (!usage) return "";
  return `Today ${usage.images} of ${usage.maxImages} · ${Math.max(0, usage.maxImages - usage.images)} left`;
}

/**
 * What the page says before anything is made: the reason the library can't
 * make anything now (the same words as after a batch), else null.
 * `room` is aiHeadroom's answer plus { quiet, off } from the page.
 */
export function idleReason(room, usage, fmt = clock) {
  if (room.off) return reasonText({ reason: "off", stopped: room.off }, fmt);
  if (room.quiet) return reasonText({ reason: "quiet" }, fmt);
  if (room.remaining < 1 && room.blocker) return reasonText({ reason: room.blocker, nextAt: room.nextAt, usage }, fmt);
  return null;
}
