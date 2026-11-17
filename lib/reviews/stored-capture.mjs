// A stored capture that does not show the site is never graded (owner,
// 2026-11-13: "never grade a gate"). Since pull request #235 the capture
// checks every new screen with capturedBlocked (pipeline/capture-blocked.mjs)
// and never stores a blocked one, but captures stored before it were never
// checked: their page text can be a bot check ("Just a moment..."), a loader
// ("Loading 42%"), a splash gate ("Click to enter") or a mode picker. This
// module asks the capture's own rule about such a capture as it is stored, so
// the night (pipeline/night.mjs), the fallback grader (pipeline/judge.mjs) and
// the door (./door.mjs) set the site aside before Gemini sees it, and never
// remove it on Gemini's answer.
//
// Only captures stored before CAPTURE_CHECKED_SINCE are judged here. A later
// one passed the capture's own check when it was made, on more than is
// stored: the screen after the scroll-through, the title, the links and the
// media (capture.mjs stores the page text read before the scroll-through, a
// different snapshot), so judging its stored text again could only disagree
// with the capture and send the site round in a loop (capture, set aside,
// capture). For an older capture what is stored is all there is: the page
// text, the facts (its links: a GitHub or project link counts as linking to
// another site, its own pages and a contact path as such) and the meta (the
// splash, dialog and mode-picker passes).
import { capturedBlocked, BOT_WALL } from "../../pipeline/capture-blocked.mjs";
import { storedMs } from "../stored-time.mjs";

/**
 * When the capture began checking every screen (pull request #235 merged,
 * 2026-11-16 17:30 Pacific), as portfolios.captured_at stores times (UTC).
 */
export const CAPTURE_CHECKED_SINCE = "2026-11-17 01:30:33";
const CHECKED_SINCE_MS = storedMs(CAPTURE_CHECKED_SINCE);

/** A JSON column as an object (or the object itself), or null. */
export function parseObject(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}

/** Whether a capture stored at `capturedAt` came before the capture checked its screen (no time counts as before). */
export function capturedBeforeCheck(capturedAt) {
  const t = storedMs(capturedAt);
  return t == null || t < CHECKED_SINCE_MS;
}

/** SQL (never NULL): the portfolios row aliased `p` holds a capture from before the capture checked its screen. */
export const CAPTURED_BEFORE_CHECK_SQL = (p = "p") => `COALESCE(datetime(${p}.captured_at) < datetime('${CAPTURE_CHECKED_SINCE}'), 1)`;

/**
 * Why the stored capture of `row` (page_text, facts, meta, captured_at) does
 * not show the site, in the capture's words, or null when it does, when the
 * capture already checked it (CAPTURE_CHECKED_SINCE), or when there is no
 * page text to judge (such a row is never graded anyway).
 */
export function storedCaptureBlocked(row) {
  if (!row || row.page_text == null || !capturedBeforeCheck(row.captured_at)) return null;
  const facts = parseObject(row.facts) ?? {};
  const meta = parseObject(row.meta) ?? {};
  const pl = parseObject(facts.project_links);
  const linksOut = facts.github === true || facts.signals?.github === true || Boolean(pl && (Number(pl.checked) > 0 || Number(pl.ok) > 0));
  return capturedBlocked({
    text: String(row.page_text),
    title: "",
    outboundLinks: linksOut ? 1 : 0,
    // Read by the capture's word rule once it counts a site's own pages and contact links (pull request #250).
    siteLinks: Number(facts.internal_pages) || 0,
    contactLinks: facts.contact === true ? 1 : 0,
    splash: meta.splash ?? null,
    modal: meta.modal ?? null,
    mode: meta.mode ?? null,
  });
}

/**
 * Whether `grade` was made on a capture the capture itself checked
 * (CAPTURE_CHECKED_SINCE or later), so it showed the site. The capture a
 * grade read is its `capture_at` (the door records it), else the row's
 * capture when it is not newer than the grade; one whose capture is not
 * known counts as unchecked. An unchecked capture may have shown a gate (the
 * door grades one only when it passed storedCaptureBlocked, which judges
 * stored text, not the screen).
 */
export function gradedOnCheckedCapture(row, grade) {
  const judged = storedMs(grade?.judged_at);
  const current = storedMs(row?.captured_at);
  const read = grade?.capture_at != null ? grade.capture_at : current != null && judged != null && current <= judged ? row.captured_at : null;
  return read != null && !capturedBeforeCheck(read);
}

/** Whether a reason from storedCaptureBlocked is the bot wall's (the one kind that goes to the owner). */
export const isBotWall = (why) => why === BOT_WALL;
