import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClaimVotes } from "@/components/ClaimVotes";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "PortfolioRank — the best developer portfolios, ranked",
  description:
    "1,700+ community-curated developer portfolios, soon ranked by your votes and AI. Browse, compare, get inspired.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-bg text-ink antialiased`}>
        <ClaimVotes />
        {children}
      </body>
    </html>
  );
}
