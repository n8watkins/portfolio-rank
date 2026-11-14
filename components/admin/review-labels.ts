// The review queue's words for what a decision does and when it shows, shared
// by the row (./StatusReviewQueue.tsx), the bulk confirm bar and the
// screenshot viewer (./ShotViewer.tsx). Plain verbs instead of "apply" (owner,
// 2026-11-14: "what does apply even mean?"), and the real timing of each case
// (lib/reviews/store.mjs planConfirm):
//   remove                      off the list at once (health down)
//   relist, graded, listed      back in the rankings at once (grade flipped, re-ranked)
//   relist, delisted            back on the list after the next daily sync (data/additions.json)
//   relist, broken or hidden    shows again after its next capture
//   relist, never graded        ranked after its first nightly grade
// Buttons ask first (./ConfirmButton.tsx): the question says the same verb.

type Row = { proposed: "relist" | "remove" | "review"; group: string; current: string };

/** The verb, the button label, the question and when it shows on the site. */
export function outcomeOf(r: Row): { key: string; verb: string; label: string; question: string; when: string } {
  if (r.proposed === "review") return { key: "check", verb: "mark checked", label: "Mark checked", question: "Confirm: mark checked?", when: "Nothing changes on the site." };
  if (r.proposed === "remove") return { key: "remove", verb: "take off", label: "Take off the list", question: "Confirm: take this site off?", when: "Off the list at once." };
  const ungraded = r.group === "delisted_ungraded" || r.group === "broken" || r.group === "live_ungraded";
  const graded = ungraded ? " It is ranked after its first nightly grade." : "";
  let when: string;
  let key: string;
  if (r.current === "delisted" || r.group.startsWith("delisted")) {
    key = ungraded ? "sync-grade" : "sync";
    when = `Back on the list after the next daily sync.${graded}`;
  } else if (r.current === "hidden" || r.group === "broken") {
    key = "capture";
    when = `Shows again after its next capture.${graded}`;
  } else if (ungraded) {
    key = "grade";
    when = "Ranked after its first nightly grade.";
  } else {
    key = "now";
    when = "Back in the rankings at once.";
  }
  return { key, verb: "bring back", label: "Bring back", question: "Confirm: bring this site back?", when };
}

/** The hint beside a row's buttons: "If confirmed, back on the list after the next daily sync." */
export const ifConfirmed = (when: string) => `If confirmed, ${when.charAt(0).toLowerCase()}${when.slice(1)}`;

export const REJECT_QUESTION = "Confirm: reject?";
export const UNDO_QUESTION = "Confirm: undo?";

/**
 * The bulk confirm bar's words for the ticked rows: the button
 * ("Confirm 279: bring these sites back") and one line per timing
 * ("200 back on the list after the next daily sync").
 */
export function bulkWords(rows: Row[]): { button: string; timing: { when: string; count: number }[] } {
  const n = rows.length;
  const by = (verb: string) => rows.filter((r) => outcomeOf(r).verb === verb).length;
  const back = by("bring back");
  const off = by("take off");
  const checked = by("mark checked");
  const parts = [back && `bring back ${back}`, off && `take off ${off}`, checked && `mark ${checked} checked`].filter(Boolean) as string[];
  const one = n === 1 ? "this site" : "these sites";
  const button =
    parts.length === 1 && back
      ? `Confirm ${n}: bring ${one} back`
      : parts.length === 1 && off
        ? `Confirm ${n}: take ${one} off`
        : `Confirm ${n}: ${parts.join(", ")}`;
  const timing = new Map<string, number>();
  for (const r of rows) {
    const when = outcomeOf(r).when;
    timing.set(when, (timing.get(when) ?? 0) + 1);
  }
  return { button, timing: [...timing].map(([when, count]) => ({ when, count })) };
}
