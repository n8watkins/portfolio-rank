import type { ReactNode } from "react";

// The building blocks of the policy pages (/privacy, /terms, /removal), from
// the drafts in docs/legal. Plain static markup: the pages are prerendered and
// do no work per request.

/** The date the policy pages last changed; shown at the top of each. */
export const LEGAL_UPDATED = "November 12, 2026";
export const CONTACT_EMAIL = "nate@n8builds.dev";

export const linkClass = "font-medium text-ink underline decoration-edge-strong underline-offset-2 hover:decoration-accent";

export function LegalPage({ title, intro, children }: { title: string; intro: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 sm:px-6">
      <header className="py-6">
        <h1 className="text-3xl font-bold tracking-tight text-balance">{title}</h1>
        <p className="mt-1 text-sm text-mute">Last updated {LEGAL_UPDATED}</p>
        <div className="mt-4 space-y-3 text-[15px] leading-relaxed text-mute">{intro}</div>
      </header>
      <div className="grid gap-10">{children}</div>
      <nav aria-label="Policies" className="mt-14 flex flex-wrap gap-x-5 gap-y-2 border-t border-edge pt-5 text-sm">
        <a href="/privacy" className={linkClass}>Privacy</a>
        <a href="/terms" className={linkClass}>Terms</a>
        <a href="/removal" className={linkClass}>Remove or don&apos;t name me</a>
        <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass}>{CONTACT_EMAIL}</a>
      </nav>
    </div>
  );
}

/** A titled part of a policy page, with an anchor so it can be linked to. */
export function LegalSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="scroll-mt-24">
      <h2 id={id} className="text-xl font-bold tracking-tight text-balance">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-mute [&_strong]:font-semibold [&_strong]:text-ink">{children}</div>
    </section>
  );
}

/** A bulleted list in a policy section. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="grid list-disc gap-2 pl-5 marker:text-edge-strong">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A two-column table (what, and how long or what for), in a card. */
export function LegalTable({ head, rows }: { head: [string, string]; rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-card">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-edge text-xs font-semibold uppercase tracking-wider text-mute">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">{head[0]}</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">{head[1]}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-edge">
          {rows.map(([a, b], i) => (
            <tr key={i} className="align-top">
              <th scope="row" className="w-1/2 px-4 py-3 font-medium text-ink">{a}</th>
              <td className="px-4 py-3 text-mute">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Mail() {
  return (
    <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass}>
      {CONTACT_EMAIL}
    </a>
  );
}
