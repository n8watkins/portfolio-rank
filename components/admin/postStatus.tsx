import type { BlogPost } from "@/lib/blog";

// Small shared pieces of the admin blog pages.

/** "Thu, Nov 12, 8:00 AM PT". */
export function pacificTime(iso: string): string {
  return `${new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })} PT`;
}

const TONE: Record<string, string> = {
  draft: "bg-accent-soft text-accent ring-accent/30",
  published: "bg-up/10 text-up ring-up/30",
  rejected: "bg-raised text-mute ring-edge",
  dropped: "bg-down/10 text-down ring-down/30",
  unpublished: "bg-raised text-mute ring-edge",
};

const LABEL: Record<string, string> = {
  draft: "Waiting for review",
  published: "Published",
  rejected: "Rejected",
  dropped: "Dropped by the checks",
  unpublished: "Unpublished",
};

export function StatusPill({ status, live = true }: { status: string; live?: boolean }) {
  return (
    <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-xs font-semibold ring-1 ring-inset ${TONE[status] ?? TONE.rejected}`}>
      {status === "published" && !live ? "Scheduled" : (LABEL[status] ?? status)}
    </span>
  );
}

/** Why a closed post is closed, in one line. */
export function closedReason(p: BlogPost): string | null {
  if (!["rejected", "dropped", "unpublished"].includes(p.status)) return null;
  if (p.checks?.owner?.note) return p.checks.owner.note;
  if (p.status === "dropped") return p.checks?.failures?.slice(0, 2).join("; ") || "failed its checks";
  const owner = p.checks?.owner;
  if (owner && (owner.action === "reject" || owner.action === "unpublish")) return `${owner.action === "reject" ? "Rejected" : "Unpublished"} by ${owner.by}`;
  return null;
}

/** The post's publish slot ("Fri 8:00 AM PT") while it is still ahead, else null. */
export function scheduledFor(p: BlogPost, now = Date.now()): string | null {
  const at = p.publishAt ? Date.parse(p.publishAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  // Short enough for one button on a phone: "Fri 8:00 AM PT" (the slot is always within a week).
  return `${new Date(at).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" })} PT`;
}

/**
 * How a draft did against its checks, in plain words. A round is one pass
 * of the writer followed by every check (facts and numbers, names and links,
 * outside claims, the template, the editorial rules, the final review); a
 * failed round sends the draft back with the problems for a revision, at
 * most twice. So "1 round" means it passed on the first try.
 */
export function checksLine(p: BlogPost): string {
  if (!p.checks?.passed) return "Did not pass its checks";
  const rounds = p.checks.rounds ?? 1;
  return rounds <= 1 ? "Passed every check on the first try" : `Passed every check after ${rounds - 1} revision${rounds - 1 === 1 ? "" : "s"}`;
}
