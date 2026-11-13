// What GET /api/grade/<id> shows: progress while the grade runs, then the
// report. Never the visitor's identity, network, email address or key;
// never the page text (it can hold personal details and is only grading
// input).
import { factLines } from "./report.mjs";
import { progressSteps } from "./jobs.mjs";
import { REGRADE_COOLDOWN_DAYS } from "../../pipeline/budget.mjs";
import { isTier } from "../tiers.mjs";

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return String(url);
  }
};

/** The free checks as fact lines (the same shape the report uses). */
function quickView(quick) {
  if (!quick) return null;
  if (!quick.ok) return { ok: false, error: quick.error ?? "unreachable", message: quick.message ?? "", measuredAt: quick.measuredAt ?? null };
  return {
    ok: true,
    title: quick.title ?? "",
    finalUrl: quick.finalUrl ?? null,
    facts: factLines({ checks: quick.checks ?? {}, facts: quick.facts ?? {} }),
    note: quick.message ?? null,
    measuredAt: quick.measuredAt ?? null,
  };
}

/**
 * The public view of a job. `mine` is true for the browser that owns the
 * report (it may delete it); `emails` is lib/grader/notify.mjs emailState.
 *
 * @param {any} job
 * @param {{ mine?: boolean, emails?: { requested: boolean, sent: boolean } | null }} [options]
 */
export function publicJob(job, { mine = false, emails = null } = {}) {
  const done = job.status === "done" && job.result;
  const g = job.result ?? {};
  const shots = job.shot_key && job.captured_at ? { hero: `/api/grade/${job.id}/shot/hero.jpg`, mobile: `/api/grade/${job.id}/shot/mobile.jpg` } : null;
  return {
    id: job.id,
    url: job.url,
    domain: domainOf(job.url),
    status: job.status,
    reason: job.reason ?? null,
    ownKey: job.own_key,
    mine,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    steps: progressSteps(job),
    checks: quickView(job.quick),
    shots,
    email: emails ? { requested: emails.requested, sent: emails.sent } : { requested: false, sent: false },
    report: done
      ? {
          // The tier by ELO from face-offs (lib/tiers.mjs), never Gemini's own letter; null for "not a portfolio".
          tier: isTier(job.report?.rank?.tier) ? job.report.rank.tier : null,
          // Too few face-offs yet: the tier is the starting B (older reports have no flag: false).
          provisional: job.report?.rank?.provisional === true,
          faceoffs: typeof job.report?.rank?.faceoffs === "number" ? Math.floor(job.report.rank.faceoffs) : null,
          isPortfolio: g.is_portfolio,
          qualityScore: g.quality_score ?? null,
          checksScore: g.checks_score ?? null,
          roles: g.roles ?? [],
          // Facts (code) and judgments (Gemini) apart, as the grade card shows them.
          facts: job.report?.facts ?? factLines(g),
          judgments: job.report?.judgments ?? [],
          strengths: job.report?.strengths ?? [],
          fixes: job.report?.fixes ?? [],
          percentile: job.report?.percentile ?? null,
          similar: job.report?.similar ?? [],
          better: job.report?.better ?? [],
          model: g.model ?? null,
          rubricVersion: g.rubric_version ?? null,
          ownKey: Boolean(g.own_key),
          gradedAt: g.judged_at ?? job.done_at,
          regradeAfter: job.done_at ? new Date(Date.parse(job.done_at) + REGRADE_COOLDOWN_DAYS * 86400000).toISOString() : null,
        }
      : null,
  };
}
