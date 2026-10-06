import { describe, expect, it } from "vitest";
import type { StructuredCall } from "../src/llm/types";
import { NOT_CONFIRMED, runPipeline, type PipelineDeps } from "../src/pipeline";
import type {
  AnswerBackend,
  AnswerResult,
  Claim,
  Passage,
  PassageLookup,
  RunOptions,
  Setup,
  StructuredAnswer,
  Usage,
} from "../src/types";
import { ZERO_USAGE, addUsage } from "../src/usage";
import {
  NO_VERDICT_REASON,
  makeVerifier,
  type VerifierFn,
  type VerifierOutput,
} from "../src/verify/verifier";
import { samplePassages } from "./helpers/fixtures";

const QUESTION = "What can I do on a Graduate visa?";
const VERIFIER_OFF: Setup = { id: "H0", model: "claude-haiku-4-5", verifier: false };
const VERIFIER_ON: Setup = { id: "H1", model: "claude-haiku-4-5", verifier: true };

const STAY = "/graduate-visa#overview#2";
const WORK = "/graduate-visa#overview#3";

// ---------- Claims ----------

/** A true claim with a real quote. */
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

/** The corrected version of the claim above. */
const mostJobsClaim: Claim = {
  text: "With a Graduate visa you can work in most jobs.",
  citations: [{ passage_id: WORK, quote: "With a Graduate visa you can: work in most jobs" }],
};

/** A second true claim with a real quote. */
const applyClaim: Claim = {
  text: "You must apply before your Student visa expires.",
  citations: [
    {
      passage_id: STAY,
      quote: "You must apply before your Student visa or Tier 4 (General) student visa expires.",
    },
  ],
};

/** The quote is not in the passage. */
const fabricatedClaim: Claim = {
  text: "A Graduate visa lasts for 5 years.",
  citations: [{ passage_id: STAY, quote: "A Graduate visa lasts for 5 years" }],
};

const DRAFT_SUMMARY = "The summary the model wrote.";
const REPAIRED_SUMMARY = "The summary of the repaired answer.";

function answered(...claims: Claim[]): StructuredAnswer {
  return { status: "answered", summary: DRAFT_SUMMARY, claims };
}

/** The repair writes its own summary, so the tests can tell the two summaries apart. */
function repaired(...claims: Claim[]): StructuredAnswer {
  return { status: "answered", summary: REPAIRED_SUMMARY, claims };
}

// ---------- Fakes ----------

// The costs are powers of two, so the sums in the tests are exact.
const DRAFT_USAGE: Usage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 300,
  cacheCreationTokens: 40,
  costUsd: 0.5,
};
const REPAIR_USAGE: Usage = {
  inputTokens: 1500,
  outputTokens: 250,
  cacheReadTokens: 600,
  cacheCreationTokens: 0,
  costUsd: 0.25,
};
const VERIFIER_USAGE: Usage = {
  inputTokens: 800,
  outputTokens: 60,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.125,
};
const DRAFT_MS = 3000;
const REPAIR_MS = 4000;
const VERIFIER_MS = 500;

function draftResult(answer: StructuredAnswer | null): AnswerResult {
  return { answer, trace: [], usage: DRAFT_USAGE, latencyMs: DRAFT_MS, numTurns: 3 };
}

function repairResult(answer: StructuredAnswer | null): AnswerResult {
  return { answer, trace: [], usage: REPAIR_USAGE, latencyMs: REPAIR_MS, numTurns: 4 };
}

/** A fake agent. It returns `results` one by one and records the options of each call. */
function fakeBackend(results: AnswerResult[]) {
  const calls: RunOptions[] = [];
  const backend: AnswerBackend = {
    name: "fake",
    async answer(_question, opts) {
      const next = results[calls.length];
      calls.push(opts);
      if (!next) {
        throw new Error("The fake backend was called more often than the test expected.");
      }
      return next;
    },
  };
  return { backend, calls };
}

/**
 * A fake verifier model. It returns `outputs` one by one and records each prompt.
 * A null output, or a call past the end of the list, is a failed model call.
 */
function fakeVerifierCall(outputs: (VerifierOutput | null)[]) {
  const prompts: string[] = [];
  const call: StructuredCall = async (args) => {
    const output = outputs[prompts.length];
    prompts.push(args.prompt);
    if (!output) {
      return {
        data: null,
        usage: VERIFIER_USAGE,
        latencyMs: VERIFIER_MS,
        error: "model call failed",
      };
    }
    return { data: args.schema.parse(output), usage: VERIFIER_USAGE, latencyMs: VERIFIER_MS };
  };
  return { call, prompts };
}

