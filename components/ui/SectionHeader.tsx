import { ArrowRight } from "lucide-react";
import { eyebrow as eyebrowClass } from "@/components/ui/styles";

/** A page section's eyebrow, heading and optional "see all" link. */
export function SectionHeader({
  eyebrow,
  title,
  id,
  href,
  link,
  as: H = "h2",
  className = "mb-7",
}: {
  eyebrow?: string;
  title: string;
  /** The heading's id, for aria-labelledby on the section. */
  id?: string;
  href?: string;
  link?: string;
  as?: "h1" | "h2" | "h3";
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div>
        {eyebrow && <p className={eyebrowClass}>{eyebrow}</p>}
        <H id={id} className={`${eyebrow ? "mt-1.5 " : ""}text-2xl font-bold tracking-tight text-balance sm:text-3xl`}>
          {title}
        </H>
      </div>
      {href && link && (
        <a href={href} className="group inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-accent">
          {link} <ArrowRight className="nudge h-4 w-4" aria-hidden />
        </a>
      )}
    </div>
  );
}
