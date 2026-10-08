import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AnswerFn, PassageLookup } from "../../src/types";
import { appendJsonl, gradesPath, runsPath } from "../../src/eval/files";
import { gradeFile, type QuoteCheckFn } from "../../src/eval/grade";
import type { JudgeFn } from "../../src/eval/judge";
import { writeReport } from "../../src/eval/report";
import { runEval } from "../../src/eval/run";
import { getSetups } from "../../src/eval/setups";
import type { EvalSummary, GoldQuestion } from "../../src/eval/types";
import {
  allGoodJudgeOutput,
  makeAnswer,
  makeGrade,
  makeQuestion,
  makeRecord,
  makeRun,
  tempDir,
  usage,
} from "./builders";

const setups = getSetups(["H0", "S0"]);
const H0 = setups[0]!;
const S0 = setups[1]!;

const questions: GoldQuestion[] = [
  makeQuestion({ id: "q01", question: "How long does a Graduate visa last?" }),
  makeQuestion({ id: "q02", question: "How much does a Graduate visa cost?" }),
  makeQuestion({
    id: "q03",
    question: "Will my application be approved?",
    category: "personal_judgement",
    expected_behaviour: "decline",
    expected_points: [],
    gold_sources: [],
  }),
];

/**
 * A fake pipeline with one setup that always gets it right and one that never tries.
 * H0 answers what should be answered and declines what should be declined.
 * S0 declines everything, and costs twice as much.
 */
const answer: AnswerFn = async (question, setup) => {
  const shouldDecline = question === "Will my application be approved?";
  if (setup.id === "S0" || shouldDecline) {
    const declined = makeAnswer([], { status: "declined", declined_reason: "I cannot say." });
    const cost = setup.id === "S0" ? 0.02 : 0.01;
    return makeRun(setup, question, declined, { total_usage: usage(cost) });
  }
  return makeRun(setup, question, makeAnswer(["Claim A.", "Claim B."]));
};

/** A fake judge that finds every point in an answer and no point in a refusal. */
const judge: JudgeFn = async (question, run) => {
  const final = run.final_answer;
  // Like the real judge, it makes no call for a run with no answer.
  if (!final) return { output: allGoodJudgeOutput(question, makeAnswer([])), usage: usage(0) };
  const output = allGoodJudgeOutput(question, final);
  if (final.status !== "answered") output.points.forEach((point) => (point.present = false));
  return { output, usage: usage(0.05) };
};

const getPassages: PassageLookup = async () => new Map();
const quoteCheck: QuoteCheckFn = () => [];
const now = new Date("2026-10-06T12:00:00.000Z");

/** Runs, grades and reports with the fakes above, all inside one temp folder. */
async function runGradeReport(gold: GoldQuestion[]) {
  const outDir = tempDir();
  await runEval({ questions: gold, setups, repeat: 1, answer, outDir });
  for (const setup of setups) {
    await gradeFile({
      setupId: setup.id,
      repeat: 1,
      questions: gold,
      outDir,
      judge,
      getPassages,
      quoteCheck,
    });
  }
  const report = writeReport({ questions: gold, outDir, now });
  const read = (name: string): string => readFileSync(join(outDir, name), "utf8");
  return { outDir, report, read };
}

