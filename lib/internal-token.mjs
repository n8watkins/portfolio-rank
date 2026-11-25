// A token the Worker's scheduled work sends to the app's internal routes
// (app/api/internal/*), so only the Worker itself can call them: an HMAC of
// the purpose with AUTH_SECRET, which both sides have. Web Crypto only, so it
// runs in the Worker and in Node alike.

/** Hex HMAC-SHA256 of `purpose` with `secret`. */
export async function internalToken(secret, purpose) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(purpose)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The header the token travels in. */
export const INTERNAL_TOKEN_HEADER = "x-portfoliorank-internal";

/** The purpose of the profile revalidation route (app/api/internal/revalidate-profiles). */
export const REVALIDATE_PROFILES = "revalidate-profiles";
