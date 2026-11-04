import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClaimVotes } from "@/components/ClaimVotes";
import { UndoToastProvider } from "@/components/UndoToast";
import { SITE_URL } from "@/lib/site";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

const TITLE = "PortfolioRank - the best developer portfolios, ranked";
const DESCRIPTION =
  "1,700+ community-curated developer portfolios, soon ranked by your votes and AI. Browse, compare, get inspired.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
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
      <body className={`${inter.className} bg-bg text-ink antialiased`}>
        {/* Ambient gradient backdrop - fixed, behind all content. */}
        <div aria-hidden className="app-bg pointer-events-none fixed inset-0 -z-10" />
        <ClaimVotes />
        <UndoToastProvider>{children}</UndoToastProvider>
      </body>
    </html>
  );
}
