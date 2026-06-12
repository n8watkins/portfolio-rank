"use client";

import { useEffect } from "react";

// Mounted in the root layout: when a signed-in session appears, ask the
// server once per tab session to convert any anon practice votes (httpOnly
// cookie, so only the server can see it) into official votes.
export function ClaimVotes() {
  useEffect(() => {
    if (sessionStorage.getItem("pr_claimed")) return;
    fetch("/api/auth/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!s?.raterId) return;
        sessionStorage.setItem("pr_claimed", "1");
        return fetch("/api/claim", { method: "POST" });
      })
      .catch(() => {});
  }, []);
  return null;
}
