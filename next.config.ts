import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

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
      "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://cloudflareinsights.com https://o4507767562371072.ingest.us.sentry.io",
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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

// Gives `next dev` the Worker's bindings (the SHOTS bucket) through wrangler.
// Only in dev: `next build` needs no bindings.
if (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();
