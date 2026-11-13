"use client";

import { useEffect } from "react";
import { readSession } from "@/lib/session-client";

// Mounted in the root layout: when a signed-in session appears, ask the
// server once per tab session to convert any anon practice votes (httpOnly
// cookie, so only the server can see it) into official votes. It reads the
// page's one session request (lib/session-client.ts), never its own.
export function ClaimVotes() {
  useEffect(() => {
    if (sessionStorage.getItem("pr_claimed")) return;
    readSession()
      .then((s) => {
        if (!s?.raterId) return;
        sessionStorage.setItem("pr_claimed", "1");
        return fetch("/api/claim", { method: "POST" });
      })
      .catch(() => {});
  }, []);
  return null;
}
