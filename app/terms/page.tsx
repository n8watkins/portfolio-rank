import type { Metadata } from "next";
import { Bullets, LegalPage, LegalSection, Mail, XLink, linkClass } from "@/components/legal/Legal";

// The terms of use, from docs/legal/terms.md (keep the two in step).
// Static: prerendered at build time.

export const metadata: Metadata = {
  title: "Terms - PortfolioRank",
  description: "The rules for using PortfolioRank: fair votes, no abuse, grades are opinions, and the site comes as is.",
  alternates: { canonical: "/terms" },
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      intro={
        <>
          <p>
            PortfolioRank is a free side project run by n8builds. By using the site you agree to these terms. They&apos;re short on purpose; the{" "}
            <a href="/privacy" className={linkClass}>
              privacy policy
            </a>{" "}
            says what&apos;s stored and why.
          </p>
        </>
      }
    >
      <LegalSection id="what" title="What the site is">
        <p>
          PortfolioRank ranks public developer portfolios from people&apos;s votes, an AI grade and automatic checks. It&apos;s free, has no paid plan, and can
          change or stop at any time.
        </p>
      </LegalSection>

      <LegalSection id="fair-play" title="Play fair">
        <Bullets
          items={[
            "Vote honestly: one person, one vote. Don't use several accounts, scripts or paid voters to move a site.",
            "Don't scrape the site in bulk, overload it, or get around its limits and bot checks.",
            "Only claim, hide or remove a portfolio that's yours.",
            "Don't put anything unlawful, hateful or someone else's private details in a list name or a claim note.",
          ]}
        />
        <p>I can remove votes, lists, claims or accounts that break these rules, and block whoever made them.</p>
      </LegalSection>

      <LegalSection id="checking" title="Checking a site">
        <p>
          Only check or grade sites that are public. Checking a site adds it to PortfolioRank; you can ask for removal at any time (see{" "}
          <a href="/removal" className={linkClass}>
            Remove or don&apos;t name me
          </a>
          ).
        </p>
      </LegalSection>

      <LegalSection id="opinions" title="Grades are opinions">
        <p>
          Grades, ranks and posts are opinions, from people&apos;s votes and an AI judge, measured against{" "}
          <a href="/grading" className={linkClass}>
            published criteria
          </a>
          . They are not a verdict on the developer, and they can be wrong. If something is wrong, tell me and I&apos;ll fix it.
        </p>
      </LegalSection>

      <LegalSection id="content" title="Whose content is whose">
        <p>
          Each portfolio, its screenshots and its text belong to its owner; PortfolioRank shows them to review and rank them. The site&apos;s own code is on{" "}
          <a href="https://github.com/n8watkins/portfolio-rank" className={linkClass}>
            GitHub
          </a>{" "}
          under its license. Lists you make are yours; making one public lets anyone with the link see it.
        </p>
      </LegalSection>

      <LegalSection id="as-is" title="No warranty">
        <p>
          The site comes as is, without any warranty. To the extent the law allows, I&apos;m not liable for any loss from using it, from a grade or rank, or from
          the site being down.
        </p>
      </LegalSection>

      <LegalSection id="age" title="Age">
        <p>PortfolioRank is not meant for anyone under 16.</p>
      </LegalSection>

      <LegalSection id="changes" title="Changes and law">
        <p>
          When these terms change, the date at the top changes too, and big changes get a note on the site. Governing law: California, United States.
          Questions: <Mail /> or <XLink />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
