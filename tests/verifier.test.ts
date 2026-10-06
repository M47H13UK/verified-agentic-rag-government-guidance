import { describe, expect, it } from "vitest";
import type { StructuredCall } from "../src/llm/types";
import type { Claim, Passage, Usage } from "../src/types";
import {
  NO_VERDICT_REASON,
  VERIFIER_SYSTEM_PROMPT,
  buildVerifierPrompt,
  makeVerifier,
  verdictSchema,
  type VerifierOutput,
} from "../src/verify/verifier";
import { samplePassages } from "./helpers/fixtures";

const passages = new Map<string, Passage>(samplePassages().map((p) => [p._id, p]));

const STAY = "/graduate-visa#overview#2";
const WORK = "/graduate-visa#overview#3";

const phdClaim: Claim = {
  text: "A Graduate visa lasts for 3 years if you have a PhD.",
  citations: [
    {
      passage_id: STAY,
      quote: "If you have a PhD or other doctoral qualification, it will last for 3 years.",
    },
  ],
};

/** The quote is real, but the claim says "any job" and the passage says "most jobs". */
const anyJobClaim: Claim = {
  text: "With a Graduate visa you can work in any job.",
  citations: [{ passage_id: WORK, quote: "With a Graduate visa you can: work in most jobs" }],
};

// Indexes 0 and 2, as if claim 1 of the answer had already failed the quote check.
const input = {
  question: "Can I work on a Graduate visa?",
  summary: "You can work in any job, for 3 years if you have a PhD.",
  claims: [
    { claim_index: 0, claim: phdClaim },
    { claim_index: 2, claim: anyJobClaim },
  ],
  passages,
};

const USAGE: Usage = {
  inputTokens: 900,
  outputTokens: 80,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.004,
};

/** A fake model call. It returns `output`, or fails when `output` is null. It records each call. */
function fakeCall(output: unknown) {
  const calls: { model: string; system: string; prompt: string }[] = [];
  const call: StructuredCall = async (args) => {
    calls.push(args);
    if (output === null) {
      return { data: null, usage: USAGE, latencyMs: 40, error: "model call failed" };
    }
    return { data: args.schema.parse(output), usage: USAGE, latencyMs: 40 };
  };
  return { call, calls };
}

/** What the fake model returns. The summary is supported unless the test says otherwise. */
function verifierOutput(
  verdicts: VerifierOutput["verdicts"],
  summary_supported = true,
): VerifierOutput {
  return {
    verdicts,
    summary_supported,
    summary_reason: summary_supported
      ? "The claims cover the summary."
      : "The summary says more than the claims.",
  };
}

const SUPPORTED_0 = {
  claim_index: 0,
  verdict: "supported" as const,
  reason: "The passage states this.",
};
const NOT_SUPPORTED_2 = {
  claim_index: 2,
  verdict: "not_supported" as const,
  reason: "The passage says most jobs.",
  fix: "Say that you can work in most jobs.",
};

describe("verdictSchema and system prompt", () => {
  it("rejects a verdict that is not one of the three allowed values", () => {
    // The summary fields are valid, so the verdict is the only fault.
    const output = {
      verdicts: [{ claim_index: 0, verdict: "mostly_supported", reason: "Close." }],
      summary_supported: true,
      summary_reason: "The claims cover the summary.",
    };
    expect(verdictSchema.safeParse(output).success).toBe(false);
  });

  it("requires a verdict on the summary", () => {
    const full = verifierOutput([SUPPORTED_0]);
    expect(verdictSchema.safeParse(full).success).toBe(true);
    // An output with claim verdicts only is not valid, so the verifier fails closed on it.
    expect(verdictSchema.safeParse({ verdicts: full.verdicts }).success).toBe(false);
  });

  it("explains every verdict the schema allows and forbids outside knowledge", () => {
    for (const verdict of ["supported", "partially_supported", "not_supported"]) {
      expect(VERIFIER_SYSTEM_PROMPT).toContain(`- ${verdict}:`);
    }
    expect(VERIFIER_SYSTEM_PROMPT).toContain("Do not use outside knowledge");
    // The prompt names the two summary fields the schema requires.
    expect(VERIFIER_SYSTEM_PROMPT).toContain("summary_supported");
    expect(VERIFIER_SYSTEM_PROMPT).toContain("summary_reason");
  });
});

