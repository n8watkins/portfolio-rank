import { PreviewBar } from "@/components/preview/PreviewBar";
import { RevealObserver } from "@/components/preview/RevealObserver";
import { RegionNotice } from "@/components/preview/RegionNotice";
import { MobileTabBar } from "@/components/shell/MobileTabBar";
import { SiteFooter } from "@/components/shell/SiteFooter";
import { SiteHeader } from "@/components/shell/SiteHeader";
import { primaryAction, type NavKey } from "@/components/shell/nav";
import { sampleVisitorSite } from "@/lib/preview/data";
import type { Visitor } from "@/lib/preview/visitor";

/** The one frame every page shares: header, one width, footer, phone tab bar. */
export function AppShell({
  visitor,
  current,
  children,
}: {
  visitor: Visitor;
  current: NavKey;
  children: React.ReactNode;
}) {
  const action = primaryAction(visitor, sampleVisitorSite().slug);
  const name = "Jordan";
  return (
    <div className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
      <PreviewBar state={visitor.state} region={visitor.blocked ? "blocked" : "open"} />
      <SiteHeader current={current} action={action} signedIn={visitor.signedIn} name={name} blocked={visitor.blocked} />
      {visitor.country && <RegionNotice country={visitor.country} />}
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        {children}
      </main>
      <SiteFooter />
      <MobileTabBar current={current} action={action} signedIn={visitor.signedIn} />
      <RevealObserver />
    </div>
  );
}
