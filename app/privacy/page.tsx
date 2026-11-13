import type { Metadata } from "next";
import { Bullets, LegalPage, LegalSection, LegalTable, Mail, linkClass } from "@/components/legal/Legal";

// The privacy policy, from docs/legal/privacy.md (keep the two in step).
// In Nathan's voice: plain, first person. Static: prerendered at build time.

export const metadata: Metadata = {
  title: "Privacy - PortfolioRank",
  description: "What PortfolioRank stores about you, why, who else sees it, how long it's kept, and how to download or delete it.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro={
        <>
          <p>
            PortfolioRank is a side project run by me, Nathan Watkins. This page says what the site stores about you, why, who else sees it, and how long
            it&apos;s kept.
          </p>
          <p>
            Short version: I store as little as I can, I never sell anything, and you can ask me to delete what&apos;s yours. Downloading your data, deleting
            your account and removing your portfolio are self-serve on the{" "}
            <a href="/settings" className={linkClass}>
              Settings
            </a>{" "}
            page. Questions: <Mail />.
          </p>
        </>
      }
    >
      <LegalSection id="browse" title="If you just browse">
        <Bullets
          items={[
            <>
              <strong>No account, no tracking cookies.</strong>
            </>,
            <>
              <strong>Page-view counts</strong> come from Cloudflare Web Analytics, which counts visits without cookies and without building a profile of you.
            </>,
            <>
              <strong>Error reports</strong> go to Sentry when a page breaks. They carry the error and the page&apos;s path, nothing else: no account, no
              cookies, no request headers, no query string.
            </>,
            <>
              <strong>Hosting logs.</strong> The site runs on Cloudflare, which sees your IP address and browser details to serve the page, as any host does. I
              don&apos;t store your IP address in PortfolioRank&apos;s database. Where the site limits how often a network can do something, it stores only a
              one-way hash of the address, never the address itself, and deletes those counters within a day.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="cookies" title="Cookies and browser storage">
        <p>
          There is no cookie banner because nothing here tracks you: every cookie is needed for something you asked for. The same list is on the{" "}
          <a href="/settings#privacy" className={linkClass}>
            Settings
          </a>{" "}
          page, which can also forget your saved preferences.
        </p>
        <Bullets
          items={[
            <>
              <strong>Sign-in session:</strong> keeps you signed in, only after you sign in with GitHub, plus two short-lived helpers used during sign-in.
            </>,
            <>
              <strong>Browser id:</strong> a random, signed id so a vote, poll answer or quiz counts once, set the first time you vote, play or grade.
            </>,
            <>
              <strong>Your reports:</strong> which grade reports this browser asked for, so only you see a report&apos;s owner tools.
            </>,
            <>
              <strong>Print pass:</strong> a one-hour pass to print a portfolio&apos;s report.
            </>,
            <>
              <strong>Face-off intro seen:</strong> so the how-to-play card doesn&apos;t show again.
            </>,
          ]}
        />
        <p>
          Saved only in your browser, never sent to the site: your theme (only if you pick Light or Dark), the auto-open setting, whether the face-off shows
          scores, and which reports already celebrated. A few notes last only while the tab is open, such as whether the sign-in reminder was shown, and, if you
          grade with your own Gemini key, that key until the grade is done.
        </p>
        <p>The bot check on some forms (Cloudflare Turnstile) sets no cookies on this site.</p>
      </LegalSection>

      <LegalSection id="practice-votes" title="If you vote without signing in">
        <p>
          You get a few practice votes before signing in. The site sets one cookie holding a random id, signed so it can&apos;t be forged. Your practice votes
          and the pairs you were shown are stored against that id, with the time. If you sign in afterwards, those votes can move to your account.
        </p>
      </LegalSection>

      <LegalSection id="github" title="If you sign in with GitHub">
        <p>
          GitHub tells PortfolioRank your GitHub id number, username, display name, email, avatar and the date your GitHub account was created.
        </p>
        <Bullets
          items={[
            <>
              Your <strong>session</strong> lives in a signed, encrypted cookie in your browser, not in my database.
            </>,
            <>
              What I <strong>store</strong> is keyed by your GitHub id number: your votes, your likes, your lists, and counters that limit how many pairs you
              can draw.
            </>,
            <>
              Your <strong>lists</strong> can be shared by link; a list marked public can be opened by anyone who has the link.
            </>,
            <>I don&apos;t store your GitHub email or display name in the database.</>,
            <>The account creation date is used only to tell whether a vote counts when a minimum account age is set.</>,
          ]}
        />
        <p>
          <strong>Votes are kept</strong> for as long as the site runs, because the leaderboard is computed from the full vote log. That goes for practice
          votes too: they&apos;re tied only to the random id in your cookie. If the comparison log is ever published, it will show which kind of voter cast each
          vote (a person or the AI), never who.
        </p>
      </LegalSection>

      <LegalSection id="listed" title="If your portfolio is listed">
        <p>
          PortfolioRank lists portfolios from the public community list{" "}
          <a href="https://github.com/emmabostian/developer-portfolios" className={linkClass}>
            emmabostian/developer-portfolios
          </a>
          , plus sites people submit. For each listed site I store:
        </p>
        <Bullets
          items={[
            "the name and address from the list;",
            "screenshots of the public page;",
            "up to 4,000 characters of the page's visible text;",
            "facts a script measures (links to a resume, GitHub or contact, whether project links load, own domain, footer year, whether it matches a known template);",
            "speed and accessibility scores from Google PageSpeed Insights;",
            "an AI grade from Google's Gemini (see below), and the site's rating and votes.",
          ]}
        />
        <p>
          If your site leaves the list, its screenshots and stored page data are deleted 30 days later. Its past votes stay in the vote log but are no longer
          shown. To take it off yourself, see{" "}
          <a href="#choices" className={linkClass}>
            Your choices
          </a>
          ; to stay listed but never be named in posts, see{" "}
          <a href="/removal" className={linkClass}>
            Remove or don&apos;t name me
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="claims" title="If you claim your portfolio">
        <Bullets
          items={[
            <>
              Claiming needs a GitHub sign-in. I store your GitHub id number and username with the portfolio&apos;s address, how the claim was verified, and a
              note if you write one.
            </>,
            <>
              To verify, the site fetches your portfolio&apos;s public home page (to find a link to your GitHub profile or the verification code) and your
              public GitHub profile (for your current username).
            </>,
            <>
              Every claim and owner action (removing the site, hiding its grade, asking for a re-grade) goes into an audit log with your GitHub id number and the
              time, so a removal can always be traced to whoever asked for it.
            </>,
            <>
              If you remove your portfolio, it disappears from the site 24 hours later (you can cancel until then, and I&apos;m told about it, so a removal by
              someone who isn&apos;t the owner can be stopped). Its address then goes on the public removals list in the site&apos;s repository, marked
              &ldquo;owner request&rdquo;, without your name; the{" "}
              <a href="/removed" className={linkClass}>
                removed portfolios
              </a>{" "}
              page only counts these.
            </>,
            <>
              If you ask for a report link by email, your address is used to send that one email and is not stored; only a one-way hash of it counts how many
              emails it got that day.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="polls" title="If you vote in a poll">
        <Bullets
          items={[
            "Each vote is stored with your account id (or the random id from your practice-vote cookie) and a signed browser id, so each person votes once.",
            "No page or API ever shows who voted for what; results are totals.",
            "Individual poll votes are deleted 30 days after the poll closes; the totals stay.",
          ]}
        />
      </LegalSection>

      <LegalSection id="games" title="If you play the games">
        <Bullets
          items={[
            "Your quiz answers are stored with your account id, or the random id from your practice-vote cookie, with the time and the percentiles they were scored against.",
            "Badges you earn are stored the same way, with what they need: how many times you shared a result, and which portfolios you opened (at most 50).",
            "\"Your eye\" (how often you agree with the crowd and the AI) is worked out from your own votes and answers; nobody else sees it.",
            "If you sign in afterwards, your quizzes and badges move to your account. Challenge links share the five portfolios of a quiz, never your answers.",
          ]}
        />
      </LegalSection>

      <LegalSection id="checking" title="If you check or grade a site">
        <p>Checking and grading a site are opening soon; this is how they work.</p>
        <p>
          <strong>Checking a site adds it to PortfolioRank; you can ask for removal at any time.</strong> A site that is already listed gets its results
          refreshed. Any other site waits, privately, to be graded: it&apos;s shown on PortfolioRank only once it&apos;s graded, and never if it turns out not
          to be a portfolio.
        </p>
        <Bullets
          items={[
            "I store the address you submit, its screenshots, page text, measured facts and the report.",
            "To stop abuse, I count requests per browser and per network. Both are stored only as one-way hashes, with the request.",
            "If you ask for the report by email, your address is used only to send it: it's erased as soon as the email goes out, or after 30 days if it never does. Report links in those emails stop working after 7 days.",
            "A grade request, its hashes, its report and its screenshots are deleted 180 days after the request.",
          ]}
        />
      </LegalSection>

      <LegalSection id="gemini" title="Google Gemini and the free tier">
        <p>
          PortfolioRank only works with portfolios their owners published for the public to see. It uses Google&apos;s Gemini API to grade them and to help
          write blog posts from the site&apos;s data.
        </p>
        <Bullets
          items={[
            "What goes to Gemini: screenshots and page text of portfolio sites, with email addresses and phone numbers swapped for placeholders first, the measured facts, and aggregate numbers from the site.",
            "What never goes to Gemini: anything about voters, accounts or the people who check a site.",
          ]}
        />
        <p>
          PortfolioRank uses Gemini&apos;s <strong>free tier</strong>. Under Google&apos;s terms for unpaid services, Google may use what is sent to improve
          its products, and human reviewers may read it. Only public web pages and aggregate data are sent, so I&apos;m comfortable with that, but you should
          know. If you grade with your own Gemini key, the request goes to Google under your key&apos;s terms instead.
        </p>
      </LegalSection>

      <LegalSection id="processors" title="Who else handles data">
        <LegalTable
          head={["Service", "What for"]}
          rows={[
            ["Cloudflare", "Hosting, the bot check, screenshot and backup storage (R2), page-view counts and sending email"],
            ["Turso", "The database (votes, likes, lists, grades)"],
            ["GitHub", "Sign-in, and the scheduled jobs that update the site"],
            ["Google", "Gemini (grades, writing) and PageSpeed Insights (speed scores)"],
            ["Sentry", "Error reports"],
          ]}
        />
        <p>None of them get your data to sell, and neither do I.</p>
      </LegalSection>

      <LegalSection id="retention" title="How long things are kept">
        <LegalTable
          head={["Data", "Kept"]}
          rows={[
            ["Votes, including practice votes", "As long as the site runs (the leaderboard is computed from them), or until you delete your account"],
            ["Individual poll votes", "30 days after the poll closes; the totals stay"],
            ["Likes and lists", "Until you delete them, or your account"],
            ["Quiz answers and badges", "Until you delete your account"],
            ["Claims and the claims audit log", "As long as the site runs; deleting your account removes your name from it"],
            ["Listed site data", "While listed, then deleted 30 days after it leaves the list"],
            ["Hashed network counters (rate limits)", "At most a day"],
            ["Grade requests, reports and their screenshots", "180 days after the request"],
            ["An email address for a report", "Until the email is sent, or 30 days if it never is"],
            ["Gemini request log (which job asked, when, tokens used; no visitor data)", "90 days, then only daily totals"],
            ["Nightly database backups", "35 days"],
          ]}
        />
        <p>
          The nightly backup is a copy of the database in private storage. Anything deleted from the database can stay in a backup until that backup
          expires, so every deletion on this page is complete within 35 days.
        </p>
      </LegalSection>

      <LegalSection id="choices" title="Your choices">
        <p>
          These are self-serve on the{" "}
          <a href="/settings" className={linkClass}>
            Settings
          </a>{" "}
          page and take effect at once.
        </p>
        <Bullets
          items={[
            <>
              <strong>Download my data:</strong> signed in, one click gives you a JSON file of everything stored against your account: votes, likes, lists,
              badges, quiz plays, poll votes, claims, the portfolio actions you took and the grades you asked for while signed in.
            </>,
            <>
              <strong>Delete my account:</strong> signed in, type your GitHub username to confirm. Your votes, likes, lists, badges, quiz plays, poll votes,
              claims and the grades you asked for while signed in are deleted together in one step, and you are signed out. The leaderboard drops your votes at
              its next recompute. Kept, because they name no one: anonymous counts, and a portfolio&apos;s own state, so a removal or a hidden grade you made
              stays in force with your account struck from the record of who made it.
            </>,
            <>
              <strong>Remove my portfolio:</strong> on the{" "}
              <a href="/claim" className={linkClass}>
                claim page
              </a>
              , prove the site is yours with a code you put on the page (or a claim I&apos;ve reviewed), then hide its grade or remove it. A removal takes
              effect a day later and can be cancelled until then. For a site that isn&apos;t listed yet, including one still waiting to be graded, email me
              (see{" "}
              <a href="/removal" className={linkClass}>
                Remove or don&apos;t name me
              </a>
              ).
            </>,
            <>
              <strong>Forget my preferences:</strong> clears what&apos;s saved in your browser.
            </>,
            <>Block cookies in your browser: you can still browse, but not vote or sign in.</>,
          ]}
        />
        <p>
          Anything else, including a request about data that isn&apos;t tied to an account: email <Mail />. I answer data requests within 30 days.
        </p>
        <p>PortfolioRank is not meant for anyone under 16.</p>
      </LegalSection>

      <LegalSection id="changes" title="Changes">
        <p>
          When this page changes, the date at the top changes too, and big changes get a note on the site. Governing law: California, United States.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
