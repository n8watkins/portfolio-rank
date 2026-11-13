// The admin tool pages (usage, images, blog drafts with their guidelines and
// compare pages, polls) share one container: the site's wide content width
// (.wrap, up to 1600 px), so every tool page lines up under the admin nav.
// Each page starts with components/admin/AdminHeader.tsx.
export default function AdminToolsLayout({ children }: { children: React.ReactNode }) {
  return <div className="wrap pb-20" data-admin-tools>{children}</div>;
}
