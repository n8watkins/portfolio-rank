// How often an open report page asks for its job (components/grade/useGradeJob.ts).
// A few seconds while something is happening on the page's behalf (the
// capture runs, the AI looks at it), minutes while the job only waits (for
// tomorrow's share, for the queue, for the visitor's key), longer the longer
// it has waited, and not at all in a hidden tab. One idle tab used to ask every
// 4 seconds, about 21,600 times a day.

const ACTIVE_FAST = new Set(["capturing", "grading"]);

/**
 * Milliseconds until the next ask, or null when none is wanted (the job is
 * over, or the tab is hidden: it asks again when shown).
 *
 * @param {string} status
 * @param {{ hidden?: boolean, age?: number }} [options] `age`: how long this page has watched the job, in ms.
 * @returns {number | null}
 */
export function pollDelay(status, { hidden = false, age = 0 } = {}) {
  if (hidden) return null;
  if (ACTIVE_FAST.has(status)) return 3000;
  if (status === "queued" || status === "waiting" || status === "awaiting_key") {
    // 1 minute at first, 5 minutes after an hour of watching.
    return age < 3600000 ? 60000 : 300000;
  }
  return null;
}
