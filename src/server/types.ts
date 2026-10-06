// Types for the API. The web page imports the response shapes from here with `import type`,
// so the server and the page cannot disagree about what a response looks like.
import type { EvalSummary } from "../eval/types";
import type { AnswerFn, PassageLookup, Run, Setup } from "../types";

/**
 * Everything the API needs from the outside.
 * The real server and the mock server each build one, and tests pass fakes.
 */
export type ServerDeps = {
  answer: AnswerFn;
  getRun(id: string): Promise<Run | null>;
  saveRun(run: Run): Promise<void>;
  getPassages: PassageLookup;
  /** Null when the eval has not produced a summary yet. */
  readSummary(): Promise<EvalSummary | null>;
  /** The setups offered in the dropdown. */
  setups: Setup[];
  /** True when the answers and numbers are canned. The page shows a banner. */
  mock: boolean;
};

/** The parts of a passage the page shows next to a quote. The passage text is left out. */
export type CitedPassage = {
  id: string;
  title: string;
  heading_path: string;
  url: string;
  /** ISO 8601. */
  updated: string;
};

/** Body of POST /api/ask and GET /api/runs/:id. */
export type RunResponse = {
  run: Run;
  /** The passages cited by `run.final_answer`. */
  passages: CitedPassage[];
};

/** Body of GET /api/setups. */
export type SetupsResponse = {
  setups: Setup[];
  mock: boolean;
};

/** Body of every response with an error status. */
export type ErrorResponse = {
  error: string;
};
