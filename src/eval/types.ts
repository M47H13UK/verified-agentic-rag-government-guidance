// Types for the eval gold set. The types for runs, grades and the summary are added by a later step.

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
