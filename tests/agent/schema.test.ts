import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildPrompt, MAX_TOOL_TURNS, SYSTEM_PROMPT } from "../../src/agent/prompt";
import { answerJsonSchema, answerSchema } from "../../src/agent/schema";
import { usageFromResult } from "../../src/llm/sdk";
import { addUsage } from "../../src/usage";

describe("answer schema", () => {
  it("accepts a valid answer", () => {
    const answer = {
      status: "answered",
      summary: "A Graduate visa lasts 18 months if you apply in 2027.",
      claims: [
        {
          text: "It lasts 18 months if you apply on or after 1 January 2027.",
          citations: [
            {
              passage_id: "/graduate-visa#overview#2",
              quote: "18 months if you apply on or after 1 January 2027",
            },
          ],
        },
      ],
    };
    expect(answerSchema.safeParse(answer).success).toBe(true);
  });

  it("rejects an unknown status and a claim without citations", () => {
    expect(answerSchema.safeParse({ status: "maybe", summary: "", claims: [] }).success).toBe(
      false,
    );
    expect(
      answerSchema.safeParse({ status: "answered", summary: "", claims: [{ text: "x" }] }).success,
    ).toBe(false);
  });

  it("is converted to JSON Schema draft-07, the version the SDK validates with", () => {
    expect(answerJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(answerJsonSchema.required).toEqual(["status", "summary", "claims"]);
  });
});

describe("prompt", () => {
  it("tells the model about the turn cap", () => {
    expect(SYSTEM_PROMPT).toContain(`after ${MAX_TOOL_TURNS} steps`);
  });

  it("adds the repair feedback after the question", () => {
    expect(buildPrompt("How long?")).toBe("How long?");
    expect(buildPrompt("How long?", "Claim 2 failed.")).toBe("How long?\n\nClaim 2 failed.");
  });
});

describe("usage", () => {
  it("sums tokens over every model in the result and takes the SDK's cost", () => {
    // Shaped like a real result: the main model plus the SDK's small extra call on Haiku.
    const result = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.006461,
      modelUsage: {
        "claude-haiku-4-5": {
          inputTokens: 3133,
          outputTokens: 466,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 20,
          costUSD: 0.005463,
        },
        "claude-haiku-4-5-20251001": {
          inputTokens: 923,
          outputTokens: 15,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000998,
        },
      },
    } as unknown as SDKResultMessage;

    expect(usageFromResult(result)).toEqual({
      inputTokens: 4056,
      outputTokens: 481,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
      costUsd: 0.006461,
    });
  });

  it("adds two usage records field by field", () => {
    const a = {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      costUsd: 0.5,
    };
    expect(addUsage(a, a)).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 8,
      costUsd: 1,
    });
  });
});
