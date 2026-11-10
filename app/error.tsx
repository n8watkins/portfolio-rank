"use client";

import Link from "next/link";
import { useEffect } from "react";
import { EdgePage, primaryButton, secondaryButton } from "@/components/EdgePage";
import { reportError } from "@/lib/error-reporting";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error), [error]);

  return (
    <EdgePage
      label="Something went wrong"
      title="This page didn't load."
      actions={
        <>
          <button type="button" onClick={reset} className={primaryButton}>
            Try again
          </button>
          <Link href="/" className={secondaryButton}>
            Browse portfolios
          </Link>
        </>
      }
    >
      That&apos;s on us, not you, and it has been reported. Your votes and lists are safe.
    </EdgePage>
  );
}
