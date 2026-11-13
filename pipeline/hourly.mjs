// The hourly cron's tasks (worker/index.ts) run one after another, each on
// its own: one that throws (a Turso blip, Gemini answering 500) is reported
// and logged, and the tasks after it still run that hour.

/**
 * Runs `tasks` in order and never throws. Returns the names of the ones that failed.
 * @param {[string, () => unknown | Promise<unknown>][]} tasks
 * @param {{ report?: (error: unknown, name: string) => void, log?: (line: Record<string, unknown>) => void }} [options]
 * @returns {Promise<{ failed: string[] }>}
 */
export async function runEach(tasks, { report = () => {}, log = () => {} } = {}) {
  const failed = [];
  for (const [name, task] of tasks) {
    try {
      await task();
    } catch (e) {
      failed.push(name);
      log({ event: "hourly.task_failed", task: name, error: String(/** @type {Error} */ (e)?.message ?? e).slice(0, 200) });
      try {
        report(e, name);
      } catch {
        // Reporting is best effort; the next task runs either way.
      }
    }
  }
  return { failed };
}
