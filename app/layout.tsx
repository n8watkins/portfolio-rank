import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClaimVotes } from "@/components/ClaimVotes";
import { UndoToastProvider } from "@/components/UndoToast";
import { SignInProvider } from "@/components/SignInModal";
import { IS_STAGING, SITE_URL } from "@/lib/site";
import { StagingRibbon } from "@/components/StagingRibbon";
import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const TITLE = "PortfolioRank - the best developer portfolios, ranked";
const DESCRIPTION =
  `${PORTFOLIO_COUNT_LABEL} community-curated developer portfolios, ranked by your votes and AI. Browse, compare, get inspired.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  // The share image is app/opengraph-image.tsx (and twitter-image.tsx).
  openGraph: { type: "website", siteName: "PortfolioRank", title: TITLE, description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  // The staging site is never indexed (lib/site.ts IS_STAGING).
  ...(IS_STAGING ? { robots: { index: false, follow: false } } : {}),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-bg text-ink antialiased`}>
        {/* Ambient gradient backdrop - fixed, behind all content. */}
        <div aria-hidden className="app-bg pointer-events-none fixed inset-0 -z-10" />
        {/* Pages put their content in <main id="main">; the first Tab offers to jump there. */}
        <a
          href="#main"
          className="sr-only rounded-lg bg-accent text-sm font-semibold text-bg focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[70] focus:px-4 focus:py-2.5"
        >
          Skip to content
        </a>
        {IS_STAGING && <StagingRibbon />}
        <ClaimVotes />
        <UndoToastProvider>
          <SignInProvider>{children}</SignInProvider>
        </UndoToastProvider>
      </body>
    </html>
  );
}
