// The review queue's words for what a decision does and when it shows, shared
// by the row (./StatusReviewQueue.tsx), the bulk confirm bar, the notices, the
// Decided list and the screenshot viewer (./ShotViewer.tsx), so they cannot
// drift. Both buttons say what happens to the site (owner, 2026-11-23:
// "reject is unclear as the opposite. It should be like, take off the list,
// keep on the list"), never "Reject" or "apply" (owner, 2026-11-14: "what does
// apply even mean?"). The API actions stay "confirm" and "reject"; only the
// words live here.
// The real timing of the agree button (lib/reviews/store.mjs planConfirm):
//   remove                      off the list at once (health down)
//   relist, graded, listed      back in the rankings at once (grade flipped, re-ranked)
//   relist, delisted            back on the list after the next daily sync (data/additions.json)
//   relist, broken or hidden    shows again after its next capture
//   relist, never graded        ranked after its first nightly grade
// The other button (decideReviews "reject") changes nothing on the site and
// moves the row to Decided; on a removal it also counts as the owner's keep, so
// no rule removes the site again (keepsSite), and a held grade is settled as
// his choice (settleOnReject).
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

/**
 * The other button (the "reject" action): its label, its question, what it
 * does (for the hint) and what it is called once done (the Decided list, the
 * notices).
 */
export function declineOf(r: Row): { label: string; question: string; does: string; done: string } {
  if (r.proposed === "remove") {
    const listed = r.current === "ranked" || r.current === "listed";
    return {
      label: "Keep on the list",
      question: "Confirm: keep this site on the list?",
      does: listed ? "stays listed, and no rule removes it again." : "stays as it is, and no rule removes it.",
      done: "Kept on the list",
    };
  }
  if (r.proposed === "relist") {
    const does = r.current === "delisted" || r.group.startsWith("delisted") ? "stays off the list." : r.current === "hidden" || r.group === "broken" ? "stays hidden." : "stays as it is.";
    return { label: "Leave it off", question: "Confirm: leave this site off?", does, done: "Left off" };
  }
  return { label: "Dismiss", question: "Confirm: dismiss?", does: "not worth a look.", done: "Dismissed" };
}

/**
 * The one line beside a row's two buttons, saying what each does:
 * "Take off the list: off the list at once. Keep on the list: stays listed, and no rule removes it again."
 */
export function hintOf(r: Row): string {
  const o = outcomeOf(r);
  const d = declineOf(r);
  if (r.proposed === "review") return `${o.label}: you looked. ${d.label}: ${d.does} Neither changes the site.`;
  return `${o.label}: ${o.when.charAt(0).toLowerCase()}${o.when.slice(1)} ${d.label}: ${d.does}`;
}

/** The Decided list's word for a decided row. */
export function decidedLabel(r: Row & { status: string }): string {
  if (r.status === "closed") return "Closed";
  if (r.status === "rejected") return declineOf(r).done;
  return r.proposed === "review" ? "Checked" : "Confirmed";
}

/** What the other button did, for the Decided list; `settled` when it settled a held grade as the owner's keep. */
export function declinedEffect(r: Row, settled: boolean): string {
  if (r.proposed === "remove" && settled) return "Stays listed; the grade records your decision.";
  return "Nothing changed on the site.";
}

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
