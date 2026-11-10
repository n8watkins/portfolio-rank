import type { Visitor } from "@/lib/preview/visitor";

export type NavKey = "home" | "top" | "rank" | "browse" | "blog" | "grade" | "other";

export const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: "top", href: "/top", label: "Leaderboard" },
  { key: "rank", href: "/rank", label: "Face-off" },
  { key: "browse", href: "/browse", label: "Browse" },
  { key: "blog", href: "/blog", label: "Blog" },
];

/** The one highlighted action: grade yours, or your portfolio once that's done. */
export function primaryAction(v: Visitor, yourSlug: string): { href: string; label: string; done: boolean } {
  if (v.queued) return { href: "/me", label: "Your report", done: true };
  if (v.graded) return { href: "/me", label: "Your portfolio", done: true };
  void yourSlug;
  return { href: "/#grade", label: "Grade yours", done: false };
}
