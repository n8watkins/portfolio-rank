import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight, ExternalLink } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { CaptureAgain } from "@/components/admin/CaptureAgain";
import { ScreenshotFrame } from "@/components/ui/ScreenshotFrame";
import { tag } from "@/components/ui/Chip";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { shotBases } from "@/lib/shots";
import { frameOf } from "@/lib/shot-url";
import { GROUPS, GROUP_LABELS, SHORT_TEXT, TEXT_DROP_MIN_OLD, TEXT_DROP_RATIO, captureProblems } from "@/lib/capture-problems.mjs";

// /admin/capture-problems (owner, 2026-11-22): every capture that failed, is
// bad, or got worse, in four groups (lib/capture-problems.mjs has each rule):
// A refresh failed and the old capture is kept, B the first capture failed,
// C the stored capture itself is bad, D a re-capture got worse. Newest first
// in each group. Each row shows the site, the reason in plain words, the
// stored capture's date and thumbnail, Gemini's grade, the health check's
// state and whether the site is on the owner's review list (an open review
// row, never the needs_review flag alone). Its only actions are ones the
// admin already has: Capture again (the Re-measure request) and a link to
// the Review page, which has no link to one row. Only the admin sees it;
// anyone else gets a 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Capture problems - PortfolioRank admin", robots: { index: false, follow: false } };

type Problems = Awaited<ReturnType<typeof captureProblems>>;
type Row = Problems["A"][number] & { lost?: string[]; measuring?: boolean };

const ABOUT: Record<string, string> = {
  A: "A nightly re-capture of a listed site did not show the site. The good capture it had is kept and shown; the re-capture is tried again after a growing wait.",
  B: "A site on our list that has never had a good capture. Until the health check sees it working, it is hidden from browsing, face-offs and boards; the capture is tried again after a growing wait.",
  C: `A listed site whose stored capture reads as a bot or security check, or has no words or under ${SHORT_TEXT} characters of page text.`,
  D: `A re-capture that lost a résumé, GitHub or contact link the capture before it had, or kept under ${Math.round(TEXT_DROP_RATIO * 100)}% of a text over ${TEXT_DROP_MIN_OLD} characters. Only captures measured by the same code are compared.`,
};

const n = (v: number) => v.toLocaleString("en-US");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }) : null);
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// The static tag in a colour (its own text colour replaces the tag's muted one), and one that may wrap on a phone.
const tagWrap = tag.replace("h-6", "min-h-6 py-0.5 leading-snug").replace("rounded-full", "rounded-xl");
const tagDown = `${tagWrap.replace("text-mute", "")} text-down ring-down/40`;
const tagAccent = `${tagWrap.replace("text-mute", "")} text-accent ring-accent/40`;

function gradeTag(g: Row["grade"]) {
  if (g.state === "none") return { text: "Not graded", cls: tagWrap };
  if (g.state === "failed") return { text: "Grade failed", cls: tagDown };
  if (g.state === "not_portfolio") return { text: "Gemini: not a portfolio", cls: tagDown };
  return { text: g.tier ? `Gemini: tier ${g.tier}` : "Gemini: portfolio", cls: tagWrap };
}

function healthTag(h: string | null) {
  if (h === "down") return { text: "Health: not working", cls: tagDown };
  if (h === "suspect") return { text: "Health: failing", cls: tagDown };
  if (h === "live") return { text: "Health: up", cls: tagWrap };
  return { text: "Health: not checked", cls: tagWrap };
}

/** When it happened and when it is tried again, in the group's words: phrases that each stay on one line. */
function timing(r: Row): string[] {
  const at = day(r.at);
  const next = day(r.retryAt);
  const parts =
    r.group === "A"
      ? [at && `Failed ${at}`, (r.attempts ?? 0) > 1 && `${r.attempts} times in a row`, next && `next try ${next}`]
      : r.group === "B"
        ? [at && `Last tried ${at}`, (r.attempts ?? 0) > 0 && `${r.attempts} ${r.attempts === 1 ? "try" : "tries"}`, next && `next try ${next}`]
        : r.group === "D"
          ? [at && `Re-captured ${at}`]
          : [];
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0);
}

