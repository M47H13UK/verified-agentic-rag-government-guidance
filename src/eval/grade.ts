// Grading. Turns one run plus the judge's reading of it into a Grade, using plain code.
// The rules are written down in `eval/rubric.md`.
import type { AnswerStatus, ClaimVerdict, Passage, Run, StructuredAnswer } from "../types";
import type { PassageLookup } from "../types";
import {
  appendJsonl,
  dropPartialLastLine,
  gradesPath,
  latestByQuestion,
  readJsonl,
  runsPath,
} from "./files";
import { citedPassageIds, type JudgeFn, type JudgeResult } from "./judge";
import { assertSameWording, runPool } from "./run";
import type { EvalRecord, GoldQuestion, Grade } from "./types";

/**
 * The quote check from `src/verify/quoteCheck.ts`. It is passed in, so this file does not
 * depend on it. A claim fails the check when it gets any verdict other than "supported".
 */
export type QuoteCheckFn = (
  answer: StructuredAnswer,
  passages: Map<string, Passage>,
) => ClaimVerdict[];

/** The status that counts as correct behaviour for each kind of question. */
const EXPECTED_STATUS: Record<GoldQuestion["expected_behaviour"], AnswerStatus> = {
  answer: "answered",
  decline: "declined",
  clarify: "needs_clarification",
};

/** What the agent did. A run with no final answer is an "error", which matches no question. */
export function behaviourOf(run: Run): Grade["behaviour"] {
  return run.final_answer ? run.final_answer.status : "error";
}

/**
 * True when a passage comes from a gold source.
 * A gold source is a page path such as "/graduate-visa", or a page path plus a part such as
 * "/graduate-visa/how-much-it-costs". A passage ID is "<base_path>#<part_slug>#<n>".
 */
export function matchesGoldSource(passageId: string, goldSource: string): boolean {
  const [basePath, partSlug] = passageId.split("#");
  return goldSource === basePath || goldSource === `${basePath}/${partSlug}`;
}

/**
 * True when any tool call of the draft returned a passage from a gold source.
 * Null when the question has no gold sources, because there was nothing to find.
 */
export function retrievalHit(run: Run, goldSources: string[]): boolean | null {
  if (goldSources.length === 0) return null;
  const seen = run.draft.trace.flatMap((call) => call.passage_ids);
  return seen.some((id) => goldSources.some((source) => matchesGoldSource(id, source)));
}

/**
 * The correctness score of one answer, from 0 to 1.
 * A decline or clarify question scores 1 when the behaviour matches and 0 when it does not.
 * An answer question scores the share of expected points that are present. It scores 0 when
 * the agent did not answer, said something it must not say, or contradicted a point.
 */
export function scoreCorrectness(
  question: GoldQuestion,
  behaviourCorrect: boolean,
  points: Grade["points"],
  mustNotSayHits: string[],
  contradiction: boolean,
): number {
  if (question.expected_behaviour !== "answer") return behaviourCorrect ? 1 : 0;
  if (!behaviourCorrect) return 0;
  if (mustNotSayHits.length > 0 || contradiction) return 0;
  // The loader rejects an answer question with no points, so this guard only stops a division by 0.
  if (points.length === 0) return 0;
  return points.filter((point) => point.present).length / points.length;
}

/**
 * Builds the grade for one record. Pure code, no model call.
 * `judged` is what the judge returned for this record and `passages` holds the passages the
 * final answer cites.
 */
