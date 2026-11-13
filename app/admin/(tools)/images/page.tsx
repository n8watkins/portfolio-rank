import { ChevronRight } from "lucide-react";
import { AdminHeader } from "@/components/admin/AdminHeader";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin";
import { db, ensureSchema } from "@/lib/db";
import { associations, librarySummary, listImages, queueItems } from "@/lib/content/library.mjs";
import { aiHeadroom, aiLimits, aiUsage, neuronsFor } from "@/lib/content/neurons.mjs";
import { HOUSE_STYLE, THEMES } from "@/pipeline/content/house-style.mjs";
import { libraryConfig, libraryOffReason } from "@/pipeline/content/library-stage.mjs";
import { automaticText } from "@/lib/content/library-view.mjs";
import { LibraryReview, type LibraryImage } from "@/components/admin/LibraryReview";

// The image library's review page (docs/CONTENT-ENGINE.md, "The image
// library"). The images are the page: tabs for the images to review,
// approved, dropped, failed the check and all, with search and tag filters,
// over a thumbnail grid; a thumbnail opens the image large with its editable
// alt text and tags, the decision and the posts it is tied to. Beside the
// grid, compact panels: "Make now" with progress, "Make your own", the queue
// of subjects still to make (editable) and "How images are made" (live from
// the counters, no metered call). Only the admin sees it; anyone else gets a
// 404.
export const dynamic = "force-dynamic";
export const metadata = { title: "Image library - PortfolioRank admin", robots: { index: false, follow: false } };

const n = (v: number) => v.toLocaleString("en-US");
const MODEL_NAME: Record<string, string> = { schnell: "Flux Schnell", flux2dev: "Flux 2 Dev", lucid: "Lucid Origin" };

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-edge bg-raised px-3 py-2">
      <dt className="text-xs font-semibold text-mute">{label}</dt>
      <dd className="mt-0.5 font-bold tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-mute">{hint}</dd>}
    </div>
  );
}

export default async function AdminImagesPage() {
  const who = await requireAdmin();
  if ("error" in who) notFound();
  await ensureSchema();
  const client = db();
  const now = new Date();
  const config = libraryConfig(process.env);
  const limits = aiLimits(process.env);
  const model = config.model;
  const [summary, images, ai, room, queue, links] = await Promise.all([
    librarySummary(client, { now }),
    listImages(client, { limit: 1000 }),
    aiUsage(client, { limits, now }),
    aiHeadroom(client, { limits, neurons: neuronsFor(model), now }),
    queueItems(client),
    associations(client),
  ]);
  const off = libraryOffReason({ ...config, ai: true }, now.getTime());
  const label = new Map(THEMES.map((t) => [t.id, t.theme]));
  const rows: LibraryImage[] = images.map((i) => ({
    id: i.id,
    theme: i.theme,
    themeLabel: label.get(i.theme) ?? (i.theme === "custom" ? "Your own" : i.theme === "post" ? "Made for a post" : i.theme),
    subject: i.subject,
    alt: i.alt,
    tags: i.tags,
    style: i.style,
    model: i.model,
    status: i.status,
    note: i.check?.note ?? i.check?.error ?? null,
    uses: i.uses ?? 0,
    createdAt: i.createdAt,
    posts: links.get(i.id) ?? [],
  }));
  const c = summary.counts;
  const share = ai.ceiling ? Math.round((ai.neurons / ai.ceiling) * 100) : 0;
  const howMade = (
    <details className="group rounded-xl border border-edge bg-card text-sm" data-how-made>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 font-bold [&::-webkit-details-marker]:hidden">
        How images are made
        <ChevronRight aria-hidden className="h-4 w-4 shrink-0 text-mute transition group-open:rotate-90 motion-reduce:transition-none" />
      </summary>
      <div className="border-t border-edge px-4 pb-4 pt-3">
        <p className="text-xs leading-relaxed text-mute">
          <strong className="text-ink">{MODEL_NAME[model] ?? model}</strong> on Cloudflare Workers AI, about {n(neuronsFor(model))} neurons an image.{" "}
          <strong className="text-ink">Cost: $0</strong>, inside the free daily allowance: at most 40 a day and 2,500 neurons, reserved before every call, and nothing is made once a limit is reached, so it can never bill. If {MODEL_NAME[model] ?? model} errors, the fallback is Lucid Origin (about {n(neuronsFor("lucid"))} neurons), only when the day has room. Flux 2 Dev is {model === "flux2dev" ? "on" : "off"}. Each image gets one Gemini check, then waits for you.
        </p>
        <p className="mt-2 text-xs text-mute" data-daily-run>
          <strong className="text-ink">{automaticText(config.runHour, now)}</strong> Make now and Make your own can use the 40 at any time before then.
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-2" data-ai-images>
          <Stat label="Made today" value={`${ai.images} of ${ai.maxImages}`} hint={`${ai.maxImages} a day, resets 00:00 UTC`} />
          <Stat label="This hour" value={n(ai.lastHour)} hint="no hourly cap" />
          <Stat label="This month" value={n(summary.madeThisMonth)} hint={`${n(summary.made)} all time`} />
          <Stat label="Neurons today" value={`${share}%`} hint={`${n(ai.neurons)} of the ${n(ai.ceiling)} slice`} />
          <Stat label="Kept" value={n(c.approved + c.retired)} hint={c.retired ? `${c.retired} since retired` : "approved"} />
          <Stat label="Dropped" value={n(c.rejected)} hint={`${c["rejected-auto"]} failed the check`} />
          <Stat label="Retired" value={n(c.retired)} />
          <Stat label="Used in" value={`${n(summary.usedInPosts)} post${summary.usedInPosts === 1 ? "" : "s"}`} hint={`${n(summary.usedInPublished)} published`} />
        </dl>
      </div>
    </details>
  );
  return (
    <>
      <AdminHeader title="Image library">
        <span className="tabular-nums">
          {n(c.approved)} approved · {n(c.pending)} to review · used in {n(summary.usedInPosts)} post{summary.usedInPosts === 1 ? "" : "s"}
        </span>
        {ai.problem && <span className="mt-1 block text-down">{ai.problem}</span>}
      </AdminHeader>
      <LibraryReview
        images={rows}
        queue={queue.map((q) => ({ theme: q.theme, themeLabel: q.themeLabel, index: q.index, subject: q.subject, original: q.original, edited: q.edited, skipped: q.skipped, prompt: q.prompt, alt: q.alt, tags: q.tags }))}
        subjects={summary.subjects}
        usage={{ images: ai.images, maxImages: ai.maxImages, lastHour: ai.lastHour, perHour: ai.perHour, neurons: ai.neurons, ceiling: ai.ceiling }}
        room={{ remaining: room.remaining, blocker: room.blocker, nextAt: room.nextAt, quiet: off?.code === "quiet", off: off?.code === "off" ? off.text : null }}
        themes={THEMES.map((t) => ({ id: t.id, label: t.theme }))}
        houseStyle={HOUSE_STYLE}
        howMade={howMade}
      />
    </>
  );
}
