import { captureException } from "@sentry/core";
import type { Instrumentation } from "next";
import { errorSummary, logError, pathOf, safeCode } from "./lib/log";

// Errors thrown in pages, route handlers and the proxy: one JSON line with the
// route for Workers Logs, and a Sentry event when the Worker runs with a DSN
// (worker/sentry.ts; captureException is a no-op without one). The path drops its query string, which can carry
// codes or state.
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  logError({
    event: "unhandled_exception",
    reason: context.routeType,
    route: context.routePath,
    path: pathOf(request.path),
    method: request.method,
    status: 500,
    error: errorSummary(error),
    digest: safeCode((error as { digest?: unknown } | null)?.digest),
  });
  captureException(error, { tags: { route: context.routePath, route_type: context.routeType } });
};
