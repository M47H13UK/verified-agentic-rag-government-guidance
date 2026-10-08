// List prices, and the cost of a run worked out from them.
// The SDK reports a cost estimate of its own, but its price table is only as new as the SDK.
// The version installed here charges Sonnet 5.5 cache reads at twice the list price and does
// not know Haiku 5.5 at all. So the cost is worked out here, from the token counts the SDK reports.

/** US dollars per million tokens. */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead: number;
  /** The one hour cache write price. The SDK writes one hour cache entries on a subscription token. */
  cacheWrite: number;
};

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

/**
 * List prices on 8 October 2026, from https://platform.claude.com/docs/en/about-claude/pricing.
 * Haiku 5.5 costs five times as much for a prompt over 100,000 tokens. No prompt in this
 * project comes near that size, so only its lower price is listed.
 */
export const LIST_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
};

/**
 * The price of a model, or undefined when it is not in the table.
 * A dated ID such as `claude-haiku-4-5-20251001` uses the row of `claude-haiku-4-5`.
 */
export function priceOf(model: string): ModelPrice | undefined {
  return LIST_PRICES[model.replace(/-\d{8}$/, "")];
}

/** What these tokens cost at this price, in US dollars. */
export function costAtListPrice(tokens: TokenCounts, price: ModelPrice): number {
  const dollarsPerMillion =
    tokens.inputTokens * price.input +
    tokens.outputTokens * price.output +
    tokens.cacheReadTokens * price.cacheRead +
    tokens.cacheCreationTokens * price.cacheWrite;
  return dollarsPerMillion / 1_000_000;
}
