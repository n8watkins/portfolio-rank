import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { btnPrimary } from "@/components/ui/styles";
import { SITE_URL } from "@/lib/site";

// The strict Markdown renderer for posts (owner decision 4: Markdown bodies,
// no raw HTML). It knows only what the engine writes (pipeline/content/
// writer.mjs assembleBody): "### " subheads, paragraphs with one sentence a
// line, "> " blocks (the TL;DR and the key-number callout), numbered and
// bulleted lists, [[image:slot]] markers, and inline **bold**, `code` and
// [links](https://...). Everything else is plain text: the output is React
// elements, never an HTML string, so nothing in a post can inject markup.

export type Block =
  | { type: "heading"; text: string }
  | { type: "para"; text: string }
  | { type: "cta"; label: string; href: string }
  | { type: "tldr"; items: string[] }
  | { type: "callout"; lead: string; rest: string[] }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "image"; slot: string };

/** The body as blocks. Pure, so the tests can check it. */
export function parseBlocks(body: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) {
      const text = para.join(" ");
      const cta = text.match(/^\*\*(.+?)\*\*\s*(?:->|→)\s*(https?:\/\/\S+)$/);
      out.push(cta ? { type: "cta", label: cta[1], href: cta[2] } : { type: "para", text });
    }
    para = [];
    if (list) out.push({ type: "list", ...list });
    list = null;
    if (quote.length) {
      const [first, ...rest] = quote;
      if (/^\*\*TL;DR\*\*$/i.test(first.trim())) out.push({ type: "tldr", items: rest.map((l) => l.replace(/^-\s*/, "")).filter(Boolean) });
      else out.push({ type: "callout", lead: first.replace(/^\*\*(.*)\*\*$/, "$1"), rest });
    }
    quote = [];
  };
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.trimEnd();
    const image = line.trim().match(/^\[\[image:([a-z0-9-]+)\]\]$/);
    const item = line.match(/^(\d+\.|[-*])\s+(.*)$/);
    if (image) {
      flush();
      out.push({ type: "image", slot: image[1] });
    } else if (/^#{2,4} /.test(line)) {
      flush();
      out.push({ type: "heading", text: line.replace(/^#+ /, "") });
    } else if (line.startsWith(">")) {
      if (para.length || list) flush();
      const text = line.replace(/^>\s?/, "").trim();
      if (text) quote.push(text);
    } else if (item) {
      const ordered = /\d/.test(item[1]);
      if (para.length || quote.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(item[2]);
    } else if (!line.trim()) flush();
    else {
      if (list || quote.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

/** Where a link goes: our own pages as paths, anything else as it is. */
export function linkHref(url: string): string {
  return url.startsWith(SITE_URL) ? url.slice(SITE_URL.length) || "/" : url;
}

const external = (href: string) => /^https?:/.test(href);

/** Inline marks: **bold**, `code`, [text](https://...) and bare https addresses. */
export function Inline({ text, sources = [] }: { text: string; sources?: string[] }) {
  const parts: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+[^\s).,;:!?])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] !== undefined) parts.push(<strong key={k++} className="font-semibold text-ink">{m[1]}</strong>);
    else if (m[2] !== undefined) parts.push(<code key={k++} className="rounded bg-raised px-1 py-0.5 text-[0.9em]">{m[2]}</code>);
    else {
      const url = m[4] ?? m[5];
      const label = m[3] ?? url;
      const n = sources.indexOf(url);
      if (m[3] !== undefined && /^source$/i.test(label) && n >= 0) {
        // The engine's "([source](url))" after a checked outside claim: a numbered citation.
        parts.push(
          <a key={k++} href={`#source-${n + 1}`} className="text-accent no-underline hover:underline" aria-label={`Source ${n + 1}`}>
            {n + 1}
          </a>
        );
      } else {
        const href = linkHref(url);
        parts.push(
          <a
            key={k++}
            href={href}
            className="font-medium text-ink underline decoration-accent/50 decoration-2 underline-offset-[3px] transition hover:decoration-accent"
            {...(external(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {label}
          </a>
        );
      }
    }
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** A post body. `figure(slot)` renders an image slot (or null when the slot has no image). */
export function Markdown({ body, figure, sources = [] }: { body: string; figure: (slot: string) => ReactNode; sources?: string[] }) {
  const blocks = parseBlocks(body);
  return (
    <div className="article-body">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading":
            return (
              <h2 key={i} className="mt-11 text-[1.45rem] font-bold leading-tight tracking-tight text-balance sm:text-2xl">
                <Inline text={b.text} />
              </h2>
            );
          case "para":
            return (
              <p key={i} className="mt-5 text-pretty">
                <Inline text={b.text} sources={sources} />
              </p>
            );
          case "cta":
            return (
              <p key={i} className="mt-9">
                <a href={linkHref(b.href)} className={btnPrimary}>
                  {b.label} <ArrowRight className="nudge h-4 w-4" aria-hidden />
                </a>
              </p>
            );
          case "tldr":
            return (
              <aside key={i} aria-label="TL;DR" className="card mt-2 p-5 sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">TL;DR</p>
                <ul className="mt-3 grid gap-2.5 text-[15px] leading-relaxed sm:text-base">
                  {b.items.map((item, j) => (
                    <li key={j} className="flex gap-3">
                      <span aria-hidden className="mt-[0.6em] h-1.5 w-1.5 shrink-0 rounded-full bg-fill" />
                      <span>
                        <Inline text={item} sources={sources} />
                      </span>
                    </li>
                  ))}
                </ul>
              </aside>
            );
          case "callout":
            return (
              <aside key={i} className="my-9 border-l-[3px] border-accent py-1 pl-5">
                <p className={`font-bold tracking-tight text-ink ${b.lead.length <= 12 ? "text-4xl tabular-nums sm:text-5xl" : "text-xl sm:text-2xl"}`}>{b.lead}</p>
                {b.rest.map((r, j) => (
                  <p key={j} className="mt-2 text-[15px] text-mute">
                    <Inline text={r} sources={sources} />
                  </p>
                ))}
              </aside>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i} className={`mt-5 grid gap-2.5 pl-6 ${b.ordered ? "list-decimal marker:font-semibold marker:text-accent" : "list-disc marker:text-accent"}`}>
                {b.items.map((item, j) => (
                  <li key={j} className="pl-1.5">
                    <Inline text={item} sources={sources} />
                  </li>
                ))}
              </L>
            );
          }
          case "image":
            return <div key={i}>{figure(b.slot)}</div>;
        }
      })}
    </div>
  );
}
