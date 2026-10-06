import { describe, expect, it } from "vitest";
import { paretoFrontier, pickHeadlineSetups } from "../../src/eval/frontier";
import type { SetupSummary } from "../../src/eval/types";

/** One row of a made-up results table. Only the three numbers the rule reads are set. */
function row(id: string, correctness: number, cost: number, unsupported = 0.02): SetupSummary {
  return {
    setup: { id, model: "made-up-model", verifier: false },
    repeats: 1,
    questions: 60,
    correctness,
    correctness_min: correctness,
    correctness_max: correctness,
    unsupported_claim_rate: unsupported,
    unsupported_claim_rate_min: unsupported,
    unsupported_claim_rate_max: unsupported,
    behaviour_accuracy: 1,
    retrieval_hit_rate: 1,
    cost_per_answer_usd: cost,
    latency_p50_s: 1,
    latency_p95_s: 2,
    claims_shown: 100,
    errors: 0,
    dropped_by_quote_check: 0,
    dropped_by_verifier: 0,
    repairs_ran: 0,
  };
}

describe("paretoFrontier", () => {
  it("keeps the setups that no other setup beats on both cost and correctness", () => {
    const table = [
      row("A", 0.7, 0.01),
      row("B", 0.8, 0.05),
      row("C", 0.75, 0.08), // B is cheaper and more accurate.
      row("D", 0.9, 0.4),
    ];
    expect(paretoFrontier(table)).toEqual(["A", "B", "D"]);
  });

  it("drops a setup that costs more for the same correctness", () => {
    expect(paretoFrontier([row("A", 0.8, 0.01), row("B", 0.8, 0.05)])).toEqual(["A"]);
  });
});

describe("pickHeadlineSetups", () => {
  it("picks the most accurate setup and the cheapest one close to it", () => {
    const table = [
      row("A", 0.7, 0.01),
      row("B", 0.89, 0.05), // 1 point below the best, at an eighth of the cost.
      row("C", 0.9, 0.4),
    ];
    const headline = pickHeadlineSetups(table);
    expect(headline.most_accurate).toBe("C");
    expect(headline.cheapest_accurate).toBe("B");
    expect(headline.cost_ratio).toBeCloseTo(8);
    expect(headline.one_setup_is_both).toBe(false);
  });

  it("counts a setup exactly 2 points below the best as accurate", () => {
    // 0.9 - 0.88 is 0.020000000000000018 in floating point. The rule must still let it in.
    const headline = pickHeadlineSetups([row("A", 0.88, 0.05), row("B", 0.9, 0.4)]);
    expect(headline.cheapest_accurate).toBe("A");
    // A must be picked as accurate in its own right, not as the fallback for a lone setup.
    expect(headline.one_setup_is_both).toBe(false);
  });

  it("rules out a cheap setup whose unsupported-claim rate is more than 1 point higher", () => {
    const table = [
      row("A", 0.89, 0.01, 0.05), // Close on correctness, but 3 points more unsupported claims.
      row("B", 0.89, 0.05, 0.02),
      row("C", 0.9, 0.4, 0.02),
    ];
    expect(pickHeadlineSetups(table).cheapest_accurate).toBe("B");
  });

  it("gives a tie on correctness to the cheaper setup", () => {
    const headline = pickHeadlineSetups([row("A", 0.9, 0.4), row("B", 0.9, 0.1)]);
    expect(headline.most_accurate).toBe("B");
  });

  it("falls back to the next cheapest setup on the frontier when one setup is both", () => {
    const table = [
      row("A", 0.6, 0.01),
      row("B", 0.7, 0.05),
      row("C", 0.65, 0.08), // Off the frontier, so it cannot be the second setup.
      row("D", 0.9, 0.4), // Nothing else is within 2 points, so D is both.
    ];
    const headline = pickHeadlineSetups(table);
    expect(headline.one_setup_is_both).toBe(true);
    expect(headline.most_accurate).toBe("D");
    expect(headline.cheapest_accurate).toBe("B");
    expect(headline.cost_ratio).toBeCloseTo(8);
  });

  it("returns nulls for an empty table and for a table with one setup", () => {
    expect(pickHeadlineSetups([])).toEqual({
      most_accurate: null,
      cheapest_accurate: null,
      cost_ratio: null,
      one_setup_is_both: false,
    });
    expect(pickHeadlineSetups([row("A", 0.9, 0.4)])).toEqual({
      most_accurate: "A",
      cheapest_accurate: null,
      cost_ratio: null,
      one_setup_is_both: true,
    });
  });
});
