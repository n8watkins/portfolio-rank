import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings - PortfolioRank", robots: { index: false } };

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
