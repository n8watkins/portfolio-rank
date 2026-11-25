import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ClaimVotes } from "@/components/ClaimVotes";
import { UndoToastProvider } from "@/components/UndoToast";
import { SignInProvider } from "@/components/SignInModal";
import { AppShell } from "@/components/shell/AppShell";
import { SITE_URL } from "@/lib/site";
import { PORTFOLIO_COUNT_LABEL } from "@/lib/portfolio-count";
import "./globals.css";

// Self-hosted by next/font, with a metric-matched fallback so text doesn't shift when it loads.
const inter = Inter({ subsets: ["latin"], display: "swap" });

const TITLE = "PortfolioRank - the best developer portfolios, ranked";
const DESCRIPTION =
  `${PORTFOLIO_COUNT_LABEL} community-curated developer portfolios, ranked by your votes and AI. Browse, compare, get inspired.`;

export const viewport: Viewport = {
  themeColor: "#070709",
  colorScheme: "dark",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "PortfolioRank",
  appleWebApp: { capable: true, title: "PortfolioRank", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/apple-touch-icon.png" },
  title: TITLE,
  description: DESCRIPTION,
  // The share image is app/opengraph-image.tsx (and twitter-image.tsx).
  openGraph: { type: "website", siteName: "PortfolioRank", title: TITLE, description: DESCRIPTION, url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* Without JavaScript, scroll-reveal blocks show at once. */}
        <noscript>
          <style>{".reveal{opacity:1;transform:none}"}</style>
        </noscript>
      </head>
      <body className={`${inter.className} bg-bg text-ink antialiased`}>
        {/* Ambient glow - fixed, behind all content. */}
        <div aria-hidden className="app-bg pointer-events-none fixed inset-0 -z-10" />
        {/* The shell's <main id="main">; the first Tab offers to jump there. */}
        <a
          href="#main"
          className="sr-only rounded-lg bg-fill text-sm font-semibold text-on-fill focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[70] focus:px-4 focus:py-2.5"
        >
          Skip to content
        </a>
        <ClaimVotes />
        <UndoToastProvider>
          <SignInProvider>
            <AppShell>{children}</AppShell>
          </SignInProvider>
        </UndoToastProvider>
      </body>
    </html>
  );
}
