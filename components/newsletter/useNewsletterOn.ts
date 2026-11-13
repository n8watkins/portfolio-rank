"use client";

import { useEffect, useState } from "react";

// Whether the newsletter is live, for every sign-up form and mention on a
// page: NEXT_PUBLIC_NEWSLETTER_ENABLED (the build's copy of the deploy-level
// kill switch) and then GET /api/newsletter/status (the owner's switch), asked
// once per page load and shared by every caller. Off until the answer says
// on, so nothing shows while the switch is off or the answer is slow.

const BUILT_ON = process.env.NEXT_PUBLIC_NEWSLETTER_ENABLED === "true";
let ask: Promise<boolean> | null = null;

function status(): Promise<boolean> {
  ask ??= fetch("/api/newsletter/status")
    .then((r) => (r.ok ? r.json() : { on: false }))
    .then((b: { on?: unknown }) => b.on === true)
    .catch(() => false);
  return ask;
}

export function useNewsletterOn(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!BUILT_ON) return;
    let live = true;
    status().then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, []);
  return on;
}
