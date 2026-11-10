// Did a judge.mjs run do its job? Kept apart from judge.mjs so tests can
// check the rules without a database or Gemini.
//
// Counts per run:
//   queued     rows (rubric) or pairs (pairwise) the run tried to work on
//   ok         rubrics stored / votes cast
//   abstained  pairwise calls that answered "skip" (a call made, no vote)
//   errors     Gemini calls that failed
//   skipped    rows or pairs that could not be judged at all (screenshots
//              unavailable): no call was made, so they are not "attempted",
//              but a run that skips most of its work is not healthy either
//
// The run fails (exit 1) when there was work and nothing was done, or when
// most of the work was skipped. Running out of daily quota after some
// successes still passes: the rest waits for the next run.

export function judgeOutcome({ mode, queued = 0, ok = 0, abstained = 0, errors = 0, skipped = 0 }) {
  const done = ok + abstained;
  let failure = null;
  if (queued > 0 && done === 0) {
    failure = errors
      ? `every Gemini call failed (${errors} error(s), ${skipped} skipped)`
      : `nothing was judged: all ${skipped} skipped`;
  } else if (queued > 0 && skipped > queued / 2) {
    failure = `most of the work was skipped (${skipped} of ${queued}): screenshots unavailable`;
  }
  const what = mode === "pairwise" ? "pair(s)" : "site(s)";
  const verdict = queued === 0
    ? "Nothing to do."
    : failure
      ? `FAILED: ${failure}.`
      : `OK: ${done} of ${queued} ${what} judged.`;
  const summary = [
    `## AI judge: ${mode}`,
    "",
    verdict,
    "",
    "| Queued | Judged | Abstained | Errors | Skipped |",
    "| ---: | ---: | ---: | ---: | ---: |",
    `| ${queued} | ${ok} | ${abstained} | ${errors} | ${skipped} |`,
    "",
  ].join("\n");
  return { exitCode: failure ? 1 : 0, verdict, summary };
}
