import Link from "next/link";
import type { Metadata } from "next";
import { EdgePage, primaryButton, secondaryButton } from "@/components/EdgePage";

export const metadata: Metadata = { title: "Page not found - PortfolioRank" };

export default function NotFound() {
  return (
    <EdgePage
      label="404 - page not found"
      title="That page isn't here."
      actions={
        <>
          <Link href="/" className={primaryButton}>
            Browse portfolios
          </Link>
          <a href="/play" className={secondaryButton}>
            Rank portfolios
          </a>
        </>
      }
    >
      It may have been removed from the list, or the link has a typo.
    </EdgePage>
  );
}
