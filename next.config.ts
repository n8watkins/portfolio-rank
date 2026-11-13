import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import { parseJsonc } from "./scripts/check-worker-exports.mjs";

// The launch switches are Worker variables, but pages prerendered at build
// time (the home page, /top and its views, the sitemap: ISR) read them too,
// so the build must see the values the Worker will run with: the variable
// when the build environment sets it (the test runs), else wrangler.jsonc's
// value for the Worker being built (staging or production). Flipping one in
// wrangler.jsonc ships with a deploy, which rebuilds.
function launchSwitch(name: "GRADER_ENABLED" | "GAMES_V2" | "RANKING_V2" | "TOOLS_ENABLED" | "EMAIL_SIGNIN_ENABLED" | "NEWSLETTER_ENABLED"): "true" | "false" {
  if (process.env[name] !== undefined) return /^true$/i.test(String(process.env[name])) ? "true" : "false";
  try {
    const config = parseJsonc(readFileSync("wrangler.jsonc", "utf8"));
    const vars = process.env.NEXT_PUBLIC_SITE_ENV === "staging" ? config.env?.staging?.vars : config.vars;
    return /^true$/i.test(String(vars?.[name] ?? "")) ? "true" : "false";
  } catch {
    return "false";
  }
}
// GAMES_V2, RANKING_V2 and TOOLS_ENABLED are read on the server (lib/games/server.ts,
// lib/leaderboard.ts, lib/home.ts, lib/tools/server.ts), from process.env: setting them here
// reaches the build's prerender, and the Worker sets the same values at run
// time. "Grade my portfolio" is also read in the browser (lib/nav.ts
// ROUTES.grade), so it is inlined as NEXT_PUBLIC_GRADER_ENABLED below, and
// so are the free tools (ROUTES.tools, NEXT_PUBLIC_TOOLS_ENABLED).
for (const name of ["GAMES_V2", "RANKING_V2", "TOOLS_ENABLED"] as const) process.env[name] = launchSwitch(name);

// Defense-in-depth response headers applied to every route: HSTS (the site is
// HTTPS-only), clickjacking, MIME sniffing, referrer leakage, and a
// baseline CSP. The CSP is deliberately permissive on images (we embed remote
// screenshots/og-images and mShots) but locks scripts to same-origin.
const securityHeaders = [
  // A year of HTTPS-only, for this host and anything under it. Not preloaded:
  // that is a separate, hard-to-undo decision for the n8builds.dev zone.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Cloudflare Web Analytics: the zone injects its beacon, which reports to
      // cloudflareinsights.com. Browser errors go to Sentry's ingest host.
      // Turnstile (components/ui/Turnstile.tsx) is a script plus an iframe
      // from challenges.cloudflare.com. React's dev build needs eval for its
      // debugging tools; production never gets it.
      //
      // 'unsafe-inline' stays for script elements: the App Router writes its
      // data into inline <script> tags on every page, and a nonce would need
      // every page rendered per request, which ends the prerendered and
      // edge-cached pages (worker/edge-cache.ts). What inline scripts can do
      // is narrowed instead: no inline event handler attributes
      // (script-src-attr 'none', the usual way an injected tag runs code) and
      // no plugins (object-src 'none'); base-uri and form-action stay 'self'.
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} https://static.cloudflareinsights.com https://challenges.cloudflare.com`,
      "script-src-attr 'none'",
      "object-src 'none'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://cloudflareinsights.com https://o4507767562371072.ingest.us.sentry.io",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // `next dev` would otherwise append its own block to AGENTS.md on every
  // start, leaving a change in the working tree; AGENTS.md is ours.
  agentRules: false,
  // Browser source maps only for the deploy that uploads them to Sentry; the
  // deploy deletes them before publishing, so they're never public.
  productionBrowserSourceMaps: process.env.SENTRY_UPLOAD_SOURCEMAPS === "1",
  env: {
    NEXT_PUBLIC_GRADER_ENABLED: launchSwitch("GRADER_ENABLED"),
    NEXT_PUBLIC_TOOLS_ENABLED: launchSwitch("TOOLS_ENABLED"),
    // Email sign-in (lib/signin/flag.ts): the option in the sign-in dialog and its routes.
    NEXT_PUBLIC_EMAIL_SIGNIN_ENABLED: launchSwitch("EMAIL_SIGNIN_ENABLED"),
    // The newsletter's sign-up forms (components/newsletter/useNewsletterOn.ts) ask for its status only when on.
    NEXT_PUBLIC_NEWSLETTER_ENABLED: launchSwitch("NEWSLETTER_ENABLED"),
  },
  async headers() {
    // Grade reports are unlisted (shareable by link only) and claims are
    // personal: never indexed, whatever a page's own metadata says.
    const noindex = [{ key: "X-Robots-Tag", value: "noindex, nofollow" }];
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/grade/:path+", headers: noindex },
      { source: "/claim", headers: noindex },
    ];
  },
  // The face-off moved into Play; old links and bookmarks still land on it.
  async redirects() {
    return [
      { source: "/rank", destination: "/play", permanent: true },
      // The free tools' pages became "Add your portfolio" (owner, 2026-11-12).
      ...(launchSwitch("TOOLS_ENABLED") === "true"
        ? [
            { source: "/tools", destination: "/add", permanent: false },
            { source: "/tools/:path*", destination: "/add", permanent: false },
          ]
        : []),
    ];
  },
};

export default nextConfig;

// Gives `next dev` the Worker's bindings (the SHOTS bucket) through wrangler.
// Only in dev: `next build` needs no bindings.
if (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();
