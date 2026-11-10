import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter } from "next/font/google";
import { UndoToastProvider } from "@/components/UndoToast";
import { SignInProvider } from "@/components/SignInModal";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const TITLE = "PortfolioRank - how good is your portfolio?";
const DESCRIPTION =
  "1,700+ community-curated developer portfolios, soon ranked by your votes and AI. Browse, compare, get inspired.";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
    { media: "(prefers-color-scheme: light)", color: "#f6f6f7" },
  ],
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

// Runs before first paint: ?theme=light|dark|system (preview switcher) wins and
// is remembered, else the saved choice, else the system (no attribute).
const THEME_INIT = `(function(){try{var q=new URLSearchParams(location.search).get("theme");var k="pr-theme";if(q==="light"||q==="dark"||q==="system"){localStorage.setItem(k,q)}var t=q||localStorage.getItem(k);if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t}}catch(e){}})()`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the theme script sets data-theme before React loads.
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT}
        </Script>
        {/* Without JavaScript, scroll-reveal blocks show at once. */}
        <noscript>
          <style>{".reveal{opacity:1;transform:none}"}</style>
        </noscript>
      </head>
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
        {/* Preview branch: no sessions, so ClaimVotes (practice-vote claiming) is not mounted. */}
        <UndoToastProvider>
          <SignInProvider>{children}</SignInProvider>
        </UndoToastProvider>
      </body>
    </html>
  );
}
