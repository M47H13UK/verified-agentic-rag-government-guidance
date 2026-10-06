// Connects the eval to the real pipeline, the judge model and the database.
// Everything else in `src/eval` takes these as plain functions, which is why the tests can
// run with fakes and never call a model.
import { createAnswerFn } from "../answer";
import { closeDb, getDb } from "../db";
import { loadEnv } from "../env";
import { sdkStructuredCall } from "../llm/structuredCall";
import type { AnswerFn, PassageLookup } from "../types";
import { getPassagesById } from "../tools/readPassage";
import { quoteCheck } from "../verify/quoteCheck";
import type { QuoteCheckFn } from "./grade";
import { makeJudge, type JudgeFn } from "./judge";
import { JUDGE_MODEL } from "./setups";

export type EvalDeps = {
  /** Answers one question with one setup. The same function the command line and the API use. */
  answer: AnswerFn;
  /** One call to the judge model per record. */
  judge: JudgeFn;
  /** Reads passages from the `passages` collection by ID. */
  getPassages: PassageLookup;
  /** The quote check from `src/verify/quoteCheck.ts`. */
  quoteCheck: QuoteCheckFn;
  /** Closes the database connection so the process can exit. */
  close(): Promise<void>;
};

/** Builds the real dependencies. Only the `run`, `grade` and `audit-sample` commands need them. */
export async function createEvalDeps(): Promise<EvalDeps> {
  loadEnv();
  const db = await getDb();
  return {
    answer: createAnswerFn(db),
    judge: makeJudge(sdkStructuredCall, JUDGE_MODEL),
    getPassages: (ids) => getPassagesById(db, ids),
    quoteCheck,
    close: closeDb,
  };
}