describe("run, grade and report, end to end with fakes", () => {
  it("scores the setup that is always right at 1 and the one that never tries at one third", async () => {
    const { read } = await runGradeReport(questions);
    const summary = JSON.parse(read("summary.json")) as EvalSummary;

    const [h0, s0] = summary.setups;
    expect(h0!.setup.id).toBe("H0");
    expect(h0!.correctness).toBe(1);
    expect(h0!.behaviour_accuracy).toBe(1);
    expect(h0!.claims_shown).toBe(4);
    expect(h0!.unsupported_claim_rate).toBe(0);

    // S0 declines everything. That is right for q03 only.
    expect(s0!.setup.id).toBe("S0");
    expect(s0!.correctness).toBeCloseTo(1 / 3);
    expect(s0!.behaviour_accuracy).toBeCloseTo(1 / 3);
    expect(s0!.claims_shown).toBe(0);
  });

  it("fills in the rest of summary.json", async () => {
    const { read } = await runGradeReport(questions);
    const summary = JSON.parse(read("summary.json")) as EvalSummary;

    expect(summary.generated_at).toBe("2026-10-06T12:00:00.000Z");
    expect(summary.gold_set).toEqual({
      questions: 3,
      verified: 3,
      by_category: { single_page: 2, personal_judgement: 1 },
    });
    expect(summary.judge_model).toBe("claude-opus-5-5");
    expect(summary.verifier_model).toBe("claude-sonnet-5-5");

    // S0 costs more and is less accurate, so H0 is alone on the frontier.
    expect(summary.frontier).toEqual({
      pareto: ["H0"],
      most_accurate: "H0",
      cheapest_accurate: null,
      cost_ratio: null,
    });

    expect(summary.per_question).toHaveLength(6);
    expect(summary.per_question[0]).toEqual({
      question_id: "q01",
      category: "single_page",
      setup_id: "H0",
      correctness: 1,
      behaviour_correct: true,
      unsupported_claims: 0,
      total_claims: 2,
    });

    // Runs cost 3 x 0.01 for H0 and 3 x 0.02 for S0. The judge cost 0.05 for each of 6 grades.
    expect(summary.total_cost_usd).toBeCloseTo(0.03 + 0.06 + 0.3);
  });

  it("writes the table, the cost line and the judge agreement line to summary.md", async () => {
    const { read } = await runGradeReport(questions);
    const table = read("summary.md");

    expect(table.startsWith("# Eval results")).toBe(true);
    expect(table).toContain("| H0 | `claude-haiku-4-5` | default | off | 3 | 1 | 100.0% | 0.0% |");
    expect(table).toContain("| S0 | `claude-sonnet-5-5` | default | off | 3 | 1 | 33.3% |");
    expect(table).toContain("cost $0.39 in total at list prices");
    expect(table).toContain("How often the judge agrees with a person is reported separately.");
  });

  it("writes every setup, the frontier and the rule to frontier.md", async () => {
    const { read } = await runGradeReport(questions);
    const frontier = read("frontier.md");

    expect(frontier).toContain("| H0 | 100.0% | 0.0% | $0.0100 | yes |");
    expect(frontier).toContain("| S0 | 33.3% | 0.0% | $0.0200 | no |");
    expect(frontier).toContain("The most accurate setup is H0");
    expect(frontier).toContain(
      "1. The most accurate setup is the one with the highest correctness.",
    );
  });

  it("starts both reports with a warning when a question has not been checked by hand", async () => {
    const unverified = [
      questions[0]!,
      { ...questions[1]!, verified_by: null, verified_on: null },
      questions[2]!,
    ];
    const { report, read } = await runGradeReport(unverified);

    const warning =
      "**Warning. The gold set is not fully verified, so these numbers are not final.";
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("the number not yet checked by hand is 1");
    expect(read("summary.md").startsWith(warning)).toBe(true);
    expect(read("frontier.md").startsWith(warning)).toBe(true);
  });
});

