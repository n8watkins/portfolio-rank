// Email sign-in's launch switch (decision D3): EMAIL_SIGNIN_ENABLED in
// wrangler.jsonc, off in production and on in staging. next.config.ts inlines
// it as NEXT_PUBLIC_EMAIL_SIGNIN_ENABLED at build time, so the server and the
// browser agree. While it is off the sign-in dialog offers GitHub only,
// /signin/email and POST /api/signin/email answer 404, and the "email-link"
// provider (auth.ts) is not registered.
export const EMAIL_SIGNIN_ENABLED = process.env.NEXT_PUBLIC_EMAIL_SIGNIN_ENABLED === "true";
