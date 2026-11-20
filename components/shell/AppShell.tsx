import { primaryAction } from "@/lib/nav";
import { MobileTabBar } from "@/components/shell/MobileTabBar";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { RevealObserver } from "@/components/ui/RevealObserver";
import { BlogLiveProvider } from "@/components/shell/useBlogLive";
import { blogLiveAtRender } from "@/lib/blog-live";

/**
 * The one frame every page shares (app/layout.tsx): header, <main id="main">,
 * footer and the phone tab bar. <main> spans the full width so a page can lay
 * out full-width bands; pages put their content in a `.wrap` (the one content
 * width) or their own narrower column.
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  // The visitor's grade state joins here when the grade pages ship.
  const action = primaryAction();
  // The Blog links are part of the server's HTML once a post is live (lib/blog-live.ts).
  const blogLive = await blogLiveAtRender();
  return (
    <BlogLiveProvider live={blogLive}>
    <div className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
      <div className="contents print:hidden">
        <SiteHeader action={action} />
      </div>
      <main id="main" tabIndex={-1} className="page-in w-full flex-1">
        {children}
      </main>
      <div className="print:hidden">
        <SiteFooter />
      </div>
      <div className="print:hidden">
        <MobileTabBar action={action} />
      </div>
      <RevealObserver />
    </div>
    </BlogLiveProvider>
  );
}
