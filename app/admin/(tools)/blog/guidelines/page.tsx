import { notFound } from "next/navigation";
import { AdminHeader } from "@/components/admin/AdminHeader";
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
    <>
      <AdminHeader title="Editor's guidelines" back={{ href: "/admin/blog", label: "Blog drafts" }}>
        The writer follows every rule here on every draft, the nightly ones and Write a draft now. Keep each one short and specific: at most {GUIDELINES_MAX} rules, {GUIDELINE_MAX} characters each and {GUIDELINES_TOTAL.toLocaleString("en-US")} in all.
      </AdminHeader>
      <GuidelinesEditor initial={guidelines} suggestions={suggestions} max={GUIDELINE_MAX} />
    </>
  );
}
