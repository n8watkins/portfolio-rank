// Reading a stored post's outside-claim flags (admin page, preview, scorecard); no imports, so any of them may load it.

/** The flags of a stored post's history as one list, old records (supported, cut) included. */
export function flagsOf(history) {
  return (history ?? []).flatMap((h) => {
    const c = h?.claims ?? {};
    if (Array.isArray(c.flagged)) return c.flagged;
    return [...(c.supported ?? []).map((x) => ({ sentence: x.sentence, outcome: "supported", url: x.url })), ...(c.cut ?? []).map((x) => ({ sentence: x.sentence, outcome: "cut", reason: x.reason }))];
  });
}

/** The one label the admin page and the preview show for a flag, in plain words, for every outcome. */
export function labelOf(flag) {
  if (flag.outcome === "supported") return "Kept, with a source";
  if (flag.outcome === "cut") return "Cut";
  if (flag.outcome === "not found in the post") return "Not found in the post, so the draft was dropped";
  return "Flagged";
}

/** { kept, cut } counts of a post's flags, for a heading. */
export function flagCounts(flags) {
  return { kept: flags.filter((f) => f.outcome === "supported").length, cut: flags.filter((f) => f.outcome === "cut").length };
}
