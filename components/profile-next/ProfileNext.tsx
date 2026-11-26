import {
  Bookmark,
  Calendar,
  Check,
  ChevronDown,
  ClipboardCheck,
  Cookie,
  Copy,
  FileText,
  FolderCode,
  Heart,
  Image as ImageIcon,
  Info,
  List,
  Lock,
  Mail,
  Search,
  Share2,
  ShieldCheck,
  Smartphone,
  SquareArrowOutUpRight,
  TriangleAlert,
  WandSparkles,
  X,
} from "lucide-react";
import { LikeButton } from "@/components/LikeButton";
import { ShareButton } from "@/components/ShareButton";
import { AddToListButton } from "@/components/AddToListButton";
import { EloTierBadge } from "@/components/ui/badges";
import { GH_PATH, LI_PATH, SocialIcon, X_PATH } from "@/components/ui/social-icons";
import type { NextProfile } from "@/lib/profile-next/load";
import { SITE_URL } from "@/lib/site";
import { BASE_ELO } from "@/lib/elo";
import { FloatingBar } from "./FloatingBar";
import { PromptButton } from "./PromptButton";
import { Shots } from "./Shots";
import { TileLink } from "./TileLink";
import s from "./profile-next.module.css";

// The redesigned profile (app/p/[slug]/next): the owner's "Banner" pick from
// round 7 of the preview, built from what the product measures today. The
// hero (name, role, address, tier and votes, the actions, the screenshots),
// the bar it folds into, the report (overview tiles, then a card per kind of
// check, then "What we recommend changing") and "Claim it or share it".
// Nothing here depends on who is looking: Like and lists load in the browser.

const ROOT_ID = "pn-root";
const HERO_ID = "pn-hero";

type Report = NonNullable<NextProfile["report"]>;
type Card = Report["cards"][number];
type BasicsItem = { id: string; icon: string; label: string; chip: string; value: string; st: string; explain: string };
type Links = { ok: number; bad: number; headline: string; notes: string[]; rule: boolean; min: number };
type Row = { key: string; label: string; def: string; value: number; st: string };

const ST_CLASS: Record<string, string> = { yes: s.stYes, no: s.stNo, warn: s.stWarn, info: s.stInfo };
const ST_WORD: Record<string, string> = { yes: "Yes", no: "No", warn: "Needs work", info: "For information" };

function Status({ st }: { st: string }) {
  const Icon = st === "yes" ? Check : st === "no" ? X : st === "warn" ? TriangleAlert : Info;
  return (
    <span className={`${s.st} ${ST_CLASS[st] ?? s.stInfo}`} role="img" aria-label={ST_WORD[st] ?? ""}>
      <Icon aria-hidden />
    </span>
  );
}

const CARD_ICON: Record<string, typeof ClipboardCheck> = { basics: ClipboardCheck, projects: FolderCode, mobile: Smartphone };
const BASICS_ICON: Record<string, typeof Mail> = { resume: FileText, mail: Mail, image: ImageIcon, search: Search, lock: Lock, calendar: Calendar, cookie: Cookie };

const tint = (id: string) => s[`t-${id}`] ?? "";
const fixesWord = (n: number) => (n === 0 ? "Nothing to fix" : n === 1 ? "1 thing to fix" : `${n} things to fix`);

// ---------------------------------------------------------------- actions

