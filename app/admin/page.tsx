import { notFound, redirect } from "next/navigation";
import { requireAdmin } from "@/lib/admin";

// /admin: the admin lands on the usage page; anyone else gets the same 404 as
// every other admin page, so the address says nothing.
export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function AdminIndex() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  redirect("/admin/usage");
}
