import { describe, expect, it } from "vitest";
import { mean, percentile, summariseSetup, unsupportedClaimRate } from "../../src/eval/metrics";
import type { EvalRecord } from "../../src/eval/types";
import {
  H0,
  H1,
  makeAnswer,
  makeGrade,
  makeQuestion,
  makeRecord,
  makeRun,
  usage,
} from "./builders";

describe("percentile (nearest rank)", () => {
  it("returns one of the values and never a point in between", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("takes the top value for the 95th percentile of a short list", () => {
    const oneToTwenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(oneToTwenty, 95)).toBe(19);
    expect(percentile([10, 20, 30], 95)).toBe(30);
  });

  it("rounds the rank up, so the 12th percentile of 10 values is the 2nd value", () => {
    // 12% of 10 is 1.2. Nearest rank takes position 2, where plain rounding would take 1.
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 12)).toBe(20);
  });

  it("gives 0 for an empty list", () => {
    expect(percentile([], 50)).toBe(0);
    expect(mean([])).toBe(0);
  });
});

describe("unsupportedClaimRate", () => {
  it("is one third for 3 claims shown with 1 unsupported", () => {
    const grades = [
      makeGrade({ question_id: "q01", total_claims: 2, unsupported_claims: 1 }),
      makeGrade({ question_id: "q02", total_claims: 1, unsupported_claims: 0 }),
    ];
    expect(unsupportedClaimRate(grades)).toBeCloseTo(1 / 3);
  });

  it("is 0 when no claims were shown", () => {
    expect(unsupportedClaimRate([makeGrade({ total_claims: 0 })])).toBe(0);
  });
});

describe("summariseSetup", () => {
  /** A record whose only interesting fields are its cost and latency. */
  function record(questionId: string, repeat: number, costUsd: number, latencyMs: number) {
    const question = makeQuestion({ id: questionId });
    return makeRecord(H0, question, makeAnswer(), {
      repeat,
      run: makeRun(H0, question.question, makeAnswer(), {
        total_usage: usage(costUsd),
        total_latency_ms: latencyMs,
      }),
    });
  }

  it("averages correctness over questions, with 3 of 4 points scoring 0.75", () => {
    const records = [record("q01", 1, 0.02, 2000), record("q02", 1, 0.04, 4000)];
    const grades = [
      makeGrade({ question_id: "q01", correctness: 0.75, total_claims: 3, unsupported_claims: 1 }),
      makeGrade({ question_id: "q02", correctness: 1, behaviour_correct: false }),
    ];

    const summary = summariseSetup(H0, records, grades);
    expect(summary.questions).toBe(2);
    expect(summary.repeats).toBe(1);
    expect(summary.correctness).toBeCloseTo(0.875);
    expect(summary.correctness_min).toBeCloseTo(0.875);
    expect(summary.correctness_max).toBeCloseTo(0.875);
    expect(summary.unsupported_claim_rate).toBeCloseTo(1 / 3);
    expect(summary.behaviour_accuracy).toBe(0.5);
    expect(summary.cost_per_answer_usd).toBeCloseTo(0.03);
    expect(summary.latency_p50_s).toBe(2);
    expect(summary.latency_p95_s).toBe(4);
    expect(summary.claims_shown).toBe(3);
    expect(summary.errors).toBe(0);
  });

  it("reports the mean and the lowest and highest repeat", () => {
    const records = [record("q01", 1, 0.01, 1000), record("q01", 2, 0.01, 1000)];
    const grades = [
      makeGrade({ repeat: 1, correctness: 0.5, total_claims: 4, unsupported_claims: 2 }),
      makeGrade({ repeat: 2, correctness: 1, total_claims: 4, unsupported_claims: 0 }),
    ];

    const summary = summariseSetup(H0, records, grades);
    expect(summary.repeats).toBe(2);
    expect(summary.questions).toBe(1);
    expect(summary.correctness).toBeCloseTo(0.75);
    expect(summary.correctness_min).toBe(0.5);
    expect(summary.correctness_max).toBe(1);
    expect(summary.unsupported_claim_rate).toBeCloseTo(0.25);
    expect(summary.unsupported_claim_rate_min).toBe(0);
    expect(summary.unsupported_claim_rate_max).toBe(0.5);
  });

  it("leaves questions with no gold sources out of the retrieval hit rate", () => {
    const grades = [
      makeGrade({ question_id: "q01", retrieval_hit: true }),
      makeGrade({ question_id: "q02", retrieval_hit: false }),
      makeGrade({ question_id: "q03", retrieval_hit: null }),
    ];
    expect(summariseSetup(H0, [], grades).retrieval_hit_rate).toBe(0.5);
  });

  it("counts errors and adds up what the verifier did", () => {
    const question = makeQuestion();
    const failed: EvalRecord = makeRecord(H1, question, null);
    const verified: EvalRecord = makeRecord(H1, question, makeAnswer(), {
      run: makeRun(H1, question.question, makeAnswer(), {
        verification: {
          claims_before: 4,
          dropped_by_quote_check: 1,
          dropped_by_verifier: 2,
          repair_ran: true,
          repair: null,
          summary_replaced: false,
          claims_after_repair: 3,
          claims_final: 1,
          first_pass: [],
          second_pass: [],
          unconfirmed: [],
          extra_usage: usage(0.01),
          extra_latency_ms: 500,
        },
      }),
    });

    const summary = summariseSetup(H1, [failed, verified], []);
    expect(summary.errors).toBe(1);
    expect(summary.dropped_by_quote_check).toBe(1);
    expect(summary.dropped_by_verifier).toBe(2);
    expect(summary.repairs_ran).toBe(1);
  });
});
