// Every Workers AI call goes through the `portfoliorank-ai` AI Gateway, which
// holds a Cloudflare-side rate limit of 40 requests per 3600 s (sliding).
// That limit is NOT sized to keep Workers AI free: 40 an hour for a whole day
// would be far past the account's free 10,000 neurons. The guard that keeps
// it free is the database reservation in lib/content/neurons.mjs: every call
// reserves its image and neurons first, at most 40 images and 2,500 neurons
// a UTC day, and is skipped without room (docs/AI-GATEWAY.md). The gateway
// only bounds a burst. Workers AI bills past the free amount instead of
// stopping, so a 429 here means stop: fail closed, no retry.

export const AI_GATEWAY_ID = "portfoliorank-ai";

export class AiBudgetExhausted extends Error {
  constructor(message = "Workers AI budget exhausted (AI Gateway rate limit, 429)") {
    super(message);
    this.name = "AiBudgetExhausted";
    this.status = 429;
  }
}

function isRateLimited(e) {
  return e?.status === 429 || e?.statusCode === 429 || /\b429\b|rate.?limit/i.test(String(e?.message ?? e));
}

/** Wraps the AI binding: adds the gateway option to every run() and turns a 429 into AiBudgetExhausted. */
export function withGateway(ai) {
  if (!ai) return null;
  return {
    async run(model, input, options = {}) {
      try {
        return await ai.run(model, input, { ...options, gateway: { id: AI_GATEWAY_ID, ...options.gateway } });
      } catch (e) {
        if (isRateLimited(e)) throw new AiBudgetExhausted();
        throw e;
      }
    },
  };
}
