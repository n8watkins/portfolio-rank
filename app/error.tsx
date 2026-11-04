"use client";

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
          <a href="/" className={secondaryButton}>
            Browse portfolios
          </a>
        </>
      }
    >
      That&apos;s on us, not you, and it has been reported. Your votes and lists are safe.
    </EdgePage>
  );
}
