import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { JUDGE_MODEL, SETUPS, VERIFIER_MODEL } from "../src/eval/setups";
import { costAtListPrice, LIST_PRICES, priceOf } from "../src/llm/prices";
import { usageFromResult } from "../src/llm/sdk";

const tokens = {
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 2_000_000,
  cacheCreationTokens: 500_000,
};

/** A result message with one model in it, shaped like the SDK's. */
function resultFor(model: string, costUSD: number): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: costUSD,
    modelUsage: {
      [model]: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 2000,
        cacheCreationInputTokens: 500,
        costUSD,
      },
    },
  } as unknown as SDKResultMessage;
}

describe("list prices", () => {
  it("has a price for every model the eval uses", () => {
    const models = [...SETUPS.map((setup) => setup.model), VERIFIER_MODEL, JUDGE_MODEL];
    for (const model of models) {
      expect(priceOf(model), model).toBeDefined();
    }
  });

  it("uses the undated row for a dated model ID", () => {
    expect(priceOf("claude-haiku-4-5-20251001")).toBe(LIST_PRICES["claude-haiku-4-5"]);
    expect(priceOf("some-other-model")).toBeUndefined();
  });

  it("adds up input, output, cache reads and cache writes", () => {
    // Sonnet 5.5. $2 for input, $1 for output, $0.20 for cache reads, $2 for cache writes.
    expect(costAtListPrice(tokens, LIST_PRICES["claude-sonnet-5-5"]!)).toBeCloseTo(5.2, 10);
    // Haiku 5.5. $0.10, $0.05, $0.02 and $0.10.
    expect(costAtListPrice(tokens, LIST_PRICES["claude-haiku-5-5"]!)).toBeCloseTo(0.27, 10);
  });
});

describe("usageFromResult", () => {
  it("ignores the SDK's cost for a model in the table", () => {
    // The installed SDK does not know Haiku 5.5 and reports a guess that is far too high.
    const usage = usageFromResult(resultFor("claude-haiku-5-5", 0.02));

    const expected = (1000 * 0.1 + 100 * 0.5 + 2000 * 0.01 + 500 * 0.2) / 1_000_000;
    expect(usage.costUsd).toBeCloseTo(expected, 10);
  });

  it("falls back to the SDK's cost for a model with no price, and says so once", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(usageFromResult(resultFor("model-with-no-price", 0.5)).costUsd).toBe(0.5);
    usageFromResult(resultFor("model-with-no-price", 0.5));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain("no list price for model-with-no-price");
    log.mockRestore();
  });
});
