// The numbers in the results table. Pure functions, no files and no model calls.
// The definitions are written down in `eval/rubric.md`.
import type { Setup } from "../types";
import type { EvalRecord, Grade, SetupSummary } from "./types";

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** The average. An empty list gives 0, so a setup with no data shows 0 and not NaN. */
export function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

/**
 * The value at percentile `p` (0 to 100), by the nearest rank method.
 * Sort the values, then take the one at position ceil(p / 100 * n), counting from 1.
 * The result is always one of the values. Nothing is interpolated, so the median of
 * 1, 2, 3, 4 is 2 and not 2.5. An empty list gives 0.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/** Unsupported claims divided by claims shown. 0 when no claims were shown. */
export function unsupportedClaimRate(grades: Grade[]): number {
  const shown = sum(grades.map((grade) => grade.total_claims));
  const unsupported = sum(grades.map((grade) => grade.unsupported_claims));
  return shown === 0 ? 0 : unsupported / shown;
}

/**
 * Builds one row of the results table from the records and grades of one setup.
 * Pass every repeat at once. Each record and grade says which repeat it belongs to.
 *
 * Correctness and the unsupported-claim rate are worked out once per repeat. The row holds
 * the mean of those values and the lowest and highest one, which shows how much a rerun
 * moves the number. Every other metric is taken over all runs together.
 */
export function summariseSetup(setup: Setup, records: EvalRecord[], grades: Grade[]): SetupSummary {
  const repeats = [...new Set(grades.map((grade) => grade.repeat))].sort((a, b) => a - b);
  const correctnessByRepeat: number[] = [];
  const unsupportedByRepeat: number[] = [];
  for (const repeat of repeats) {
    const ofRepeat = grades.filter((grade) => grade.repeat === repeat);
    correctnessByRepeat.push(mean(ofRepeat.map((grade) => grade.correctness)));
    unsupportedByRepeat.push(unsupportedClaimRate(ofRepeat));
  }

  // Questions with no gold sources have nothing to retrieve, so they are left out of the rate.
  const withGoldSources = grades.filter((grade) => grade.retrieval_hit !== null);
  const latenciesInSeconds = records.map((record) => record.run.total_latency_ms / 1000);
  const verifications = records.flatMap((record) =>
    record.run.verification ? [record.run.verification] : [],
  );

  return {
    setup,
    repeats: repeats.length,
    questions: new Set(grades.map((grade) => grade.question_id)).size,
    correctness: mean(correctnessByRepeat),
    correctness_min: repeats.length === 0 ? 0 : Math.min(...correctnessByRepeat),
    correctness_max: repeats.length === 0 ? 0 : Math.max(...correctnessByRepeat),
    unsupported_claim_rate: mean(unsupportedByRepeat),
    unsupported_claim_rate_min: repeats.length === 0 ? 0 : Math.min(...unsupportedByRepeat),
    unsupported_claim_rate_max: repeats.length === 0 ? 0 : Math.max(...unsupportedByRepeat),
    behaviour_accuracy: mean(grades.map((grade) => (grade.behaviour_correct ? 1 : 0))),
    retrieval_hit_rate: mean(withGoldSources.map((grade) => (grade.retrieval_hit ? 1 : 0))),
    cost_per_answer_usd: mean(records.map((record) => record.run.total_usage.costUsd)),
    latency_p50_s: percentile(latenciesInSeconds, 50),
    latency_p95_s: percentile(latenciesInSeconds, 95),
    claims_shown: sum(grades.map((grade) => grade.total_claims)),
    errors: records.filter((record) => record.run.final_answer === null).length,
    dropped_by_quote_check: sum(verifications.map((v) => v.dropped_by_quote_check)),
    dropped_by_verifier: sum(verifications.map((v) => v.dropped_by_verifier)),
    repairs_ran: verifications.filter((v) => v.repair_ran).length,
  };
}
