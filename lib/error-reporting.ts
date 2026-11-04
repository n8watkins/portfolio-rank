// Browser error reporting to Sentry, off unless NEXT_PUBLIC_SENTRY_DSN is set
// at build time (only the deploy workflow sets it, so local, CI and test builds
// send nothing). The SDK is a separate chunk loaded on the first error, so a
// page that never fails never downloads it.
//
// Privacy: see sentry-scrub.ts for the little that is sent.
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

type SentryModule = typeof import("@sentry/browser");
let sdk: Promise<SentryModule | null> | null = null;

function load(): Promise<SentryModule | null> {
  sdk ??= import("@sentry/browser")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
        environment: "production",
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
        // The window listeners below already report uncaught errors.
        integrations: (defaults) => defaults.filter((integration) => integration.name !== "GlobalHandlers"),
        ignoreErrors: ["ResizeObserver loop", "AbortError", "Load failed", "Failed to fetch", "NetworkError"],
        denyUrls: [/^(chrome|moz|safari)-extension:\/\//, /^chrome:\/\//],
        beforeSend: scrubEvent,
        beforeBreadcrumb: scrubBreadcrumb,
      });
      return Sentry;
    })
    .catch(() => null); // Offline or blocked: the app works the same without it.
  return sdk;
}

/** Reports an error to Sentry; a no-op without a DSN. */
export function reportError(error: unknown): void {
  if (!dsn) return;
  void load().then((Sentry) => Sentry?.captureException(error));
}

/** Reports uncaught errors and unhandled promise rejections. */
export function installErrorReporting(): void {
  if (!dsn || typeof window === "undefined") return;
  window.addEventListener("error", (event) => reportError(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportError(event.reason));
}
