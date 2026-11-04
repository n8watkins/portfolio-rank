"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/error-reporting";

// Shown only when the root layout itself fails, so it carries its own markup
// and styles (the app's dark palette from globals.css, inlined).
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportError(error), [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0a0a0b", color: "#ededf0", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
        <main style={{ maxWidth: 448, margin: "0 auto", minHeight: "80vh", padding: "64px 16px", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" }}>
          <p style={{ fontWeight: 700, fontSize: 16 }}>
            Portfolio<span style={{ color: "#fbbf24" }}>Rank</span>
          </p>
          <h1 style={{ fontSize: 30, lineHeight: 1.2, margin: "32px 0 0" }}>PortfolioRank didn&apos;t load.</h1>
          <p style={{ color: "#8b8b93", fontSize: 14, lineHeight: 1.6, margin: "12px 0 0" }}>
            That&apos;s on us, not you, and it has been reported. Your votes and lists are safe.
          </p>
          <button type="button" onClick={reset} style={{ marginTop: 32, padding: "10px 20px", borderRadius: 8, border: 0, background: "#fbbf24", color: "#0a0a0b", fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