function Actions({ d, where }: { d: NextProfile; where: "hero" | "bar" }) {
  const { p, socials } = d;
  const bar = where === "bar";
  const links = bar
    ? []
    : [
        socials.github && { href: socials.github, label: "GitHub", path: GH_PATH },
        socials.linkedin && { href: socials.linkedin, label: "LinkedIn", path: LI_PATH },
        // Two at most, so the actions stay on one line on a phone.
        !(socials.github && socials.linkedin) && socials.x && { href: socials.x, label: "X", path: X_PATH },
      ].filter((l): l is { href: string; label: string; path: string } => Boolean(l));
  return (
    <div className={`${s.acts} ${bar ? s.actsBar : s.actsHero}`} role="group" aria-label="Actions">
      {links.map((l) => (
        <a key={l.label} className={s.act} href={l.href} target="_blank" rel="noopener noreferrer" aria-label={l.label} title={l.label}>
          <SocialIcon path={l.path} className="h-[17px] w-[17px]" />
        </a>
      ))}
      {p.listed && (
        <>
          <LikeButton url={p.url} name={p.name} hydrate={!bar} buttonClassName={`${s.act} ${s.like}`}>
            <Heart aria-hidden />
          </LikeButton>
          <AddToListButton url={p.url} className={s.listWrap} buttonClassName={s.act} ariaLabel={`Bookmark ${p.name} in a list`}>
            <Bookmark aria-hidden />
          </AddToListButton>
          <ShareButton url={`${SITE_URL}${p.path}`} title={p.name} buttonClassName={s.act} ariaLabel="Share">
            <Share2 aria-hidden />
          </ShareButton>
        </>
      )}
      <a className={s.visit} href={p.visitUrl} target="_blank" rel="noopener" aria-label="Visit portfolio">
        <span className={s.u}>
          Visit<span className={s.vp}> portfolio</span>
        </span>
        <SquareArrowOutUpRight aria-hidden />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- the tier

function Tier({ d }: { d: NextProfile }) {
  const t = d.tier;
  // A site added through "Add your portfolio" and not in the face-offs: "?", as today's profile shows it.
  if (!t.inFaceoffs) {
    return (
      <div className={s.tierx}>
        <span className={s.tierQ} aria-hidden>
          ?
        </span>
        <div>
          <p className={s.tierK}>Rank</p>
          <p className={s.tierV}>Not ranked yet</p>
        </div>
        <span />
        <a className={s.tierInfo} href="/grading" aria-label="How ranking works" title="How ranking works">
          <Info aria-hidden />
        </a>
        <p className={s.tierP}>It joins the face-offs once it&apos;s graded.</p>
      </div>
    );
  }
  const votes = t.votes.toLocaleString("en-US");
  // With tiers shown (RANKING_V2) the letter, as designed; otherwise what today's profile shows: the ELO, printed
  // as it prints it, and its votes.
  const text = t.tier
    ? t.seeded
      ? "Started here from the code measurements; people's votes move it from here."
      : "Placed by people's votes in face-offs; they move it from here."
    : t.tiersShown
      ? `Not ranked yet, so no tier. Every site starts at an ELO of ${BASE_ELO}; it moves as people vote in face-offs.`
      : `Every site starts at an ELO of ${BASE_ELO}; it moves as people vote in face-offs.`;
  return (
    <div className={`${s.tierx} ${t.tier ? "" : s.tierElo}`}>
      {t.tier && <EloTierBadge tier={t.tier} size="hero" />}
      <div>
        <p className={s.tierK}>{t.tier ? "Tier" : "ELO"}</p>
        <p className={s.tierV}>{t.tier ? t.word : t.elo}</p>
      </div>
      <div className={s.tierVotes}>
        <b>{votes}</b>
        <span>{t.votes === 1 ? "vote so far" : "votes so far"}</span>
      </div>
      <a className={s.tierInfo} href="/grading" aria-label="How ranking works" title="How ranking works">
        <Info aria-hidden />
      </a>
      <p className={s.tierP}>{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------- report cards

function BasicsBody({ items }: { items: BasicsItem[] }) {
  return (
    <>
      <div className={s.chips}>
        {items.map((i) => {
          const Icon = BASICS_ICON[i.icon];
          return (
            <span key={i.id} className={s.chip}>
              {Icon ? <Icon aria-hidden /> : <SocialIcon path={GH_PATH} className="h-4 w-4" />}
              <span>{i.chip}</span>
              <Status st={i.st} />
            </span>
          );
        })}
      </div>
      <details className={s.explain}>
        <summary>
          <ChevronDown className={s.icS} aria-hidden />
          <span>Explain</span>
        </summary>
        <ul>
          {items.map((i) => (
            <li key={i.id}>
              <b>{i.label}:</b> {i.value}. {i.explain}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

function ProjectsBody({ links, builtWith, notice }: { links: Links | null; builtWith: string | null; notice: string | null }) {
  return (
    <>
      {links && (
        <>
          {/* The product's own words and counting (pipeline/facts.mjs projectLinksText), as today's profile reads them. */}
          <div className={s.linksHead}>
            {links.ok + links.bad > 0 && (
              <span className={s.sq} aria-hidden>
                {Array.from({ length: links.ok }, (_, i) => (
                  <i key={`o${i}`} className={s.ok}>
                    <Check />
                  </i>
                ))}
                {Array.from({ length: links.bad }, (_, i) => (
                  <i key={`b${i}`} className={s.bad}>
                    <X />
                  </i>
                ))}
              </span>
            )}
            <span className={s.linksN}>{links.headline}</span>
          </div>
          {links.notes.map((n) => (
            <p key={n} className={s.note}>
              {n}
            </p>
          ))}
          {notice && (
            <p className={s.note}>
              {notice}. It is not counted as a fix, because enough project links load.
            </p>
          )}
          {links.rule && <p className={s.note}>Read from the home page and its projects page. At least {links.min} project links that load is what counts.</p>}
        </>
      )}
      {builtWith && (
        <ul className={s.rows}>
          <li className={s.row}>
            <Status st="info" />
            <span className={s.rowK}>Built with</span>
            <span className={s.rowV}>{builtWith}</span>
          </li>
        </ul>
      )}
    </>
  );
}

function Gauge({ n, label }: { n: number; label: string }) {
  const size = 76;
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const col = n >= 90 ? "var(--color-up)" : n >= 50 ? "var(--warn)" : "var(--color-down)";
  return (
    <span className={s.gauge}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label} speed ${n} of 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-edge)" strokeWidth="6" />
        <circle className={s.arc} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${(c * n) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className={s.gaugeN} aria-hidden>
        {n}
      </span>
    </span>
  );
}

function LighthouseBody({ speed, rows, measuredOn, testUrl }: { speed: number; rows: Row[]; measuredOn: string | null; testUrl: string }) {
  return (
    <table className={s.pt}>
      <caption className={s.dvCap}>
        Speed and the scores under it are from Google Lighthouse, 0 to 100; 90 and up is good.{measuredOn ? ` One Lighthouse run on ${measuredOn}.` : " One Lighthouse run."}
      </caption>
      <thead>
        <tr>
          <th scope="col">
            <span className={s.dvK}>Speed</span>
          </th>
          <th scope="col" className={s.dvH}>
            <span className={s.ptH}>
              <Smartphone className={s.icS} aria-hidden />
              Mobile
            </span>
            <Gauge n={speed} label="Mobile" />
            <a className={s.dvRun} href={testUrl} target="_blank" rel="noopener noreferrer">
              Run this test{" "}
              <span className={s.nowrap}>
                yourself
                <SquareArrowOutUpRight aria-hidden />
              </span>
            </a>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">
              {r.label}
              <small>{r.def}</small>
            </th>
            <td>
              <Status st={r.st} />
              <span>{r.value}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The body for each kind of card (lib/profile-next/report.mjs CARD_BUILDERS). A new card adds its kind here. */
function CardBody({ card }: { card: Card }) {
  const data = card.data as Record<string, unknown>;
  if (card.kind === "basics") return <BasicsBody items={data.items as BasicsItem[]} />;
  if (card.kind === "projects") return <ProjectsBody links={data.links as Links | null} builtWith={data.builtWith as string | null} notice={card.notice ?? null} />;
  if (card.kind === "lighthouse") return <LighthouseBody speed={data.speed as number} rows={data.rows as Row[]} measuredOn={data.measuredOn as string | null} testUrl={data.testUrl as string} />;
  return null;
}

function ReportSection({ report, prompt }: { report: Report; prompt: string }) {
  const { cards, recommendations, checkedOn } = report;
  // Wide screens: two columns that end level, the Lighthouse card on its own beside the others (on
  // phones the columns drop away and the cards keep the tiles' order).
  const side = cards.filter((c) => c.kind === "lighthouse");
  const main = cards.filter((c) => c.kind !== "lighthouse");
  const columns =
    cards.length < 2 ? [cards] : side.length && main.length ? [main, side] : [cards.filter((_, i) => i % 2 === 0), cards.filter((_, i) => i % 2 === 1)];
  return (

    <section className={s.reportSec} aria-labelledby="pn-report">
      <div className={s.repHead}>
        <div>
          <p className={s.eyebrow}>Measured by code</p>
          <h2 className={s.h2} id="pn-report">
            The report
          </h2>
          <p className={s.sub}>{checkedOn ? `Checked on ${checkedOn}. No AI.` : "No AI."}</p>
        </div>
        {recommendations.length > 0 && (
          <PromptButton prompt={prompt} className={s.fixBtn}>
            <WandSparkles className={s.icS} aria-hidden />
            Copy a prompt to fix this
          </PromptButton>
        )}
      </div>
      <nav className={s.tiles} aria-label="The report's parts" style={{ "--n": Math.min(cards.length, 6) } as React.CSSProperties}>
        {cards.map((c) => {
          const Icon = CARD_ICON[c.id] ?? ClipboardCheck;
          return (
            <TileLink key={c.id} target={`pn-card-${c.id}`} className={`${s.tile} ${tint(c.id)}`}>
              <span className={s.tileIc}>
                <Icon aria-hidden />
              </span>
              <span className={s.tileN}>{c.name}</span>
              {/* "Nothing to fix" only when nothing is noted either: a note that is not a fix reads neutral. */}
              <span className={`${s.vd} ${c.fixes ? s.vdWarn : c.notice ? s.vdInfo : s.vdYes}`}>{c.fixes || !c.notice ? fixesWord(c.fixes) : c.notice}</span>
            </TileLink>
          );
        })}
      </nav>
      <div className={s.cards} data-cols={columns.length}>
        {columns.map((col, i) => (
          <div key={i} className={s.col}>
            {col.map((c) => {
              const Icon = CARD_ICON[c.id] ?? ClipboardCheck;
              return (
                <article key={c.id} id={`pn-card-${c.id}`} className={s.card} aria-labelledby={`pn-card-${c.id}-h`}>
                  <div className={`${s.th} ${tint(c.id)}`}>
                    <span className={s.thIc}>
                      <Icon aria-hidden />
                    </span>
                    <h3 className={s.thN} id={`pn-card-${c.id}-h`}>
                      {c.name}
                    </h3>
                  </div>
                  <div className={s.cardB}>
                    <CardBody card={c} />
                  </div>
                </article>
              );
            })}
          </div>
        ))}
      </div>
      {recommendations.length > 0 && (
        <section className={s.recs} aria-labelledby="pn-recs">
          <div className={s.th}>
            <span className={s.thIc}>
              <List aria-hidden />
            </span>
            <h3 className={s.thN} id="pn-recs">
              What we recommend changing
            </h3>
          </div>
          <div className={s.recsB}>
            <ol className={s.recsList}>
              {recommendations.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
            <div className={s.recsActs}>
              <span className={s.recsNote}>The same list, ready to paste into your AI coding tool.</span>
              <PromptButton prompt={prompt} className={s.doneBtn}>
                <Copy className={s.icS} aria-hidden />
                Copy as a prompt
              </PromptButton>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the page

export function ProfileNext({ d, cardImage }: { d: NextProfile; cardImage: string }) {
  const { p, tier, shots, report } = d;
  const role = p.tagline;
  return (
    <div id={ROOT_ID} className={s.root}>
      <FloatingBar rootId={ROOT_ID} heroId={HERO_ID}>
        <span className={s.pbarThumb} style={{ backgroundImage: `url("${shots.thumb}")` }} />
        <span className={s.pbarN}>
          <span className={s.pbarR1}>
            {tier.tier && <EloTierBadge tier={tier.tier} size="xs" />}
            <b>{p.name}</b>
          </span>
          <small>{role ? `${role} · ${p.domain}` : p.domain}</small>
        </span>
        <Actions d={d} where="bar" />
      </FloatingBar>
      <div className={s.prof}>
        <section className={s.hero} id={HERO_ID} aria-labelledby="pn-name">
          <div className={s.heroBg} aria-hidden style={{ backgroundImage: `url("${shots.thumb}")` }} />
          <div className={s.heroId}>
            <h1 className={s.name} id="pn-name">
              {p.name}
            </h1>
            {role && <p className={s.role}>{role}</p>}
            <a className={s.addr} href={p.visitUrl} target="_blank" rel="noopener" title={p.domain}>
              <span>{p.domain}</span>
              <SquareArrowOutUpRight className={s.icS} aria-hidden />
            </a>
            <Tier d={d} />
            <Actions d={d} where="hero" />
          </div>
          <div className={s.heroShot}>
            <Shots desktop={shots.desktop} phone={shots.phone} domain={p.domain} url={p.url} />
          </div>
        </section>

        {report && report.cards.length > 0 ? (
          <ReportSection report={report} prompt={report.prompt} />
        ) : (
          <p className={s.hidden}>{p.hideGrade ? "The owner of this portfolio chose to hide its report." : "No measurements of this site are saved yet. They are taken when the site is captured."}</p>
        )}

        {/* Share posts the current profile's address, whose share image is not this card yet. When this page
            becomes the profile and this card its share image, the caption goes back to "What people see when
            the link is posted." and the text gains "Share it and this card goes with the link." */}
        <section className={s.cta} aria-labelledby="pn-cta">
          <figure className={s.ctaPic}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the card is our own generated PNG */}
            <img src={cardImage} width={1200} height={630} alt={`A card for ${p.name}${tier.tier ? `: tier ${tier.letter}, ${tier.word}` : ""}, with a picture of the site`} loading="lazy" />
            <figcaption className={s.ctaCap}>{p.name} on PortfolioRank.</figcaption>
          </figure>
          <div className={s.ctaT}>
            <h2 className={s.ctaH} id="pn-cta">
              Is this your portfolio? Claim it or share it
            </h2>
            <p className={s.ctaP}>{d.claim.can}</p>
            <div className={s.ctaActs}>
              <a className={s.ctaClaim} href={`/claim?url=${encodeURIComponent(p.url)}`}>
                <ShieldCheck aria-hidden />
                Claim
              </a>
              <ShareButton url={`${SITE_URL}${p.path}`} title={p.name} buttonClassName={s.ctaShare}>
                <Share2 aria-hidden />
                Share
              </ShareButton>
            </div>
            <p className={s.ctaSteps}>{d.claim.steps}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
