import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { GUIDELINES_MAX, GUIDELINES_TOTAL, GUIDELINE_MAX, listGuidelines, noteSuggestions } from "@/lib/content/guidelines.mjs";
import { GuidelinesEditor } from "@/components/admin/GuidelinesEditor";

// The editor's guidelines (docs/CONTENT-ENGINE.md, "Quality tools"): the
// owner's short list of rules the writer follows on every draft, built from
// the owner's notes on drafts. Only the admin sees it; anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Editor's guidelines - PortfolioRank admin", robots: { index: false, follow: false } };

export default async function GuidelinesPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const client = db();
  const [guidelines, suggestions] = await Promise.all([listGuidelines(client), noteSuggestions(client)]);
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
      <div className="py-6">
        <Link href="/admin/blog" className="inline-flex min-h-9 items-center gap-1.5 text-sm font-semibold text-mute hover:text-ink">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Blog drafts
        </Link>
        <p className="mt-2 text-xs font-semibold uppercase tracking-[0.14em] text-accent">Admin</p>
        <h1 className="mt-1.5 text-3xl font-bold tracking-tight">Editor&apos;s guidelines</h1>
        <p className="mt-2 text-sm text-mute">
          The writer follows every rule here on every draft, the nightly ones and Write a draft now. Keep each one short and specific: at most {GUIDELINES_MAX} rules, {GUIDELINE_MAX} characters each and {GUIDELINES_TOTAL.toLocaleString("en-US")} in all.
        </p>
      </div>
      <GuidelinesEditor initial={guidelines} suggestions={suggestions} max={GUIDELINE_MAX} />
    </div>
  );
}
