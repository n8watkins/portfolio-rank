import type { ToolId } from "@/lib/tools/catalog";
import { eyebrow } from "@/components/ui/styles";
import { PortfolioCheck } from "@/components/tools/PortfolioCheck";

const d = (ms: number) => ({ "--d": `${ms}ms` }) as React.CSSProperties;

/** The top of every tools page: eyebrow, title, one line, and the check itself. */
export function ToolsHero({
  kicker,
  title,
  lead,
  tools,
  initialUrl,
  cta,
}: {
  kicker: string;
  title: React.ReactNode;
  lead: string;
  tools: ToolId[];
  initialUrl: string;
  cta?: string;
}) {
  return (
    <div className="band band-glow">
      <section aria-labelledby="tools-title" className="mx-auto max-w-3xl px-4 pb-10 pt-14 text-center sm:px-6 sm:pt-20">
        <p className={`rise ${eyebrow}`}>{kicker}</p>
        <h1 id="tools-title" className="rise mt-3 text-4xl font-bold tracking-tight text-balance sm:text-5xl" style={d(40)}>
          {title}
        </h1>
        <p className="rise mx-auto mt-5 max-w-xl text-[15px] text-mute text-pretty sm:text-lg" style={d(80)}>
          {lead}
        </p>
        <div className="rise mt-8 text-left" style={d(120)}>
          <PortfolioCheck tools={tools} initialUrl={initialUrl} cta={cta} />
        </div>
      </section>
    </div>
  );
}

/** The amber words of a tools page's title. */
export function Glow({ children }: { children: React.ReactNode }) {
  return <span className="bg-gradient-to-r from-[#fcd34d] via-[#f59e0b] to-[#ea7a0c] bg-clip-text text-transparent">{children}</span>;
}