export function gradeRecord(
  record: EvalRecord,
  question: GoldQuestion,
  judged: JudgeResult,
  passages: Map<string, Passage>,
  quoteCheck: QuoteCheckFn,
): Grade {
  const answer = record.run.final_answer;
  const output = judged.output;
  const behaviour = behaviourOf(record.run);
  const behaviourCorrect = behaviour === EXPECTED_STATUS[question.expected_behaviour];

  // The judge names points and statements by number. Turn the numbers back into text.
  const presentNumbers = new Set(
    (output?.points ?? []).filter((point) => point.present).map((point) => point.index),
  );
  const points = question.expected_points.map((point, index) => ({
    point,
    present: presentNumbers.has(index),
  }));
  const hitNumbers = new Set(output?.must_not_say_hits ?? []);
  const mustNotSayHits = question.must_not_say.filter((_, index) => hitNumbers.has(index));
  const contradiction = output?.contradiction ?? false;

  const claims = (output?.claims ?? [])
    .map((claim) => ({
      claim_index: claim.claim_index,
      verdict: claim.verdict,
      reason: claim.reason,
    }))
    .sort((a, b) => a.claim_index - b.claim_index);

  // A claim is unsupported when it fails the quote check or the judge says not_supported.
  // Going through the claims one by one counts a claim that fails both only once.
  const totalClaims = answer ? answer.claims.length : 0;
  const quoteVerdicts = answer && totalClaims > 0 ? quoteCheck(answer, passages) : [];
  const failedQuoteCheck = new Set(
    quoteVerdicts.filter((v) => v.verdict !== "supported").map((v) => v.claim_index),
  );
  const judgedUnsupported = new Set(
    claims.filter((claim) => claim.verdict === "not_supported").map((claim) => claim.claim_index),
  );
  let unsupportedClaims = 0;
  for (let index = 0; index < totalClaims; index += 1) {
    if (failedQuoteCheck.has(index) || judgedUnsupported.has(index)) unsupportedClaims += 1;
  }

  const grade: Grade = {
    question_id: record.question_id,
    setup_id: record.setup_id,
    repeat: record.repeat,
    behaviour,
    behaviour_correct: behaviourCorrect,
    retrieval_hit: retrievalHit(record.run, question.gold_sources),
    points,
    must_not_say_hits: mustNotSayHits,
    contradiction,
    correctness: scoreCorrectness(
      question,
      behaviourCorrect,
      points,
      mustNotSayHits,
      contradiction,
    ),
    claims,
    total_claims: totalClaims,
    unsupported_claims: unsupportedClaims,
    judge_usage: judged.usage,
  };
  if (judged.error) grade.judge_error = judged.error;
  return grade;
}

/**
 * True when a grade can be used for this record.
 * A grade with a judge error holds no real reading. A grade whose behaviour differs from the
 * record was written before a failed run was run again, so it describes the old run.
 */
export function isUsableGrade(grade: Grade | undefined, record: EvalRecord): grade is Grade {
  if (!grade || grade.judge_error) return false;
  return grade.behaviour === behaviourOf(record.run);
}

export type GradeFileOptions = {
  setupId: string;
  repeat: number;
  /** Records for questions that are not in this list are left alone. */
  questions: GoldQuestion[];
  outDir: string;
  judge: JudgeFn;
  getPassages: PassageLookup;
  quoteCheck: QuoteCheckFn;
  /** How many judge calls are under way at once. Default 4. */
  concurrency?: number;
  onProgress?: (progress: {
    done: number;
    total: number;
    question_id: string;
    ok: boolean;
  }) => void;
};

export type GradeFileResult = {
  /** Grades written in this session, judge errors included. */
  graded: number;
  judge_errors: number;
  /** Records that already had a usable grade. */
  skipped: number;
};

/**
 * Grades the runs of one setup and one repeat and writes `<outDir>/grades/<setup>-r<repeat>.jsonl`.
 * It follows the same resume rule as the runner. Each grade is added to the file as it
 * finishes, a record that already has a usable grade is skipped, and a grade with a judge
 * error is not counted as done.
 */
export async function gradeFile(options: GradeFileOptions): Promise<GradeFileResult> {
  const { setupId, repeat, outDir, judge, getPassages, quoteCheck, onProgress } = options;
  const questionById = new Map(options.questions.map((question) => [question.id, question]));

  const recordsPath = runsPath(outDir, setupId, repeat);
  const records = [...latestByQuestion(readJsonl<EvalRecord>(recordsPath)).values()].filter(
    (record) => questionById.has(record.question_id),
  );
  for (const record of records) {
    assertSameWording(record, questionById.get(record.question_id)!, recordsPath);
  }

  const path = gradesPath(outDir, setupId, repeat);
  dropPartialLastLine(path);
  const grades = latestByQuestion(readJsonl<Grade>(path));

  const pending = records.filter((record) => {
    const grade = grades.get(record.question_id);
    if (!isUsableGrade(grade, record)) return true;
    // A run with no answer is graded without a judge call, so its grade is free to make again.
    // Doing so every time means its grade can never be left over from an earlier failed run.
    return grade.behaviour === "error";
  });

  let done = 0;
  let judgeErrors = 0;

  await runPool(pending, options.concurrency ?? 4, async (record) => {
    const question = questionById.get(record.question_id)!;
    const answer = record.run.final_answer;
    const ids = answer ? citedPassageIds(answer) : [];
    const passages = ids.length > 0 ? await getPassages(ids) : new Map<string, Passage>();

    const judged = await judge(question, record.run, passages);
    const grade = gradeRecord(record, question, judged, passages, quoteCheck);
    appendJsonl(path, grade);

    done += 1;
    if (grade.judge_error) judgeErrors += 1;
    onProgress?.({
      done,
      total: pending.length,
      question_id: record.question_id,
      ok: !grade.judge_error,
    });

    if (grade.judge_error) return { ok: false, error: grade.judge_error };
    return { ok: true };
  });

  return { graded: done, judge_errors: judgeErrors, skipped: records.length - pending.length };
}
