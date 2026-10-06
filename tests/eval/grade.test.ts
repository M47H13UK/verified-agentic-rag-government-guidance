import { describe, expect, it } from "vitest";
import type { PassageLookup } from "../../src/types";
import {
  appendJsonl,
  gradesPath,
  latestByQuestion,
  readJsonl,
  runsPath,
} from "../../src/eval/files";
import {
  gradeFile,
  gradeRecord,
  isUsableGrade,
  matchesGoldSource,
  type QuoteCheckFn,
} from "../../src/eval/grade";
import type { JudgeFn, JudgeOutput, JudgeResult } from "../../src/eval/judge";
import type { Grade } from "../../src/eval/types";
import type { Passage } from "../../src/types";
import { samplePassages } from "../helpers/fixtures";
import {
  allGoodJudgeOutput,
  H0,
  makeAnswer,
  makeDraft,
  makeQuestion,
  makeRecord,
  makeRun,
  tempDir,
  usage,
} from "./builders";

const noPassages = new Map<string, Passage>();

/** A quote check that passes every claim. */
const quotesAllFine: QuoteCheckFn = () => [];

function judged(output: JudgeOutput): JudgeResult {
  return { output, usage: usage(0.05) };
}

/** What the judge returns when its call was skipped. */
const judgeSkipped: JudgeResult = {
  output: { points: [], must_not_say_hits: [], contradiction: false, claims: [] },
  usage: usage(0),
};

const fourPoints = makeQuestion({
  expected_points: ["Point one.", "Point two.", "Point three.", "Point four."],
  must_not_say: ["You can extend a Graduate visa."],
});

describe("matchesGoldSource", () => {
  it("matches a page path and a page path with a part", () => {
    expect(matchesGoldSource("/graduate-visa#overview#2", "/graduate-visa")).toBe(true);
    expect(matchesGoldSource("/graduate-visa#overview#2", "/graduate-visa/overview")).toBe(true);
    expect(matchesGoldSource("/graduate-visa#overview#2", "/graduate-visa/apply")).toBe(false);
    expect(matchesGoldSource("/graduate-visa#overview#2", "/student-visa")).toBe(false);
  });
});

describe("gradeRecord, answer questions", () => {
  const answer = makeAnswer(["Claim A.", "Claim B.", "Claim C."]);
  const record = makeRecord(H0, fourPoints, answer);

  it("scores 0.75 when 3 of 4 expected points are present", () => {
    const output = allGoodJudgeOutput(fourPoints, answer);
    output.points[3]!.present = false;

    const grade = gradeRecord(record, fourPoints, judged(output), noPassages, quotesAllFine);

    expect(grade.behaviour).toBe("answered");
    expect(grade.behaviour_correct).toBe(true);
    expect(grade.correctness).toBe(0.75);
    expect(grade.points).toEqual([
      { point: "Point one.", present: true },
      { point: "Point two.", present: true },
      { point: "Point three.", present: true },
      { point: "Point four.", present: false },
    ]);
    expect(grade.judge_usage.costUsd).toBe(0.05);
  });

  it("scores 0 when the answer says something it must not say", () => {
    const output = allGoodJudgeOutput(fourPoints, answer);
    output.must_not_say_hits = [0];

    const grade = gradeRecord(record, fourPoints, judged(output), noPassages, quotesAllFine);

    expect(grade.must_not_say_hits).toEqual(["You can extend a Graduate visa."]);
    expect(grade.correctness).toBe(0);
  });

  it("scores 0 when the answer contradicts an expected point", () => {
    const output = allGoodJudgeOutput(fourPoints, answer);
    output.contradiction = true;

    const grade = gradeRecord(record, fourPoints, judged(output), noPassages, quotesAllFine);
    expect(grade.correctness).toBe(0);
  });

  it("scores 0 when the agent declined a question it should have answered", () => {
    const declined = makeAnswer([], { status: "declined", declined_reason: "Not covered." });
    const declinedRecord = makeRecord(H0, fourPoints, declined);
    const output = allGoodJudgeOutput(fourPoints, declined);

    const grade = gradeRecord(
      declinedRecord,
      fourPoints,
      judged(output),
      noPassages,
      quotesAllFine,
    );

    expect(grade.behaviour).toBe("declined");
    expect(grade.behaviour_correct).toBe(false);
    expect(grade.correctness).toBe(0);
  });

  it("grades a run with no answer as an error that scores 0", () => {
    const failed = makeRecord(H0, fourPoints, null);
    const grade = gradeRecord(failed, fourPoints, judgeSkipped, noPassages, quotesAllFine);

    expect(grade.behaviour).toBe("error");
    expect(grade.behaviour_correct).toBe(false);
    expect(grade.correctness).toBe(0);
    expect(grade.total_claims).toBe(0);
    expect(grade.points.every((point) => !point.present)).toBe(true);
  });
});

