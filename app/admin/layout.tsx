import { AdminNav } from "@/components/admin/AdminNav";
import { requireAdmin } from "@/lib/admin";

// Every /admin page sits under this: the admin nav in the site's one content
// width. Anyone but the admin gets the page alone, which answers 404, so the
// address says nothing. The tool pages add the shared container and header
// in app/admin/(tools)/layout.tsx; a draft's review page (blog/[id]) is the
// public article's layout and keeps its own reading column.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const who = await requireAdmin();
  if ("error" in who) return children;
  return (
    <>
      <div className="wrap pt-6" data-admin-layout>
        <AdminNav />
      </div>
      {children}
    </>
  );
}
