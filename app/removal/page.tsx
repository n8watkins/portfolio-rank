import type { Metadata } from "next";
import { SITE } from "@/lib/site";
import { Bullets, LegalPage, LegalSection, Mail, linkClass } from "@/components/legal/Legal";

// How to leave PortfolioRank or stay out of its posts, from
// docs/legal/removal.md (keep the two in step). Static: prerendered.

export const metadata: Metadata = {
  title: "Remove or don't name me - PortfolioRank",
  description: "How to take your portfolio off PortfolioRank, keep it listed but never named in posts, or fix your listing. Any site, any time, no reason needed.",
  alternates: { canonical: "/removal" },
};

export default function RemovalPage() {
  return (
    <LegalPage
      title="Remove or don't name me"
      intro={
        <>
          <p>
            PortfolioRank lists real people&apos;s portfolios, ranks them, and writes about what it finds. If you&apos;re one of them, you decide how much of
            that you want. No reason needed.
          </p>
          <p>
            <strong className="font-semibold text-ink">Checking a site adds it to PortfolioRank; you can ask for removal at any time</strong>, including while
            it&apos;s still waiting to be graded.
          </p>
        </>
      }
    >
      <LegalSection id="options" title="Three things you can ask for">
        <ol className="grid list-decimal gap-3 pl-5 marker:font-semibold marker:text-ink">
          <li>
            <strong>Remove me.</strong> Your site leaves PortfolioRank: the grid, face-offs, the leaderboard, the blog and its profile page. It is never added
            back, even if it&apos;s still on the community list.
          </li>
          <li>
            <strong>Don&apos;t name me.</strong> Your site stays listed and ranked, but posts never name you, link you or show your screenshot. You still show
            up in totals (&ldquo;1 of 2,103 sites&rdquo;).
          </li>
          <li>
            <strong>Fix my listing.</strong> A new address, a new name, or a fresh screenshot and grade after a redesign.
          </li>
        </ol>
      </LegalSection>

      <LegalSection id="self-serve" title="Do it yourself, for a listed site">
        <p>
          Sign in with GitHub and open the{" "}
          <a href="/claim" className={linkClass}>
            claim page
          </a>
          . Prove the site is yours with a short code you add to the page (a github.io site can use the GitHub account it belongs to). Then:
        </p>
        <Bullets
          items={[
            "Hide its grade: takes effect at once, and you can show it again.",
            "Remove it: takes effect 24 hours later. You can cancel until then, and I'm told about it, so a removal by someone who isn't the owner can be stopped.",
            "A link from the site to your GitHub profile is enough to claim it, but hiding or removing needs the code, or a claim I've reviewed.",
          ]}
        />
      </LegalSection>

      <LegalSection id="ask" title="Ask me, for any site">
        <p>Use this for a site that isn&apos;t listed yet (for example one still waiting to be graded), for &ldquo;don&apos;t name me&rdquo;, or if you&apos;d rather not sign in.</p>
        <Bullets
          items={[
            <>
              <strong>Private:</strong> email <Mail /> with your site&apos;s address and which of the three you want.
            </>,
            <>
              <strong>Public:</strong> open a{" "}
              <a href={SITE.remove} className={linkClass}>
                &ldquo;Remove my portfolio&rdquo; issue
              </a>{" "}
              on GitHub. Issues are public, so anyone can see the request.
            </>,
          ]}
        />
        <p>
          For &ldquo;remove me&rdquo; and &ldquo;fix my listing&rdquo;, I check the request comes from the site&apos;s owner, for example from an email on
          the site&apos;s domain or the GitHub account the site links to, so nobody can take someone else&apos;s site down. &ldquo;Don&apos;t name me&rdquo;
          only takes something away, so it needs no proof.
        </p>
      </LegalSection>

      <LegalSection id="when" title="What happens, and when">
        <Bullets
          items={[
            "I act on emailed and GitHub requests within 14 days.",
            <>
              <strong>Remove me:</strong> the site goes on PortfolioRank&apos;s exclusion list and disappears everywhere on the site. Its screenshots and stored
              page data are deleted 30 days later, and the last backup holding them expires 35 days after that. Past votes stay in the vote log the leaderboard
              is computed from, but your site is no longer shown anywhere. They&apos;re anonymous: a vote says which two sites were compared, never anything
              about the site&apos;s owner.
            </>,
            <>
              <strong>Don&apos;t name me:</strong> your site goes on my do-not-name list. I read every post before it&apos;s published, and a draft that names
              you doesn&apos;t go out.
            </>,
            "Already published: any post that names you is edited to remove your name, link and screenshot within the same 14 days.",
            <>
              The{" "}
              <a href="/removed" className={linkClass}>
                removed portfolios
              </a>{" "}
              page counts owner requests but never says whose they were.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="writing" title="How people are written about anyway">
        <p>
          Even without a request, PortfolioRank names individual developers only for good reasons: top sites, big climbers, redesigns that paid off. Low scores
          and anything critical are only ever discussed in aggregate, and a post that breaks this rule is dropped before it&apos;s published. Details:{" "}
          <a href="/about-posts" className={linkClass}>
            How posts are made
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="community-list" title="The community list">
        <p>
          PortfolioRank&apos;s list comes from{" "}
          <a href="https://github.com/emmabostian/developer-portfolios" className={linkClass}>
            emmabostian/developer-portfolios
          </a>
          . Removing yourself from PortfolioRank doesn&apos;t remove you from that list; to leave it too, open a pull request or issue there.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