describe("gradeRecord, decline and clarify questions", () => {
  const declineQuestion = makeQuestion({
    category: "not_covered",
    expected_behaviour: "decline",
    expected_points: [],
    gold_sources: [],
  });
  const clarifyQuestion = makeQuestion({
    category: "ambiguous",
    expected_behaviour: "clarify",
    expected_points: [],
    gold_sources: [],
  });
  const declined = makeAnswer([], { status: "declined", declined_reason: "Not covered." });
  const asked = makeAnswer([], {
    status: "needs_clarification",
    clarifying_question: "Which visa do you hold?",
  });

  it("scores 1 when the agent declines a question it should decline", () => {
    const record = makeRecord(H0, declineQuestion, declined);
    const grade = gradeRecord(record, declineQuestion, judgeSkipped, noPassages, quotesAllFine);

    expect(grade.behaviour_correct).toBe(true);
    expect(grade.correctness).toBe(1);
    // With no gold sources there was nothing to retrieve.
    expect(grade.retrieval_hit).toBeNull();
  });

  it("scores 0 when the agent answers a question it should decline", () => {
    const answer = makeAnswer(["A confident claim."]);
    const record = makeRecord(H0, declineQuestion, answer);
    const output = allGoodJudgeOutput(declineQuestion, answer);

    const grade = gradeRecord(record, declineQuestion, judged(output), noPassages, quotesAllFine);

    expect(grade.behaviour_correct).toBe(false);
    expect(grade.correctness).toBe(0);
    expect(grade.total_claims).toBe(1);
  });

  it("scores 1 for asking and 0 for declining when the question needs clarifying", () => {
    const right = makeRecord(H0, clarifyQuestion, asked);
    const wrong = makeRecord(H0, clarifyQuestion, declined);

    expect(
      gradeRecord(right, clarifyQuestion, judgeSkipped, noPassages, quotesAllFine).correctness,
    ).toBe(1);
    expect(
      gradeRecord(wrong, clarifyQuestion, judgeSkipped, noPassages, quotesAllFine).correctness,
    ).toBe(0);
  });

  it("scores an error as 0, so a run that crashes never passes for a correct decline", () => {
    const failed = makeRecord(H0, declineQuestion, null);
    const grade = gradeRecord(failed, declineQuestion, judgeSkipped, noPassages, quotesAllFine);
    expect(grade.correctness).toBe(0);
  });
});

describe("gradeRecord, unsupported claims", () => {
  const question = makeQuestion();
  const answer = makeAnswer(["Claim A.", "Claim B.", "Claim C."]);
  const record = makeRecord(H0, question, answer);

  it("counts 1 of 3 when the judge marks one claim not_supported", () => {
    const output = allGoodJudgeOutput(question, answer);
    output.claims[1]!.verdict = "not_supported";
    // A partly supported claim is not counted as unsupported.
    output.claims[2]!.verdict = "partially_supported";

    const grade = gradeRecord(record, question, judged(output), noPassages, quotesAllFine);

    expect(grade.total_claims).toBe(3);
    expect(grade.unsupported_claims).toBe(1);
    expect(grade.claims.map((claim) => claim.verdict)).toEqual([
      "supported",
      "not_supported",
      "partially_supported",
    ]);
  });

  it("counts a claim that fails the quote check even when the judge accepts it", () => {
    const failsClaimZero: QuoteCheckFn = () => [
      {
        claim_index: 0,
        verdict: "not_supported",
        reason: "The quote is not in the passage.",
        checked_by: "quote_check",
      },
    ];
    const output = allGoodJudgeOutput(question, answer);

    const grade = gradeRecord(record, question, judged(output), noPassages, failsClaimZero);
    expect(grade.unsupported_claims).toBe(1);
  });

  it("counts a claim once when it fails both checks", () => {
    const failsClaimZero: QuoteCheckFn = () => [
      { claim_index: 0, verdict: "not_supported", reason: "No.", checked_by: "quote_check" },
    ];
    const output = allGoodJudgeOutput(question, answer);
    output.claims[0]!.verdict = "not_supported";

    const grade = gradeRecord(record, question, judged(output), noPassages, failsClaimZero);
    expect(grade.unsupported_claims).toBe(1);
  });
});

