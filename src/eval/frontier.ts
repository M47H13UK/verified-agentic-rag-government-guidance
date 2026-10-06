// Which setups are worth their cost, and which two the write-up leads with.
// The rule was fixed before any results existed. It is written down in `eval/rubric.md`.
import type { SetupSummary } from "./types";

/** A setup counts as accurate when its correctness is within 2 percentage points of the best. */
export const CORRECTNESS_MARGIN = 0.02;

/** Its unsupported-claim rate may be at most 1 percentage point higher than the best setup's. */
export const UNSUPPORTED_MARGIN = 0.01;

// In floating point 0.9 - 0.88 gives 0.020000000000000018, which is slightly over the margin.
// This allowance stops a setup that is exactly on the limit from being ruled out by that.
const ROUNDING = 1e-9;

/** The rule in words. The frontier report prints it, and a test checks the rubric holds it too. */
export const HEADLINE_RULE: string[] = [
  "The most accurate setup is the one with the highest correctness. A tie goes to the cheaper setup.",
  "The cheapest accurate setup is the cheapest one whose correctness is within 2 percentage points of the most accurate setup and whose unsupported-claim rate is at most 1 percentage point higher.",
  "If one setup is both, the second headline setup is the next cheapest setup on the frontier.",
];

/**
 * True when `a` makes `b` pointless. `a` is at least as cheap and at least as accurate,
 * and it is better on one of the two.
 */
function beats(a: SetupSummary, b: SetupSummary): boolean {
  const noWorse = a.cost_per_answer_usd <= b.cost_per_answer_usd && a.correctness >= b.correctness;
  const better = a.cost_per_answer_usd < b.cost_per_answer_usd || a.correctness > b.correctness;
  return noWorse && better;
}

/**
 * The IDs of the setups on the frontier, cheapest first.
 * A setup is on it when no other setup is both cheaper and more accurate. A tie on one of
 * the two counts against the setup that is worse on the other, so a setup that costs more
 * for the same correctness is off the frontier.
 */
export function paretoFrontier(summaries: SetupSummary[]): string[] {
  return summaries
    .filter((setup) => !summaries.some((other) => beats(other, setup)))
    .sort((a, b) => a.cost_per_answer_usd - b.cost_per_answer_usd)
    .map((summary) => summary.setup.id);
}

export type HeadlineSetups = {
  most_accurate: string | null;
  /** The cheapest accurate setup. When one setup is both, the next cheapest on the frontier. */
  cheapest_accurate: string | null;
  /** Cost of the most accurate setup divided by the cost of the other one. */
  cost_ratio: number | null;
  /** True when the most accurate setup was also the cheapest accurate one. */
  one_setup_is_both: boolean;
};

/** Picks the two headline setups by the rule in `HEADLINE_RULE`. */
export function pickHeadlineSetups(summaries: SetupSummary[]): HeadlineSetups {
  const byCost = [...summaries].sort((a, b) => a.cost_per_answer_usd - b.cost_per_answer_usd);
  const cheapest = byCost[0];
  if (!cheapest) {
    return {
      most_accurate: null,
      cheapest_accurate: null,
      cost_ratio: null,
      one_setup_is_both: false,
    };
  }

  // Walk from cheapest to most expensive and switch only for a strictly higher correctness.
  // A tie therefore stays with the cheaper setup.
  let mostAccurate = cheapest;
  for (const setup of byCost) {
    if (setup.correctness > mostAccurate.correctness) mostAccurate = setup;
  }

  // The most accurate setup always passes both tests itself, so one is always found.
  const cheapestAccurate =
    byCost.find(
      (setup) =>
        mostAccurate.correctness - setup.correctness <= CORRECTNESS_MARGIN + ROUNDING &&
        setup.unsupported_claim_rate - mostAccurate.unsupported_claim_rate <=
          UNSUPPORTED_MARGIN + ROUNDING,
    ) ?? mostAccurate;

  let second: SetupSummary | null = cheapestAccurate;
  const oneSetupIsBoth = cheapestAccurate.setup.id === mostAccurate.setup.id;
  if (oneSetupIsBoth) {
    // Comparing a setup with itself says nothing, so take the next step down the frontier.
    // The most accurate setup is the most expensive one on the frontier, so every other setup on it
    // is cheaper, and the last of them in cost order is the next cheapest.
    const frontier = paretoFrontier(summaries);
    const others = byCost.filter(
      (setup) => frontier.includes(setup.setup.id) && setup.setup.id !== mostAccurate.setup.id,
    );
    second = others.at(-1) ?? null;
  }

  return {
    most_accurate: mostAccurate.setup.id,
    cheapest_accurate: second ? second.setup.id : null,
    cost_ratio:
      second && second.cost_per_answer_usd > 0
        ? mostAccurate.cost_per_answer_usd / second.cost_per_answer_usd
        : null,
    one_setup_is_both: oneSetupIsBoth,
  };
}