describe("buildVerifierPrompt", () => {
  it("shows the question, the summary, then each claim with its index, quotes and full passages", () => {
    const prompt = buildVerifierPrompt(input.question, input.summary, input.claims, passages);
    const work = passages.get(WORK)!;

    expect(
      prompt.startsWith(
        "Question: Can I work on a Graduate visa?\n\n" +
          "Summary: You can work in any job, for 3 years if you have a PhD.\n\n" +
          '<claim index="0">',
      ),
    ).toBe(true);
    expect(prompt).toContain('<claim index="2">');
    expect(prompt).toContain("Claim: With a Graduate visa you can work in any job.");
    expect(prompt).toContain(`- From ${WORK}: "With a Graduate visa you can: work in most jobs"`);
    expect(prompt).toContain(`<passage id="${WORK}">`);
    expect(prompt).toContain("Heading: Graduate visa > Overview > How much it costs");
    expect(prompt).toContain("URL: https://www.gov.uk/graduate-visa");
    expect(prompt).toContain("Updated: 2024-10-31T17:01:07+00:00");
    expect(prompt).toContain(work.text);
  });
});

describe("makeVerifier", () => {
  it("makes one model call for all claims and returns one verdict per claim", async () => {
    const { call, calls } = fakeCall(verifierOutput([SUPPORTED_0, NOT_SUPPORTED_2]));

    const result = await makeVerifier(call, "claude-sonnet-5-5")(input);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("claude-sonnet-5-5");
    expect(calls[0]!.system).toBe(VERIFIER_SYSTEM_PROMPT);
    // The summary reaches the model in the same call as the claims.
    expect(calls[0]!.prompt).toBe(
      buildVerifierPrompt(input.question, input.summary, input.claims, passages),
    );
    expect(result.verdicts).toEqual([
      {
        claim_index: 0,
        verdict: "supported",
        reason: "The passage states this.",
        checked_by: "verifier",
      },
      {
        claim_index: 2,
        verdict: "not_supported",
        reason: "The passage says most jobs.",
        fix: "Say that you can work in most jobs.",
        checked_by: "verifier",
      },
    ]);
    expect(result.usage).toEqual(USAGE);
    expect(result.latencyMs).toBe(40);
  });

  it("reports the model's verdict on the summary and leaves the claim verdicts alone", async () => {
    for (const summary_supported of [true, false]) {
      const { call } = fakeCall(verifierOutput([SUPPORTED_0, NOT_SUPPORTED_2], summary_supported));

      const result = await makeVerifier(call, "claude-sonnet-5-5")(input);

      expect(result.summarySupported).toBe(summary_supported);
      expect(result.verdicts.map((v) => v.verdict)).toEqual(["supported", "not_supported"]);
    }
  });

  it("fails closed when the model call returns no data", async () => {
    const { call } = fakeCall(null);

    const result = await makeVerifier(call, "claude-sonnet-5-5")(input);

    expect(result.verdicts.map((v) => v.verdict)).toEqual(["not_supported", "not_supported"]);
    expect(result.verdicts.map((v) => v.reason)).toEqual([NO_VERDICT_REASON, NO_VERDICT_REASON]);
    // No answer about the summary means it is not trusted either.
    expect(result.summarySupported).toBe(false);
    expect(result.error).toBe("model call failed");
  });

  it("fails closed for a claim that is missing from the model's output", async () => {
    const { call } = fakeCall(verifierOutput([SUPPORTED_0]));

    const result = await makeVerifier(call, "claude-sonnet-5-5")(input);

    expect(result.verdicts[0]!.verdict).toBe("supported");
    expect(result.verdicts[1]).toEqual({
      claim_index: 2,
      verdict: "not_supported",
      reason: NO_VERDICT_REASON,
      checked_by: "verifier",
    });
  });

  it("fails closed when the model call throws", async () => {
    const call: StructuredCall = async () => {
      throw new Error("network down");
    };

    const result = await makeVerifier(call, "claude-sonnet-5-5")(input);

    expect(result.verdicts.map((v) => v.verdict)).toEqual(["not_supported", "not_supported"]);
    expect(result.summarySupported).toBe(false);
    expect(result.usage.costUsd).toBe(0);
    expect(result.error).toContain("network down");
  });
});
