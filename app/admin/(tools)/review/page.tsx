import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { StatusReviewQueue, type Review } from "@/components/admin/StatusReviewQueue";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { listReviews } from "@/lib/reviews/store.mjs";

// /admin/review: status changes a re-check proposes (lib/reviews/store.mjs),
// one row per site whose listed or ranked state would change, with its fresh
// desktop and phone screenshots, each grader's verdict, the code's signals,
// its group and the reason. Rows where the graders agree come pre-ticked;
// disagreements are flagged and left unticked. Nothing changes until the
// owner confirms: Confirm applies the change through the pipeline's own paths
// and records who and when; Reject records the decision only. Only the admin
// sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Review - PortfolioRank admin", robots: { index: false, follow: false } };

export default async function AdminReviewPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const { pending, decided } = (await listReviews(db())) as { pending: Review[]; decided: Review[] };
  const agreed = pending.filter((r) => r.agreed).length;
  return (
    <>
      <AdminHeader title="Review">
        Status changes a re-check proposes. Nothing changes until you confirm a row.{" "}
        {pending.length > 0 && (
          <span data-review-summary>
            {pending.length.toLocaleString("en-US")} waiting: {agreed.toLocaleString("en-US")} where the graders agree, {(pending.length - agreed).toLocaleString("en-US")}{" "}
            {pending.length - agreed === 1 ? "disagreement" : "disagreements"}.
          </span>
        )}
      </AdminHeader>
      <StatusReviewQueue pending={pending} decided={decided} shotsBase={process.env.SHOTS_BASE_URL ?? null} />
    </>
  );
}
