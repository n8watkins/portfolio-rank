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

/** What Publish does for this draft: at once, or at its scheduled 08:00 Pacific. */
export function publishLabel(p: BlogPost, now = Date.now()): string {
  const at = p.publishAt ? Date.parse(p.publishAt) : NaN;
  return Number.isFinite(at) && at > now ? `Publish ${pacificTime(p.publishAt!)}` : "Publish now";
}
