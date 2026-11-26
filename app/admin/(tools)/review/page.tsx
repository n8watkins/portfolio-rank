import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { StatusReviewQueue, type Review } from "@/components/admin/StatusReviewQueue";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { listReviews } from "@/lib/reviews/store.mjs";
import { phoneMissingKeys } from "@/lib/shots";
import { reviewAutoApplyEnabled } from "@/lib/reviews/flag";
import { ProblemReports, type ReportedSite } from "@/components/admin/ProblemReports";
import { listReports } from "@/lib/problem-reports/store.mjs";

// /admin/review: status changes a re-check proposes (lib/reviews/store.mjs),
// one row per site whose listed or ranked state would change, with its fresh
// desktop and phone screenshots, each grader's verdict, the code's signals,
// its group and the reason. Rows where the graders agree come pre-ticked;
// disagreements are flagged and left unticked. Nothing changes until the
// owner confirms: Confirm applies the change through the pipeline's own paths
// and records who and when; Reject records the decision only. With
// REVIEW_AUTO_APPLY (lib/reviews/flag.ts), rows that pass the owner's rule
// are applied by the hourly cron and listed under "Applied automatically",
// each with Undo. Above the queue, visitors' "Report a problem" notes,
// grouped by site (components/admin/ProblemReports.tsx). Only the admin sees
// it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Review - PortfolioRank admin", robots: { index: false, follow: false } };

export default async function AdminReviewPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const lists = (await listReviews(db())) as { pending: Review[]; autoApplied: Review[]; decided: Review[] };
  // Captures with no phone view: the queue says so instead of showing a phone frame (lib/shot-url.ts withoutPhone).
  const noPhone = await phoneMissingKeys([...lists.pending, ...lists.autoApplied, ...lists.decided].map((r) => r.shotKey ?? "")).catch(() => new Set<string>());
  const mark = (rows: Review[]) => rows.map((r) => (r.shotKey && noPhone.has(r.shotKey) ? { ...r, phoneMissing: true } : r));
  const [pending, autoApplied, decided] = [mark(lists.pending), mark(lists.autoApplied), mark(lists.decided)];
  // Visitors' "Report a problem" notes, grouped by site (lib/problem-reports/store.mjs).
  const reports = (await listReports(db())) as { open: ReportedSite[]; handled: ReportedSite[] };
  const auto = reviewAutoApplyEnabled(process.env);
  const agreed = pending.filter((r) => r.agreed).length;
  return (
    <>
      <AdminHeader title="Review">
        Status changes a re-check or the nightly grade proposes.{" "}
        {auto
          ? "Rows that pass a rule (both models say portfolio; or Gemini says a new site is not a portfolio and the code does not dispute it) are applied automatically, each with Undo; the rest wait for you. "
          : "Nothing changes until you confirm a row. "}
        {pending.length > 0 && (
          <span data-review-summary>
            {pending.length.toLocaleString("en-US")} waiting: {agreed.toLocaleString("en-US")} where the graders agree, {(pending.length - agreed).toLocaleString("en-US")}{" "}
            {pending.length - agreed === 1 ? "disagreement" : "disagreements"}.
          </span>
        )}
      </AdminHeader>
      <ProblemReports open={reports.open} handled={reports.handled} />
      <StatusReviewQueue pending={pending} autoApplied={autoApplied} decided={decided} shotsBase={process.env.SHOTS_BASE_URL ?? null} />
    </>
  );
}