/** What the fake verifier model returns. The summary is supported unless the test says otherwise. */
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

function supported(claim_index: number) {
  return { claim_index, verdict: "supported" as const, reason: "The passage states this." };
}

function notSupported(claim_index: number) {
  return {
    claim_index,
    verdict: "not_supported" as const,
    reason: "The passage says most jobs, not any job.",
    fix: "Say that you can work in most jobs.",
  };
}

const getPassages: PassageLookup = async (ids) => {
  const found = new Map<string, Passage>();
  for (const passage of samplePassages()) {
    if (ids.includes(passage._id)) {
      found.set(passage._id, passage);
    }
  }
  return found;
};

function makeDeps(backend: AnswerBackend, call: StructuredCall): PipelineDeps {
  return { backend, verify: makeVerifier(call, "claude-sonnet-5-5"), getPassages, maxTurns: 8 };
}

// ---------- Tests ----------

describe("runPipeline with the verifier off", () => {
  it("passes the draft through unchecked", async () => {
    const draft = draftResult(answered(phdClaim, fabricatedClaim));
    const { backend, calls } = fakeBackend([draft]);
    const { call, prompts } = fakeVerifierCall([]);

    const run = await runPipeline(QUESTION, VERIFIER_OFF, makeDeps(backend, call));

    // Strict, so an `effort: undefined` key would fail. The setup has no effort.
    expect(calls).toStrictEqual([{ model: "claude-haiku-4-5", maxTurns: 8 }]);
    expect(prompts).toHaveLength(0);
    expect(run.question).toBe(QUESTION);
    expect(run.setup).toEqual(VERIFIER_OFF);
    expect(run.draft).toBe(draft);
    expect(run.final_answer).toEqual(draft.answer);
    expect(run.verification).toBeNull();
    expect(run.final_verdicts).toEqual([]);
    expect(run.total_usage).toEqual(DRAFT_USAGE);
    expect(run.total_latency_ms).toBe(DRAFT_MS);
    expect(run._id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("runPipeline with the verifier on", () => {
  it("keeps a draft whose claims and summary are all supported, with one verifier call and no repair", async () => {
    const draft = draftResult(answered(phdClaim, mostJobsClaim));
    const { backend, calls } = fakeBackend([draft]);
    const { call, prompts } = fakeVerifierCall([verifierOutput([supported(0), supported(1)])]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(calls).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    // The verifier is shown the summary, and the summary the model wrote is kept.
    expect(prompts[0]).toContain(`Summary: ${DRAFT_SUMMARY}`);
    expect(run.final_answer).toEqual(draft.answer);
    expect(run.final_answer!.summary).toBe(DRAFT_SUMMARY);
    expect(run.final_verdicts.map((v) => [v.claim_index, v.verdict, v.checked_by])).toEqual([
      [0, "supported", "verifier"],
      [1, "supported", "verifier"],
    ]);
    expect(run.verification).toEqual({
      claims_before: 2,
      dropped_by_quote_check: 0,
      dropped_by_verifier: 0,
      repair_ran: false,
      repair: null,
      claims_after_repair: null,
      claims_final: 2,
      first_pass: run.final_verdicts,
      second_pass: null,
      unconfirmed: [],
      summary_replaced: false,
      extra_usage: VERIFIER_USAGE,
      extra_latency_ms: VERIFIER_MS,
    });
  });

  it("replaces a summary the verifier does not support, without a repair", async () => {
    // Every claim passes. Only the summary says more than the claims do.
    const { backend, calls } = fakeBackend([draftResult(answered(phdClaim, mostJobsClaim))]);
    const { call, prompts } = fakeVerifierCall([
      verifierOutput([supported(0), supported(1)], false),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    // No claim failed, so the agent is not asked again.
    expect(calls).toHaveLength(1);
    expect(prompts).toHaveLength(1);
    expect(run.final_answer).toEqual({
      status: "answered",
      summary: `${phdClaim.text} ${mostJobsClaim.text}`,
      claims: [phdClaim, mostJobsClaim],
    });
    expect(run.final_verdicts.map((v) => v.verdict)).toEqual(["supported", "supported"]);
    expect(run.verification).toMatchObject({
      dropped_by_quote_check: 0,
      dropped_by_verifier: 0,
      repair_ran: false,
      second_pass: null,
      claims_final: 2,
      unconfirmed: [],
      summary_replaced: true,
    });
  });

  it("leaves the summary of a declined answer alone, even when the verifier does not support it", async () => {
    // A decline can still cite what the guidance says. Its summary explains the refusal.
    const declined: StructuredAnswer = {
      status: "declined",
      summary: "I cannot say whether your application will succeed.",
      claims: [phdClaim],
      declined_reason: "That is a decision for the Home Office.",
    };
    const { backend } = fakeBackend([draftResult(declined)]);
    const { call } = fakeVerifierCall([verifierOutput([supported(0)], false)]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(run.final_answer).toEqual(declined);
    expect(run.verification!.summary_replaced).toBe(false);
  });

  it("keeps a partially supported claim and does not repair it", async () => {
    const draft = draftResult(answered(phdClaim));
    const { backend, calls } = fakeBackend([draft]);
    const { call } = fakeVerifierCall([
      verifierOutput([
        { claim_index: 0, verdict: "partially_supported", reason: "It leaves out doctorates." },
      ]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(calls).toHaveLength(1);
    expect(run.verification!.repair_ran).toBe(false);
    expect(run.final_answer).toEqual(draft.answer);
    expect(run.final_verdicts[0]!.verdict).toBe("partially_supported");
  });

  it("drops a fabricated quote in the quote check and never sends it to the verifier", async () => {
    const { backend } = fakeBackend([
      draftResult(answered(phdClaim, fabricatedClaim)),
      repairResult(repaired(phdClaim)),
    ]);
    const { call, prompts } = fakeVerifierCall([
      verifierOutput([supported(0)]),
      verifierOutput([supported(0)]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(prompts[0]).toContain(phdClaim.text);
    expect(prompts[0]).not.toContain(fabricatedClaim.text);
    expect(run.verification!.dropped_by_quote_check).toBe(1);
    expect(run.verification!.dropped_by_verifier).toBe(0);
    expect(run.verification!.first_pass[1]).toEqual({
      claim_index: 1,
      verdict: "not_supported",
      reason: "Quote not found in passage /graduate-visa#overview#2.",
      checked_by: "quote_check",
    });
    expect(run.final_answer!.claims).toEqual([phdClaim]);
  });

  it("runs exactly one repair when the verifier rejects a claim, and keeps the repaired claim", async () => {
    const repairedAnswer = repaired(phdClaim, mostJobsClaim);
    const { backend, calls } = fakeBackend([
      draftResult(answered(phdClaim, anyJobClaim)),
      repairResult(repairedAnswer),
    ]);
    const { call, prompts } = fakeVerifierCall([
      verifierOutput([supported(0), notSupported(1)]),
      verifierOutput([supported(0), supported(1)]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    // One draft call and one repair call. The repair gets the same options plus the feedback.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.model).toBe("claude-haiku-4-5");
    expect(calls[1]!.maxTurns).toBe(8);
    expect(calls[1]!.feedback).toContain(anyJobClaim.text);
    expect(calls[1]!.feedback).toContain("The passage says most jobs, not any job.");
    expect(calls[1]!.feedback).toContain("Say that you can work in most jobs.");
    expect(prompts).toHaveLength(2);

    expect(run.final_answer).toEqual(repairedAnswer);
    expect(run.final_verdicts.map((v) => v.verdict)).toEqual(["supported", "supported"]);
    expect(run.verification).toMatchObject({
      claims_before: 2,
      dropped_by_quote_check: 0,
      dropped_by_verifier: 1,
      repair_ran: true,
      claims_after_repair: 2,
      claims_final: 2,
      unconfirmed: [],
      summary_replaced: false,
    });
  });

  it("uses the summary verdict of the second pass after a repair", async () => {
    // The first pass rejects the draft's summary. That summary is not the one shown, so its
    // verdict must not replace the repaired summary, which the second pass accepts.
    const repairedAnswer = repaired(phdClaim, mostJobsClaim);
    const { backend } = fakeBackend([
      draftResult(answered(phdClaim, anyJobClaim)),
      repairResult(repairedAnswer),
    ]);
    const { call, prompts } = fakeVerifierCall([
      verifierOutput([supported(0), notSupported(1)], false),
      verifierOutput([supported(0), supported(1)], true),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    // Each pass is shown the summary of the answer it checks.
    expect(prompts[0]).toContain(`Summary: ${DRAFT_SUMMARY}`);
    expect(prompts[1]).toContain(`Summary: ${REPAIRED_SUMMARY}`);
    expect(run.final_answer).toEqual(repairedAnswer);
    expect(run.verification!.summary_replaced).toBe(false);
  });

  it("replaces the repaired summary when the second pass does not support it", async () => {
    // The other way round. The draft's summary was fine and the repaired one is not.
    const { backend, calls } = fakeBackend([
      draftResult(answered(phdClaim, anyJobClaim)),
      repairResult(repaired(phdClaim, mostJobsClaim)),
    ]);
    const { call } = fakeVerifierCall([
      verifierOutput([supported(0), notSupported(1)], true),
      verifierOutput([supported(0), supported(1)], false),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    // Still one repair. An unsupported summary never starts another one.
    expect(calls).toHaveLength(2);
    expect(run.final_answer).toEqual({
      status: "answered",
      summary: `${phdClaim.text} ${mostJobsClaim.text}`,
      claims: [phdClaim, mostJobsClaim],
    });
    expect(run.verification).toMatchObject({
      repair_ran: true,
      claims_final: 2,
      unconfirmed: [],
      summary_replaced: true,
    });
  });

  it("adds up usage and latency over the draft, the repair and both verifier calls", async () => {
    const { backend } = fakeBackend([
      draftResult(answered(phdClaim, anyJobClaim)),
      repairResult(repaired(phdClaim, mostJobsClaim)),
    ]);
    const { call } = fakeVerifierCall([
      verifierOutput([supported(0), notSupported(1)]),
      verifierOutput([supported(0), supported(1)]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    const extra = addUsage(addUsage(VERIFIER_USAGE, REPAIR_USAGE), VERIFIER_USAGE);
    expect(extra.costUsd).toBe(0.5);
    expect(run.verification!.extra_usage).toEqual(extra);
    expect(run.verification!.extra_latency_ms).toBe(VERIFIER_MS + REPAIR_MS + VERIFIER_MS);
    expect(run.total_usage).toEqual({
      inputTokens: 1000 + 800 + 1500 + 800,
      outputTokens: 200 + 60 + 250 + 60,
      cacheReadTokens: 300 + 600,
      cacheCreationTokens: 40,
      costUsd: 1,
    });
    expect(run.total_latency_ms).toBe(DRAFT_MS + VERIFIER_MS + REPAIR_MS + VERIFIER_MS);
  });

  it("removes a claim that still fails after the repair and rebuilds the summary from the kept claims", async () => {
    // The failing claim comes first, so the kept claims move from indexes 1 and 2 to 0 and 1.
    const { backend, calls } = fakeBackend([
      draftResult(answered(anyJobClaim, phdClaim, applyClaim)),
      repairResult(repaired(anyJobClaim, phdClaim, applyClaim)),
    ]);
    // The verifier accepts the summary both times. Removing a claim is enough to replace it,
    // because the summary was written with that claim in mind.
    const { call } = fakeVerifierCall([
      verifierOutput([notSupported(0), supported(1), supported(2)]),
      verifierOutput([notSupported(0), supported(1), supported(2)]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(calls).toHaveLength(2);
    expect(run.final_answer).toEqual({
      status: "answered",
      summary: `${phdClaim.text} ${applyClaim.text}`,
      claims: [phdClaim, applyClaim],
    });
    expect(run.final_verdicts).toEqual([
      {
        claim_index: 0,
        verdict: "supported",
        reason: "The passage states this.",
        checked_by: "verifier",
      },
      {
        claim_index: 1,
        verdict: "supported",
        reason: "The passage states this.",
        checked_by: "verifier",
      },
    ]);
    expect(run.verification!.second_pass!.map((v) => v.verdict)).toEqual([
      "not_supported",
      "supported",
      "supported",
    ]);
    expect(run.verification!.unconfirmed).toEqual([anyJobClaim.text]);
    expect(run.verification!.claims_after_repair).toBe(3);
    expect(run.verification!.claims_final).toBe(2);
    expect(run.verification!.summary_replaced).toBe(true);
  });

  it("turns the answer into a decline when every claim is removed", async () => {
    const { backend } = fakeBackend([
      draftResult(answered(anyJobClaim)),
      repairResult(repaired(anyJobClaim)),
    ]);
    const { call } = fakeVerifierCall([
      verifierOutput([notSupported(0)]),
      verifierOutput([notSupported(0)]),
    ]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(run.final_answer).toEqual({
      status: "declined",
      summary: NOT_CONFIRMED,
      claims: [],
      declined_reason: "The draft answer could not be confirmed against the guidance.",
    });
    expect(run.final_verdicts).toEqual([]);
    expect(run.verification!.claims_final).toBe(0);
    expect(run.verification!.unconfirmed).toEqual([anyJobClaim.text]);
    expect(run.verification!.summary_replaced).toBe(true);
  });

  it("falls back to the draft without its failed claims when the repair returns no answer", async () => {
    const { backend } = fakeBackend([
      draftResult(answered(phdClaim, anyJobClaim)),
      repairResult(null),
    ]);
    const { call, prompts } = fakeVerifierCall([verifierOutput([supported(0), notSupported(1)])]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(prompts).toHaveLength(1);
    expect(run.final_answer).toEqual({
      status: "answered",
      summary: phdClaim.text,
      claims: [phdClaim],
    });
    expect(run.verification).toMatchObject({
      repair_ran: true,
      claims_after_repair: 0,
      second_pass: [],
      claims_final: 1,
      unconfirmed: [anyJobClaim.text],
      summary_replaced: true,
      extra_usage: addUsage(VERIFIER_USAGE, REPAIR_USAGE),
    });
  });

  it("fails closed when the verifier model call fails", async () => {
    // Both verifier calls fail. A true claim with a real quote is still not shown.
    const { backend } = fakeBackend([
      draftResult(answered(phdClaim)),
      repairResult(repaired(phdClaim)),
    ]);
    const { call, prompts } = fakeVerifierCall([null, null]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(prompts).toHaveLength(2);
    expect(run.verification!.dropped_by_verifier).toBe(1);
    expect(run.verification!.first_pass[0]!.reason).toBe(NO_VERDICT_REASON);
    expect(run.final_answer!.status).toBe("declined");
    expect(run.final_answer!.claims).toEqual([]);
  });

  it("does not show a claim that a verifier left without a verdict", async () => {
    // A hand-written verifier that returns no verdicts. The pipeline must not read silence as
    // support, even when the same verifier accepts the summary.
    const silent: VerifierFn = async () => ({
      verdicts: [],
      summarySupported: true,
      usage: VERIFIER_USAGE,
      latencyMs: VERIFIER_MS,
    });
    const { backend } = fakeBackend([draftResult(answered(phdClaim)), repairResult(null)]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, {
      backend,
      verify: silent,
      getPassages,
    });

    expect(run.verification!.first_pass[0]!.reason).toBe(NO_VERDICT_REASON);
    expect(run.final_answer!.claims).toEqual([]);
    expect(run.verification!.unconfirmed).toEqual([phdClaim.text]);
  });

  it("verifies an existing draft without calling the backend for it", async () => {
    const existingDraft = draftResult(answered(phdClaim));
    const { backend, calls } = fakeBackend([]);
    const { call, prompts } = fakeVerifierCall([verifierOutput([supported(0)])]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call), existingDraft);

    expect(calls).toHaveLength(0);
    expect(prompts).toHaveLength(1);
    expect(run.draft).toBe(existingDraft);
    expect(run.final_answer).toEqual(existingDraft.answer);
    expect(run.total_usage).toEqual(addUsage(DRAFT_USAGE, VERIFIER_USAGE));
  });

  it("shows a declined answer with no claims as it is, without a verifier call", async () => {
    // There are no claims to compare the summary with, so the summary is shown unchecked.
    const declined: StructuredAnswer = {
      status: "declined",
      summary: "The guidance does not cover this.",
      claims: [],
      declined_reason: "The guidance does not cover this.",
    };
    const { backend, calls } = fakeBackend([draftResult(declined)]);
    const { call, prompts } = fakeVerifierCall([]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(calls).toHaveLength(1);
    expect(prompts).toHaveLength(0);
    expect(run.final_answer).toEqual(declined);
    expect(run.verification).toMatchObject({
      claims_before: 0,
      repair_ran: false,
      claims_final: 0,
      summary_replaced: false,
      extra_usage: ZERO_USAGE,
    });
  });

  it("does no verification work when the draft has no valid answer", async () => {
    const { backend, calls } = fakeBackend([draftResult(null)]);
    const { call, prompts } = fakeVerifierCall([]);

    const run = await runPipeline(QUESTION, VERIFIER_ON, makeDeps(backend, call));

    expect(calls).toHaveLength(1);
    expect(prompts).toHaveLength(0);
    expect(run.final_answer).toBeNull();
    expect(run.final_verdicts).toEqual([]);
    expect(run.verification).toMatchObject({
      claims_before: 0,
      repair_ran: false,
      claims_final: 0,
      summary_replaced: false,
    });
    expect(run.total_usage).toEqual(DRAFT_USAGE);
  });
});
