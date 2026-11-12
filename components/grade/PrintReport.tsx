import { Check, Wrench, X } from "lucide-react";
import { TIER_STYLE } from "@/components/ui/badges";
import { SITE_URL } from "@/lib/site";
import type { GradePage } from "@/lib/grade-page";

type Groups = NonNullable<GradePage["report"]>["groups"];
type Fix = NonNullable<GradePage["report"]>["fixes"][number];

/**
 * The grade report on paper ("Download PDF" and the browser's own print):
 * its own layout instead of the screen page squeezed onto paper. It renders
 * only in print (the screen report is print:hidden), sized to fit both
 * Letter and A4: a cover page with the result, the screenshot and the fix to
 * make first, then the fixes, the measured facts and Gemini's scores in
 * blocks that never split across pages. The site's header, footer and
 * buttons don't print; each page's footer carries the report's address and
 * "Page N of M" (CSS page margin boxes).
 */
export function PrintReport(p: {
  id: string;
  name: string;
  url: string;
  domain: string;
  hero: string | null;
  tier: string;
  percentile: { topPct: number; total: number; rank: number } | null;
  verdict: string;
  gradedAt: string;
  model: string | null;
  groups: Groups;
  judgments: { id: string; label: string; score: number; note: string }[];
  fixes: Fix[];
  better: { name: string; domain: string; label: string; theirs: number; yours: number; note: string } | null;
  similar: { name: string; domain: string; tier: string; topPct: number | null }[];
  covered: number;
  factCount: number;
}) {
  // The Worker's own address (staging prints staging's), else the site's.
  const reportUrl = `${(process.env.AUTH_URL || SITE_URL).replace(/^https?:\/\//, "").replace(/\/$/, "")}/grade/${p.id}`;
  const first = p.fixes[0] ?? null;
  // The id is [A-Za-z0-9_-] only (lib/grader/jobs.mjs JOB_ID), so it is safe inside a CSS string.
  const pageCss = `@page{size:auto;margin:14mm 15mm 16mm;@bottom-left{content:"${reportUrl}";font:500 8pt Inter,system-ui,sans-serif;color:#6b6b75}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:500 8pt Inter,system-ui,sans-serif;color:#6b6b75}}`;

  return (
    <article className="print-report hidden text-ink print:block">
      <style>{pageCss}</style>

      {/* Cover */}
      <section className="pr-cover">
        <div className="flex items-center justify-between border-b border-edge pb-[3mm] text-[9pt] text-mute">
          <span className="font-semibold uppercase tracking-[0.14em]">Portfolio grade report</span>
          <span>Graded {p.gradedAt}</span>
        </div>

        <h1 className="mt-[7mm] text-[26pt] font-bold leading-tight tracking-tight">{p.name}</h1>
        <p className="mt-[1mm] text-[11pt] text-mute">{p.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}</p>

        <div className="mt-[6mm] flex items-center gap-[6mm]">
          <span className={`grid h-[22mm] w-[22mm] shrink-0 place-items-center rounded-[4mm] text-[30pt] font-bold ${TIER_STYLE[p.tier] ?? TIER_STYLE.C}`}>{p.tier}</span>
          <div>
            {p.percentile ? (
              <>
                <p className="text-[34pt] font-bold leading-none tracking-tight">Top {p.percentile.topPct}%</p>
                <p className="mt-[1.5mm] text-[10pt] text-mute">
                  About #{p.percentile.rank.toLocaleString("en-US")} of {p.percentile.total.toLocaleString("en-US")} graded developer portfolios
                </p>
              </>
            ) : (
              <p className="text-[30pt] font-bold leading-none">Tier {p.tier}</p>
            )}
          </div>
        </div>
        <p className="mt-[5mm] text-[13pt] font-medium">{p.verdict}</p>

        <div className="mt-[6mm] overflow-hidden rounded-[3mm] border border-edge">
          {p.hero ? (
            // eslint-disable-next-line @next/next/no-img-element -- print needs a plain, eagerly loaded image
            <img src={p.hero} alt="" className="block h-[80mm] w-full object-cover object-top" />
          ) : (
            <div className="grid h-[40mm] place-items-center bg-raised text-[10pt] text-mute">No screenshot</div>
          )}
        </div>

        {first && (
          <div className="pr-block mt-[6mm] flex gap-[3mm] rounded-[3mm] border border-accent/50 bg-accent-soft p-[4mm]">
            <Wrench className="mt-[0.5mm] h-[4.5mm] w-[4.5mm] shrink-0 text-accent" aria-hidden />
            <div className="text-[10pt]">
              <p className="text-[8pt] font-bold uppercase tracking-wider text-accent">Fix this first</p>
              <p className="mt-[0.5mm] text-[11.5pt] font-semibold">{first.title}</p>
              <p className="mt-[0.5mm] text-mute">{first.why}</p>
              {first.effect && <p className="mt-[1mm]">Expected: {first.effect}</p>}
            </div>
          </div>
        )}

        <div className="mt-[5mm] grid grid-cols-3 gap-[3mm] text-[9pt]">
          <Tile label="Hiring basics" value={`${p.covered} of ${p.factCount}`} note="covered" />
          <Tile label="Fixes" value={String(p.fixes.length)} note="to make" />
          <Tile label="Gemini's average" value={avg(p.judgments)} note="out of 5" />
        </div>
      </section>

      {/* The details */}
      {p.fixes.length > 0 && (
        <section className="pr-block pr-page-start">
          <h2 className="pr-h2">Fix these first</h2>
          <ol className="mt-[3mm] grid gap-[2.5mm]">
            {p.fixes.map((f, i) => (
              <li key={f.criterion} className="pr-block flex gap-[3mm] rounded-[2.5mm] border border-edge p-[3.5mm] text-[10pt]">
                <span className="grid h-[6mm] w-[6mm] shrink-0 place-items-center rounded-full bg-raised text-[9pt] font-bold">{i + 1}</span>
                <div>
                  <p className="font-semibold">
                    {f.title} <span className="text-[8pt] font-medium text-mute">({f.by === "code" ? "measured" : "Gemini"})</span>
                  </p>
                  <p className="text-mute">{f.why}</p>
                  {f.effect && <p className="mt-[0.5mm]">Expected: {f.effect}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className={`pr-block ${p.fixes.length ? "mt-[8mm]" : "pr-page-start"}`}>
        <h2 className="pr-h2">What a hiring manager sees</h2>
        <p className="text-[9pt] text-mute">Checked by code.</p>
        <div className="mt-[3mm] grid gap-[2.5mm]">
          {p.groups.map((g) => (
            <div key={g.key} className="pr-block rounded-[2.5mm] border border-edge p-[3.5mm] text-[10pt]">
              <p className="font-semibold">{g.title}</p>
              <ul className="mt-[1.5mm] grid gap-[1mm]">
                {g.ok.map((f) => (
                  <li key={f.id} className="flex items-start gap-[2mm]">
                    <Check className="mt-[0.6mm] h-[3.5mm] w-[3.5mm] shrink-0 text-up" aria-hidden /> {f.short}
                  </li>
                ))}
                {g.missing.map((f) => (
                  <li key={f.id} className="flex items-start gap-[2mm]">
                    <X className="mt-[0.6mm] h-[3.5mm] w-[3.5mm] shrink-0 text-down" aria-hidden />
                    <span>
                      <span className="font-medium">{f.short}:</span> <span className="text-mute">{f.detail}.</span> Fix: {f.fix}
                    </span>
                  </li>
                ))}
                {g.unknown.map((f) => (
                  <li key={f.id} className="flex items-start gap-[2mm] text-mute">
                    <span className="mt-[0.6mm] h-[3.5mm] w-[3.5mm] shrink-0 text-center leading-none">-</span> {f.short}: not measured
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="pr-block mt-[8mm]">
        <h2 className="pr-h2">How it looks and reads</h2>
        <p className="text-[9pt] text-mute">Gemini{p.model ? ` (${p.model})` : ""}, from one screenshot and the page text, 1 to 5.</p>
        <table className="mt-[3mm] w-full border-collapse text-[10pt]">
          <tbody>
            {p.judgments.map((j) => (
              <tr key={j.id} className="pr-block border-t border-edge align-top">
                <td className="w-[45mm] py-[2mm] pr-[3mm] font-semibold">{j.label}</td>
                <td className="w-[30mm] py-[2.6mm]">
                  <span className="flex gap-[1mm]">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <span key={i} className={`h-[1.6mm] w-[4.5mm] rounded-full ${i <= j.score ? "pr-bar-on" : "pr-bar-off"}`} />
                    ))}
                  </span>
                </td>
                <td className="w-[10mm] py-[2mm] font-semibold tabular-nums">{j.score}/5</td>
                <td className="py-[2mm] text-mute">{j.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {(p.better || p.similar.length > 0) && (
        <section className="pr-block mt-[8mm]">
          <h2 className="pr-h2">Portfolios to learn from</h2>
          {p.better && (
            <p className="mt-[2mm] text-[10pt]">
              <span className="font-semibold">{p.better.name}</span> <span className="text-mute">({p.better.domain})</span>: better {p.better.label.toLowerCase()}, {p.better.theirs} vs {p.better.yours}.{" "}
              {p.better.note && <span className="text-mute">{p.better.note}</span>}
            </p>
          )}
          {p.similar.length > 0 && (
            <p className="mt-[2mm] text-[10pt]">
              <span className="font-semibold">Similar: </span>
              {p.similar.map((s, i) => (
                <span key={s.domain}>
                  {s.name} <span className="text-mute">({s.domain}, tier {s.tier})</span>
                  {i < p.similar.length - 1 ? ", " : "."}
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      <p className="pr-block mt-[8mm] border-t border-edge pt-[3mm] text-[8.5pt] text-mute">
        A grade describes the page, not the developer: Gemini&apos;s judgement is an opinion, the measured facts are checked by code. Full report: {reportUrl}
      </p>
    </article>
  );
}

function avg(js: { score: number }[]): string {
  if (!js.length) return "-";
  return (js.reduce((n, j) => n + j.score, 0) / js.length).toFixed(1);
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-[2.5mm] border border-edge p-[3mm]">
      <p className="text-[7.5pt] font-semibold uppercase tracking-wider text-mute">{label}</p>
      <p className="mt-[0.5mm]">
        <span className="text-[15pt] font-bold tabular-nums">{value}</span> <span className="text-mute">{note}</span>
      </p>
    </div>
  );
}