describe("gradeRecord, retrieval hit", () => {
  const answer = makeAnswer();

  /** A record whose draft trace returned these passages. */
  function recordThatFound(passageIds: string[], goldSources: string[]) {
    const question = makeQuestion({ gold_sources: goldSources });
    const run = makeRun(H0, question.question, answer, { draft: makeDraft(answer, passageIds) });
    const record = makeRecord(H0, question, answer, { run });
    const output = allGoodJudgeOutput(question, answer);
    return gradeRecord(record, question, judged(output), noPassages, quotesAllFine);
  }

  it("is a hit when a tool call returned a passage from a gold source", () => {
    const grade = recordThatFound(
      ["/student-visa#overview#1", "/graduate-visa#how-much-it-costs#1"],
      ["/graduate-visa/how-much-it-costs"],
    );
    expect(grade.retrieval_hit).toBe(true);
  });

  it("is a miss when no returned passage comes from a gold source", () => {
    const grade = recordThatFound(["/student-visa#overview#1"], ["/graduate-visa"]);
    expect(grade.retrieval_hit).toBe(false);
  });
});

describe("gradeFile", () => {
  const passages = samplePassages();
  const getPassages: PassageLookup = async (ids) =>
    new Map(passages.filter((p) => ids.includes(p._id)).map((p) => [p._id, p]));

  /** A fake judge that approves everything and counts its calls. */
  function fakeJudge(): { judge: JudgeFn; calls: string[] } {
    const calls: string[] = [];
    const judge: JudgeFn = async (question, run) => {
      // Like the real judge, it makes no call for a run with no answer.
      if (!run.final_answer) return judgeSkipped;
      calls.push(question.id);
      return judged(allGoodJudgeOutput(question, run.final_answer));
    };
    return { judge, calls };
  }

  function setUp() {
    const outDir = tempDir();
    const questions = [makeQuestion({ id: "q01" }), makeQuestion({ id: "q02" })];
    for (const question of questions) {
      appendJsonl(runsPath(outDir, "H0", 1), makeRecord(H0, question, makeAnswer()));
    }
    const options = {
      setupId: "H0",
      repeat: 1,
      questions,
      outDir,
      getPassages,
      quoteCheck: quotesAllFine,
    };
    return { outDir, questions, options };
  }

  it("writes one grade per record and skips them on the next call", async () => {
    const { outDir, options } = setUp();
    const { judge, calls } = fakeJudge();

    const first = await gradeFile({ ...options, judge });
    expect(first).toEqual({ graded: 2, judge_errors: 0, skipped: 0 });

    const second = await gradeFile({ ...options, judge });
    expect(second).toEqual({ graded: 0, judge_errors: 0, skipped: 2 });
    expect(calls.sort()).toEqual(["q01", "q02"]);

    const grades = readJsonl<Grade>(gradesPath(outDir, "H0", 1));
    expect(grades).toHaveLength(2);
    expect(grades.every((grade) => grade.correctness === 1)).toBe(true);
  });

  it("judges a record again when its grade has a judge error", async () => {
    const { outDir, options } = setUp();
    const failsOnce: JudgeFn = async () => ({ output: null, usage: usage(0), error: "overloaded" });

    const first = await gradeFile({ ...options, judge: failsOnce });
    expect(first).toEqual({ graded: 2, judge_errors: 2, skipped: 0 });

    const { judge } = fakeJudge();
    const second = await gradeFile({ ...options, judge });
    expect(second).toEqual({ graded: 2, judge_errors: 0, skipped: 0 });

    // The newest grade of each question is the good one.
    const latest = latestByQuestion(readJsonl<Grade>(gradesPath(outDir, "H0", 1)));
    expect([...latest.values()].every((grade) => !grade.judge_error)).toBe(true);
  });

  it("grades a record again after its failed run was run again", async () => {
    const { outDir, questions, options } = setUp();
    const { judge } = fakeJudge();
    const q03 = makeQuestion({ id: "q03" });
    const withQ03 = { ...options, questions: [...questions, q03], judge };

    // q03 first fails, and is graded as an error.
    appendJsonl(runsPath(outDir, "H0", 1), makeRecord(H0, q03, null));
    await gradeFile(withQ03);
    const before = latestByQuestion(readJsonl<Grade>(gradesPath(outDir, "H0", 1))).get("q03")!;
    expect(before.behaviour).toBe("error");

    // The run is retried and works. The old grade no longer describes it.
    const retried = makeRecord(H0, q03, makeAnswer());
    appendJsonl(runsPath(outDir, "H0", 1), retried);
    expect(isUsableGrade(before, retried)).toBe(false);

    await gradeFile(withQ03);
    const after = latestByQuestion(readJsonl<Grade>(gradesPath(outDir, "H0", 1))).get("q03")!;
    expect(after.behaviour).toBe("answered");
    expect(after.correctness).toBe(1);
  });
});
