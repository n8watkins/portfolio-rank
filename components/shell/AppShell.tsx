import { PreviewBar } from "@/components/preview/PreviewBar";
import { RevealObserver } from "@/components/preview/RevealObserver";
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
  bleed = false,
}: {
  visitor: Visitor;
  current: NavKey;
  children: React.ReactNode;
  /** The page lays out its own full-width bands (and .wrap containers). */
  bleed?: boolean;
}) {
  const action = primaryAction(visitor, sampleVisitorSite().slug);
  const name = "Jordan";
  return (
    <div className="flex min-h-dvh flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] lg:pb-0">
      <PreviewBar state={visitor.state} />
      <SiteHeader current={current} action={action} signedIn={visitor.signedIn} name={name} />
      <main id="main" tabIndex={-1} className={`page-in flex-1 ${bleed ? "w-full" : "wrap"}`}>
        {children}
      </main>
      <SiteFooter />
      <MobileTabBar current={current} action={action} signedIn={visitor.signedIn} />
      <RevealObserver />
    </div>
  );
}