function ProblemRow({ r, base }: { r: Row; base: string | null }) {
  const domain = domainOf(r.url);
  const grade = gradeTag(r.grade);
  const health = healthTag(r.health);
  const when = timing(r);
  const captured = day(r.capturedAt);
  // Capture again moves a live, listed, captured site's next re-capture to tonight (lib/freshness.mjs screenshotsDue).
  const again = Boolean(r.shotKey && r.listed && r.status === "live");
  return (
    <li className="card p-4 sm:p-5" data-capture-problem={r.url} data-group={r.group}>
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <div className="min-w-0">
          {/* The fallback's domain on one line with an ellipsis (the full domain is beside it), never broken mid-word. */}
          <ScreenshotFrame
            src={base ? frameOf(base, "hero.jpg") : null}
            alt={captured ? `${domain}, the stored capture from ${captured}` : `${domain}: no stored capture`}
            domain={domain}
            className="rounded-lg ring-1 ring-edge [&>span]:w-full [&>span>span]:block [&>span>span]:truncate [&>span>span]:break-normal"
          />
          <p className="mt-1.5 text-xs text-mute" data-capture-date>
            {captured ? (
              <>
                Captured <span className="whitespace-nowrap">{captured}</span>
              </>
            ) : (
              "No capture"
            )}
          </p>
        </div>
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 font-bold [overflow-wrap:anywhere] hover:text-accent">
              {domain}
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-mute" aria-hidden />
              <span className="sr-only">(opens the site)</span>
            </a>
            {r.name && r.name !== domain && <span className="min-w-0 truncate text-sm text-mute">{r.name}</span>}
          </p>
          <p className="mt-1 text-sm text-pretty" data-reason>
            {r.reason.text}
          </p>
          {r.reason.phoneOnly && r.group === "A" && (
            <p className="mt-1 text-xs text-mute" data-phone-only>
              Kept off your review list: our own second visit may have tripped the site&rsquo;s protection.
            </p>
          )}
          {when.length > 0 && (
            <p className="mt-1 text-xs text-mute tabular-nums" data-timing>
              {when.map((w, i) => (
                <span key={w}>
                  {i > 0 && " · "}
                  <span className="whitespace-nowrap">{w}</span>
                </span>
              ))}
            </p>
          )}
          <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="State">
            <li className={grade.cls} data-grade>
              {grade.text}
            </li>
            <li className={health.cls} data-health>
              {health.text}
            </li>
            <li className={r.onReview ? tagAccent : tagWrap} data-review={r.onReview ? "yes" : "no"}>
              {r.onReview ? "On your review list" : "Not on your review list"}
            </li>
            {!r.listed && <li className={tagWrap}>Off the list</li>}
          </ul>
          {(again || r.reviewId != null) && (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {again && <CaptureAgain url={r.url} domain={domain} />}
              {r.reviewId != null && (
                <Link href="/admin/review" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent hover:underline" data-open-review>
                  Open Review
                </Link>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export default async function AdminCaptureProblemsPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const p = await captureProblems(db());
  const all = [...p.A, ...p.B, ...p.C, ...p.D, ...p.measuring] as Row[];
  const bases = await shotBases([...new Set(all.filter((r) => r.shotKey).map((r) => r.url))]);
  const baseOf = (r: Row) => bases.get(r.url) ?? null;

  return (
    <>
      <AdminHeader title="Capture problems">
        Every capture that failed, is bad, or got worse. A re-capture that meets a bot check, or a dialog still covering the page, also goes to your review list, unless only the phone-size visit saw it.{" "}
        {p.sites === 0 ? "Nothing open right now." : `${n(p.sites)} ${p.sites === 1 ? "site" : "sites"} with an open problem, newest first in each group.`}
      </AdminHeader>

      <nav aria-label="Groups" className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-capture-counts>
        {GROUPS.map((g) => (
          <a key={g} href={`#group-${g}`} className="card card-hover flex min-w-0 flex-col p-4" data-count={g}>
            <span className="text-2xl font-bold leading-none tabular-nums">{n(p.counts[g as keyof typeof p.counts])}</span>
            <span className="mt-1.5 text-xs text-mute text-pretty">
              {g}. {GROUP_LABELS[g as keyof typeof GROUP_LABELS]}
            </span>
          </a>
        ))}
      </nav>

      {GROUPS.map((g) => {
        const rows = p[g as "A" | "B" | "C" | "D"] as Row[];
        return (
          <section key={g} id={`group-${g}`} className="mt-8 scroll-mt-6" aria-labelledby={`group-${g}-heading`} data-capture-group={g}>
            <h2 id={`group-${g}-heading`} className="flex flex-wrap items-baseline gap-x-2 text-lg font-bold tracking-tight">
              <span>
                {g}. {GROUP_LABELS[g as keyof typeof GROUP_LABELS]}
              </span>
              <span className="text-sm font-semibold text-mute tabular-nums">{n(rows.length)}</span>
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-mute text-pretty">{ABOUT[g]}</p>
            {rows.length === 0 ? (
              <p className="card mt-3 p-5 text-sm text-mute">None.</p>
            ) : (
              <ul className="mt-3 grid gap-3">
                {rows.map((r) => (
                  <ProblemRow key={`${g}:${r.url}`} r={r} base={baseOf(r)} />
                ))}
              </ul>
            )}
            {g === "C" && p.unmeasured > 0 && (
              <p className="mt-3 max-w-3xl text-sm text-mute text-pretty" data-unmeasured>
                {p.unmeasured === 1
                  ? "Not checked: 1 capture was made before captures stored their page text (2026-11-10), so it has no text to measure. It is not counted here."
                  : `Not checked: ${n(p.unmeasured)} captures were made before captures stored their page text (2026-11-10), so they have no text to measure. They are not counted here.`}
              </p>
            )}
            {g === "D" && p.measuring.length > 0 && (
              <details className="group/m mt-4" data-measuring>
                <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-sm font-semibold text-mute hover:text-ink [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="h-4 w-4 shrink-0 text-mute transition group-open/m:rotate-90 motion-reduce:transition-none" aria-hidden />
                  {n(p.measuring.length)} changed with new measuring code (not counted)
                </summary>
                <p className="mt-1 max-w-3xl text-sm text-mute text-pretty">
                  These captures were measured by newer code than the ones before them, so a lost link may be the code reading the page differently, not the site changing.
                </p>
                <ul className="mt-3 grid gap-3">
                  {(p.measuring as Row[]).map((r) => (
                    <ProblemRow key={`m:${r.url}`} r={r} base={baseOf(r)} />
                  ))}
                </ul>
              </details>
            )}
          </section>
        );
      })}
    </>
  );
}
