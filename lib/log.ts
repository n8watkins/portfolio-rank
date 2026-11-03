// One JSON line per failure, so Workers Logs indexes each field and
// `wrangler tail` shows it on one line. Never put secrets, tokens, OAuth codes
// or state values, cookies, emails or other personal data in these fields.
export type LogFields = {
  event: string;
  reason: string;
  route: string;
  status?: number;
  [key: string]: string | number | boolean | undefined;
};

export function logWarn(fields: LogFields): void {
  console.warn(JSON.stringify(fields));
}

export function logError(fields: LogFields): void {
  console.error(JSON.stringify(fields));
}

/** A short machine code (`access_denied`, `invalid_signature`), or undefined.
 *  Only [a-zA-Z0-9_.-] survives, so a description or token can never ride along. */
export function safeCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.slice(0, 64).replace(/[^a-zA-Z0-9_.-]/g, "");
  return code || undefined;
}

/**
 * An error message made safe to log: database errors quote their parameters
 * ("params: ..."), and some messages echo emails or tokens, so those are cut
 * or masked, and the result is kept short.
 */
export function safeMessage(message: unknown): string {
  return String(message ?? "")
    .replace(/\.?\s*Read more at https:\/\/errors\.authjs\.dev\S*/g, "")
    .replace(/\bparams:[\s\S]*$/i, "params: [redacted]")
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, "[email]")
    .replace(/[A-Za-z0-9_\-.+/=]{24,}/g, "[redacted]")
    .slice(0, 200);
}

/** An error's class and safe message, for unexpected failures. */
export function errorSummary(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${safeMessage(err.message)}`;
  return safeMessage(err);
}

/** A request's path without its query string, which can carry codes or state. */
export function pathOf(url: string): string {
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

type AuthJsError = Error & { type?: unknown; kind?: unknown; cause?: unknown };

/**
 * Auth.js's `logger` option. Auth.js hands `error` an AuthError whose `cause`
 * can hold the OAuth callback's query (code and state), provider responses and
 * the underlying error, so only the error type, a masked message, the
 * provider's id, the OAuth `error` code and the inner error's class are kept.
 * `debug` stays off (it prints cookies and state), and `warn` gets a fixed code.
 */
export const authLogger = {
  error(error: AuthJsError) {
    const cause = (typeof error.cause === "object" && error.cause !== null ? error.cause : {}) as Record<string, unknown>;
    const inner = cause.err instanceof Error ? cause.err : undefined;
    logError({
      event: "auth_error",
      reason: safeCode(error.type) ?? safeCode(error.name) ?? "AuthError",
      route: "/api/auth",
      message: safeMessage(error.message),
      provider: safeCode(cause.providerId) ?? safeCode(cause.provider),
      providerError: safeCode(cause.error),
      cause: inner ? safeCode(inner.name) : undefined,
    });
  },
  warn(code: string) {
    logWarn({ event: "auth_warning", reason: safeCode(code) ?? "unknown", route: "/api/auth" });
  },
  debug() {},
};
