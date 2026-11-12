import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { librarySummary, listImages } from "@/lib/content/library.mjs";
import { aiLimits, aiUsage } from "@/lib/content/neurons.mjs";
import { LibraryReview, type LibraryImage } from "@/components/admin/LibraryReview";

// The image library's review page (docs/CONTENT-ENGINE.md, "The image
// library"): pending images with keep and drop, images the Gemini check
// rejected (the owner can still keep one), and the library with usage counts
// and a retire button. Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Image library - PortfolioRank admin", robots: { index: false, follow: false } };

export default async function AdminImagesPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const client = db();
  const [summary, images, ai] = await Promise.all([
    librarySummary(client),
    listImages(client, { limit: 1000 }),
    aiUsage(client, { limits: aiLimits(process.env), now: new Date() }),
  ]);
  const rows: LibraryImage[] = images.map((i) => ({
    id: i.id,
    theme: i.theme,
    subject: i.subject,
    alt: i.alt,
    model: i.model,
    status: i.status,
    note: i.check?.note ?? i.check?.error ?? null,
    uses: i.uses ?? 0,
    createdAt: i.createdAt,
  }));
  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
      <div className="py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Image library</h1>
          <Link href="/admin/blog" className="inline-flex min-h-11 items-center text-sm font-semibold text-mute hover:text-ink">
            Blog review
          </Link>
        </div>
        <p className="mt-2 text-sm text-mute">
          {summary.counts.approved} approved, {summary.counts.pending} waiting for you, {summary.counts["rejected-auto"]} failed the check, {summary.queued} of {summary.subjects} subjects still queued.
        </p>
        <p className="mt-1 text-sm font-semibold" data-ai-images>
          AI images today: {ai.images} of {ai.maxImages}
          <span className="font-normal text-mute">
            {" "}
            ({ai.neurons.toLocaleString("en-US")} of {ai.ceiling.toLocaleString("en-US")} neurons, UTC {ai.day})
          </span>
        </p>
        {ai.problem && <p className="mt-1 text-sm text-down">{ai.problem}</p>}
      </div>
      <LibraryReview images={rows} />
    </div>
  );
}
