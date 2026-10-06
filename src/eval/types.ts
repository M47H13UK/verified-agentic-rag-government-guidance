import type { AnswerStatus, Run, Setup, Usage, Verdict } from "../types";

export type Category =
  | "single_page"
  | "multi_page"
  | "numbers"
  | "not_covered"
  | "personal_judgement"
  | "false_premise"
  | "ambiguous";

/** One line of eval/questions.jsonl. */
export type GoldQuestion = {
  id: string;
  /** 1 to 6, see eval/personas.md. */
  persona: number;
  category: Category;
  question: string;
  expected_behaviour: "answer" | "decline" | "clarify";
  /** Facts a correct answer must contain. Empty for decline and clarify questions. */
  expected_points: string[];
  /** Page paths that hold the answer, for example "/skilled-worker-visa/your-job" or "/graduate-visa". */
  gold_sources: string[];
  /** Known wrong or outdated statements. */
  must_not_say: string[];
  /** Drafting notes, for example which passage each point came from. */
  notes?: string;
  /**
   * Where each expected point comes from. The drafter fills it in so a person can check the point quickly.
   * It is not used for scoring.
   */
  evidence?: { point: string; passage_id: string; quote: string }[];
  /** Null until a person has checked the question by hand. */
  verified_by: string | null;
  verified_on: string | null;
};

/** One line of results/runs/<setup>-r<repeat>.jsonl. */
export type EvalRecord = {
  question_id: string;
  setup_id: string;
  repeat: number;
  run: Run;
};

/** One line of results/grades/<setup>-r<repeat>.jsonl. Code metrics plus the judge's reading of one record. */
export type Grade = {
  question_id: string;
  setup_id: string;
  repeat: number;
  /** What the agent did. "error" when it produced no valid answer. */
  behaviour: AnswerStatus | "error";
  behaviour_correct: boolean;
  /** Null when the question has no gold sources. */
  retrieval_hit: boolean | null;
  points: { point: string; present: boolean }[];
  must_not_say_hits: string[];
  contradiction: boolean;
  /** 0 to 1. See eval/rubric.md. */
  correctness: number;
  /** The judge's verdict on each claim shown to the user. */
  claims: { claim_index: number; verdict: Verdict; reason: string }[];
  total_claims: number;
  /** Claims that fail the quote check or that the judge marked not_supported. */
  unsupported_claims: number;
  judge_usage: Usage;
  judge_error?: string;
};

/** One row of the results table. */
export type SetupSummary = {
  setup: Setup;
  repeats: number;
  questions: number;
  /** Mean over repeats, 0 to 1. */
  correctness: number;
  /** Lowest and highest repeat. Equal when there is one repeat. */
  correctness_min: number;
  correctness_max: number;
  unsupported_claim_rate: number;
  unsupported_claim_rate_min: number;
  unsupported_claim_rate_max: number;
  behaviour_accuracy: number;
  retrieval_hit_rate: number;
  cost_per_answer_usd: number;
  latency_p50_s: number;
  latency_p95_s: number;
  claims_shown: number;
  /** Runs that ended without a valid answer. */
  errors: number;
  /** Totals from the verification records. All zero when the verifier is off. */
  dropped_by_quote_check: number;
  dropped_by_verifier: number;
  repairs_ran: number;
};

/** results/summary.json. The README table, the chart and the Results view are all built from it. */
export type EvalSummary = {
  generated_at: string;
  gold_set: { questions: number; verified: number; by_category: Record<string, number> };
  judge_model: string;
  verifier_model: string;
  setups: SetupSummary[];
  frontier: {
    /** Setup IDs where no other setup is both cheaper and more accurate. */
    pareto: string[];
    most_accurate: string | null;
    cheapest_accurate: string | null;
    /** Cost of the most accurate setup divided by the cost of the cheapest accurate one. */
    cost_ratio: number | null;
  };
  per_question: {
    question_id: string;
    category: Category;
    setup_id: string;
    /** Mean over repeats. */
    correctness: number;
    behaviour_correct: boolean;
    unsupported_claims: number;
    total_claims: number;
  }[];
  /** Answering, verifier and judge cost of every run in the summary, at list prices. */
  total_cost_usd: number;
};
