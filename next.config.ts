import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Defense-in-depth response headers applied to every route. HSTS is not set
// here (nor by the Cloudflare zone today); these cover clickjacking, MIME sniffing, referrer leakage, and a
// baseline CSP. The CSP is deliberately permissive on images (we embed remote
// screenshots/og-images and mShots) but locks scripts to same-origin.
const securityHeaders = [
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
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

// Gives `next dev` the Worker's bindings (the SHOTS bucket) through wrangler.
// Only in dev: `next build` needs no bindings.
if (process.env.NODE_ENV === "development") initOpenNextCloudflareForDev();
