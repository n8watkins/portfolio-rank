# Domain setup checklist: portfoliorank.dev, n8builds.dev and Google

What still needs doing in Cloudflare, Kit and Google after PortfolioRank moved to portfoliorank.dev on 2026-11-13.
Tick items here as they're done.
Owner questions about any of this live in OPEN-QUESTIONS.md.

## Already done

- [x] portfoliorank.dev serves the site; portfoliorank.n8builds.dev and www forward with the same path (PR #163).
- [x] staging.portfoliorank.dev serves staging; the old staging host forwards.
- [x] Always Use HTTPS on portfoliorank.dev.
- [x] Turnstile widget lists portfoliorank.dev and staging.portfoliorank.dev.
- [x] Email forwarding: hello@ and privacy@portfoliorank.dev to the owner's Gmail.
- [x] Email forwarding on n8builds.dev: contact@, support@, nate@, updates@.
- [x] Security rules on portfoliorank.dev: block scanner probes, challenge nameless clients, block SEO-tool crawlers, flood rate limit that lets verified search bots pass.
- [x] GitHub sign-in works on both hosts.
- [x] GitHub repo homepage points to https://portfoliorank.dev; PROD_BASE_URL repo variable updated.

## Cloudflare: portfoliorank.dev

1. [ ] Web Analytics: Analytics & Logs > Web Analytics > Add a site > portfoliorank.dev > automatic setup.
   PortfolioRank has had no visitor stats since the move.
2. [ ] AI crawlers, search yes and training no: Security > Bots (or AI Crawl Control) > Block AI training bots on, Manage robots.txt on with content signals search=yes, ai-train=no.
   Leave AI search and assistant crawlers allowed.
3. [ ] DNSSEC: DNS > Settings > Enable DNSSEC.
   The domain is registered through Cloudflare, so the DS record is added automatically.
4. [ ] Email Sending (needed for the test email from portfoliorank.dev): Email > Email Sending > Onboard domain.
   It adds records under cf-bounce.portfoliorank.dev and _dmarc; the apex MX and SPF for forwarding stay as they are.
   Use DMARC `p=none; rua=mailto:<owner Gmail>; fo=1` like n8builds.dev, not `p=reject`.
5. [ ] Kit sending-domain records for the PortfolioRank Kit account: the CNAMEs Kit shows under Settings > Email > Verified Sending Domains, set to DNS only (grey cloud).
6. [ ] Google Search Console verification TXT record (step 10).

## Cloudflare: n8builds.dev

7. [ ] Always Use HTTPS: SSL/TLS > Edge Certificates > Always Use HTTPS on (it's off).
8. [ ] DNSSEC: DNS > Settings > Enable DNSSEC.
9. [ ] Kit sending-domain records for the n8builds Kit account.
   Send them to the ops session first: n8builds.dev already sends app email through Cloudflare Email Service, so check they don't clash.

## Google and Bing

10. [ ] Google Search Console: Add property > Domain > portfoliorank.dev, add its TXT record in Cloudflare (step 6), Verify, then Sitemaps > submit https://portfoliorank.dev/sitemap.xml.
    Optional: verify n8builds.dev as a Domain property too and use Change of address from the old PortfolioRank host.
11. [ ] Bing Webmaster Tools: Import from Google Search Console.

## Kit (both accounts)

12. [ ] PortfolioRank account: confirm sender hello@portfoliorank.dev (link in Gmail); verified sending domain portfoliorank.dev (step 5); one inline form with double opt-in. Skip "Custom domains" (that's for Kit-hosted pages).
13. [ ] n8builds account (login contact@n8builds.dev): sender "Nate from n8builds" <updates@n8builds.dev>, confirm it; verified sending domain n8builds.dev (step 9); one inline form with double opt-in; a bio.
14. [ ] Mailing address for both (legally required in every newsletter footer, shown publicly): a cheap virtual mailbox right before the first send, not the home address.

## Shortcut

Run `/mcp`, re-authenticate Cloudflare and grant Zone Settings, DNS, Bot Management, Web Analytics and Email Sending.
The ops session can then do steps 1 to 9 (the owner approves each change); Kit and Google clicks stay with the owner.

## After the checklist

- Send one test email from portfoliorank.dev to hello@portfoliorank.dev, then keep production sending from portfoliorank@n8builds.dev until the newsletters go live.
- Run the newsletter end-to-end tests on staging for both accounts, then leave both newsletters switched off on the admin pages.
