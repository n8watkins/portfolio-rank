// Every Workers AI call goes through the `portfoliorank-ai` AI Gateway, which
// holds a Cloudflare-side rate limit sized so the most neurons it can let
// through stay under PortfolioRank's slice of the account's 10,000 neurons a
// day (docs/AI-GATEWAY.md). Workers AI bills past the free amount instead of
// stopping, so a 429 here means the budget is spent: fail closed, no retry.

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
