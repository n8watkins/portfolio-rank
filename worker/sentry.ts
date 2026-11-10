// Server error reporting to Sentry for the Worker, off unless the SENTRY_DSN
// var is set (wrangler.jsonc). Next's own server errors reach it through
// onRequestError in instrumentation.ts.
//
// Privacy: see lib/sentry-scrub.ts for the little that is sent.
import type { CloudflareOptions } from "@sentry/cloudflare";
import { scrubEvent } from "../lib/sentry-scrub";

export function sentryOptions(env: { SENTRY_DSN?: string; SITE_ENV?: string }): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    // "staging" on the staging site (wrangler.jsonc env.staging).
    environment: env.SITE_ENV === "staging" ? "staging" : "production",
    // Collect nothing about the visitor or the request beyond the page path.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      urlQueryParams: false,
      httpBodies: [],
      stackFrameVariables: false,
      databaseQueryData: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  };
}