describe("writeReport", () => {
  it("leaves out runs that have no grade and says how many", async () => {
    const { outDir } = await runGradeReport(questions.slice(0, 2));
    // A third run arrives after grading, so it has no grade yet.
    appendJsonl(runsPath(outDir, "H0", 1), makeRecord(H0, questions[2]!, makeAnswer()));

    const report = writeReport({ questions, outDir, now });

    expect(report.summary.setups[0]!.questions).toBe(2);
    expect(report.warnings.some((w) => w.includes("no usable grade is 1"))).toBe(true);
    // H0 now covers 2 graded questions and S0 covers 2, so the rows still compare.
    expect(report.warnings.some((w) => w.includes("cannot be compared"))).toBe(false);
  });

  it("leaves out a run whose newest grade has a judge error", async () => {
    const { outDir } = await runGradeReport(questions);
    const failedGrade = makeGrade({
      question_id: "q01",
      setup_id: "S0",
      judge_error: "overloaded",
    });
    appendJsonl(gradesPath(outDir, "S0", 1), failedGrade);

    const report = writeReport({ questions, outDir, now });

    const s0 = report.summary.setups.find((setup) => setup.setup.id === "S0")!;
    expect(s0.questions).toBe(2);
    expect(report.warnings.some((w) => w.includes("no usable grade is 1"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("cannot be compared"))).toBe(true);
  });

  it("warns when runs ended without an answer", async () => {
    const outDir = tempDir();
    const failing: AnswerFn = async (question, setup) =>
      question === questions[0]!.question
        ? makeRun(setup, question, null)
        : makeRun(setup, question, makeAnswer());
    await runEval({ questions, setups: [S0], repeat: 1, answer: failing, outDir });
    await gradeFile({
      setupId: "S0",
      repeat: 1,
      questions,
      outDir,
      judge,
      getPassages,
      quoteCheck,
    });

    const report = writeReport({ questions, outDir, now });

    expect(report.summary.setups[0]!.errors).toBe(1);
    expect(report.warnings.some((w) => w.includes("ended without an answer is 1"))).toBe(true);
  });

  it("adds the judge audit to the summary and the table once the sheet is scored", async () => {
    const { outDir } = await runGradeReport(questions);
    expect(writeReport({ questions, outDir, now }).summary.judge_audit).toBeNull();

    const audit = {
      labelled: 4,
      unlabelled: 1,
      agreed: 3,
      agreement_rate: 0.75,
      claims: { labelled: 2, agreed: 2 },
      answers: { labelled: 2, agreed: 1 },
      disagreements: [],
    };
    const report = writeReport({ questions, outDir, now, audit });

    expect(report.summary.judge_audit).toEqual({
      labelled: 4,
      agreed: 3,
      agreement_rate: 0.75,
      claims: { labelled: 2, agreed: 2 },
      answers: { labelled: 2, agreed: 1 },
    });
    const table = readFileSync(join(outDir, "summary.md"), "utf8");
    expect(table).toContain("The judge gave the same label on 3 of them, which is 75.0%.");
    expect(table).toContain("That is 2 of 2 claims and 1 of 2 answers.");
    expect(table).not.toContain("reported separately");
  });

  it("treats an audit sheet with no labels as not done", async () => {
    const { outDir } = await runGradeReport(questions);
    const audit = {
      labelled: 0,
      unlabelled: 5,
      agreed: 0,
      agreement_rate: null,
      claims: { labelled: 0, agreed: 0 },
      answers: { labelled: 0, agreed: 0 },
      disagreements: [],
    };

    const report = writeReport({ questions, outDir, now, audit });

    expect(report.summary.judge_audit).toBeNull();
  });

  it("adds a note, not a warning, when only some setups ran a second repeat", async () => {
    const { outDir } = await runGradeReport(questions);
    // Pass 2 repeats one setup only.
    await runEval({ questions, setups: [H0], repeat: 2, answer, outDir });
    await gradeFile({
      setupId: "H0",
      repeat: 2,
      questions,
      outDir,
      judge,
      getPassages,
      quoteCheck,
    });

    const report = writeReport({ questions, outDir, now });

    expect(report.summary.setups.map((setup) => setup.repeats)).toEqual([2, 1]);
    expect(report.warnings).toEqual([]);
    const table = readFileSync(join(outDir, "summary.md"), "utf8");
    expect(table).toContain("The setups did not all run the same number of repeats");
    expect(table).toContain(
      "| H0 | `claude-haiku-4-5` | default | off | 3 | 2 | 100.0% (100.0% to 100.0%) |",
    );
  });

  it("throws a clear error when there is nothing to report", () => {
    expect(() => writeReport({ questions, outDir: tempDir(), now })).toThrow(/no graded runs/);
  });
});
