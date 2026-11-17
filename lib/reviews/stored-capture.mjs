// A stored capture that does not show the site is never graded (owner,
// 2026-11-13: "never grade a gate"). Since pull request #235 the capture
// checks every new screen with capturedBlocked (pipeline/capture-blocked.mjs)
// and never stores a blocked one, but captures stored before it were never
// checked: their page text can be a bot check ("Just a moment..."), a loader
// ("Loading 42%"), a splash gate ("Click to enter") or a mode picker. This
// module asks the capture's own rule about the capture as it is stored, so
// the night (pipeline/night.mjs) and the door (./door.mjs) can set such a site
// aside before Gemini sees it, and never remove it on Gemini's answer.
//
// What is stored is less than what the capture saw: the page text (normalized
// and capped), the facts and the meta (the splash, dialog and mode-picker
// passes); not the title, and not the number of other sites the page links
// to. The link count only matters for the last rule ("under 40 words and no
// outbound links"):
//   - a capture made since CAPTURE_CHECKED_SINCE already passed that rule with
//     the real count, so a short page there did link out;
//   - an older capture counts as linking out when its facts found a link to
//     GitHub or to a project, and as not linking out otherwise.
import { capturedBlocked, BOT_WALL } from "../../pipeline/capture-blocked.mjs";

/**
 * When the capture began checking every screen (pull request #235 merged,
 * 2026-11-16 17:30 Pacific, in UTC as portfolios.captured_at stores it).
 */
export const CAPTURE_CHECKED_SINCE = "2026-11-17T01:30:33Z";

const parse = (v) => {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
};

/** A stored time ("YYYY-MM-DD HH:MM:SS" in UTC, or ISO) in milliseconds, or null. */
export function storedTime(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Whether the stored facts show a link to another site (GitHub, or a project that was checked). */
function linksOut(facts) {
  if (!facts) return false;
  if (facts.github === true || facts.signals?.github === true) return true;
  const pl = facts.project_links;
  return Boolean(pl && typeof pl === "object" && (Number(pl.checked) > 0 || Number(pl.ok) > 0));
}

/**
 * Why the stored capture of `row` (page_text, facts, meta, captured_at) does
 * not show the site, in the capture's words, or null when it does (or when
 * there is no page text to judge: such a row is never graded anyway).
 */
export function storedCaptureBlocked(row) {
  if (!row || row.page_text == null) return null;
  const facts = parse(row.facts);
  const meta = parse(row.meta) ?? {};
  const at = storedTime(row.captured_at);
  const checked = at != null && at >= Date.parse(CAPTURE_CHECKED_SINCE);
  return capturedBlocked({
    text: String(row.page_text),
    title: "",
    outboundLinks: checked || linksOut(facts) ? 1 : 0,
    splash: meta.splash ?? null,
    modal: meta.modal ?? null,
    mode: meta.mode ?? null,
  });
}

/** Whether a reason from storedCaptureBlocked is the bot wall's (the one kind that goes to the owner). */
export const isBotWall = (why) => why === BOT_WALL;
