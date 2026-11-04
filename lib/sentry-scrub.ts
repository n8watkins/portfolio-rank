// What PortfolioRank sends to Sentry, for the browser (error-reporting.ts) and the
// Worker (worker/sentry.ts): the error, masked the way the logs mask it
// (safeMessage), and the page path. No user, request body, cookies, headers or
// query string, and no console output.
import type { Breadcrumb, ErrorEvent } from "@sentry/core";
import { safeMessage } from "./log";

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.user;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = withoutQuery(event.request.url);
  }
  if (event.message) event.message = safeMessage(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = safeMessage(exception.value);
  }
  return event;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  if (breadcrumb.category === "console") return null;
  const data = breadcrumb.data;
  if (data) {
    for (const key of ["url", "from", "to"] as const) {
      if (typeof data[key] === "string") data[key] = withoutQuery(data[key]);
    }
  }
  return breadcrumb;
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/)[0] ?? "";
}
