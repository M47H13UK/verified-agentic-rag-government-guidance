// The report. Reads the runs and grades and writes the summary, the table and the frontier.
// It makes no model calls, so it is free to run again at any time.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gradesPath, latestByQuestion, listRepeats, readJsonl, runsPath } from "./files";
import { HEADLINE_RULE, paretoFrontier, pickHeadlineSetups } from "./frontier";
import { isUsableGrade } from "./grade";
import { mean, sum, summariseSetup } from "./metrics";
import type { AuditScore } from "./judgeAudit";
import { isVerified } from "./questions";
import { assertSameWording } from "./run";
import { JUDGE_MODEL, SETUPS, VERIFIER_MODEL } from "./setups";
import type {
  EvalRecord,
  EvalSummary,
  GoldQuestion,
  Grade,
  JudgeAuditSummary,
  SetupSummary,
} from "./types";

export type ReportOptions = {
  /** The whole gold set, not only the questions that were run. */
  questions: GoldQuestion[];
  /** The results folder. Reads `runs/` and `grades/` in it and writes the three report files. */
  outDir: string;
  /** Passed in so a test can fix the date. Defaults to the current time. */
  now?: Date;
  /** The scored judge audit, when the sheet exists. Left out, the summary says it is still to do. */
  audit?: AuditScore;
};

export type Report = {
  summary: EvalSummary;
  /** Lines that go at the very top of both Markdown files. */
  warnings: string[];
};

export type GradedRuns = {
  /** `records[i]` and `grades[i]` belong together. */
  records: EvalRecord[];
  grades: Grade[];
  /** Runs with no usable grade. They are in neither list. */
  leftOut: number;
};

/** Reads every run of one setup, across all its repeats, together with its grade. */
export function loadGradedRuns(
  outDir: string,
  setupId: string,
  questions: GoldQuestion[],
): GradedRuns {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const graded: GradedRuns = { records: [], grades: [], leftOut: 0 };

  for (const repeat of listRepeats(outDir, setupId)) {
    const path = runsPath(outDir, setupId, repeat);
    const gradeByQuestion = latestByQuestion(readJsonl<Grade>(gradesPath(outDir, setupId, repeat)));

    for (const record of latestByQuestion(readJsonl<EvalRecord>(path)).values()) {
      const question = questionById.get(record.question_id);
      if (!question) {
        throw new Error(
          `${path} holds a run for question ${record.question_id}, which is not in the questions file.`,
        );
      }
      assertSameWording(record, question, path);

      const grade = gradeByQuestion.get(record.question_id);
      if (isUsableGrade(grade, record)) {
        graded.records.push(record);
        graded.grades.push(grade);
      } else {
        graded.leftOut += 1;
      }
    }
  }
  return graded;
}

/**
 * Builds the summary from the files on disk.
 * A run is counted only when it has a usable grade. The rest are left out and a warning
 * says how many, so a half-graded batch cannot pass for a finished one.
 */
export function buildSummary(options: ReportOptions): Report {
  const { questions, outDir } = options;
  const questionById = new Map(questions.map((question) => [question.id, question]));

  const setups: SetupSummary[] = [];
  const perQuestion: EvalSummary["per_question"] = [];
  const questionsRun = new Set<string>();
  let totalCost = 0;
  let leftOut = 0;

  for (const setup of SETUPS) {
    const graded = loadGradedRuns(outDir, setup.id, questions);
    const { records, grades } = graded;
    leftOut += graded.leftOut;
    if (records.length === 0) continue;

    setups.push(summariseSetup(setup, records, grades));
    totalCost += sum(records.map((record) => record.run.total_usage.costUsd));
    totalCost += sum(grades.map((grade) => grade.judge_usage.costUsd));

    // One row per question, in the order of the questions file.
    for (const question of questions) {
      const ofQuestion = grades.filter((grade) => grade.question_id === question.id);
      if (ofQuestion.length === 0) continue;
      questionsRun.add(question.id);
      perQuestion.push({
        question_id: question.id,
        category: question.category,
        setup_id: setup.id,
        correctness: mean(ofQuestion.map((grade) => grade.correctness)),
        // With repeats, the behaviour counts as correct only when it was correct every time.
        behaviour_correct: ofQuestion.every((grade) => grade.behaviour_correct),
        unsupported_claims: sum(ofQuestion.map((grade) => grade.unsupported_claims)),
        total_claims: sum(ofQuestion.map((grade) => grade.total_claims)),
      });
    }
  }

  if (setups.length === 0) {
    throw new Error(
      `There are no graded runs in ${outDir}. Run the eval and the grade command first.`,
    );
  }

  const byCategory: Record<string, number> = {};
  for (const question of questions) {
    byCategory[question.category] = (byCategory[question.category] ?? 0) + 1;
  }

  const headline = pickHeadlineSetups(setups);
  const summary: EvalSummary = {
    generated_at: (options.now ?? new Date()).toISOString(),
    gold_set: {
      questions: questions.length,
      verified: questions.filter(isVerified).length,
      by_category: byCategory,
    },
    judge_model: JUDGE_MODEL,
    verifier_model: VERIFIER_MODEL,
    setups,
    frontier: {
      pareto: paretoFrontier(setups),
      most_accurate: headline.most_accurate,
      cheapest_accurate: headline.cheapest_accurate,
      cost_ratio: headline.cost_ratio,
    },
    per_question: perQuestion,
    total_cost_usd: totalCost,
    judge_audit: auditSummary(options.audit),
  };

  // ---------- Warnings ----------

  const warnings: string[] = [];
  const unverified = [...questionsRun].filter((id) => !isVerified(questionById.get(id)!));
  if (unverified.length > 0) {
    warnings.push(
      "Warning. The gold set is not fully verified, so these numbers are not final. " +
        `Of the ${questionsRun.size} questions in these runs, the number not yet checked by hand is ${unverified.length}.`,
    );
  }
  if (leftOut > 0) {
    warnings.push(
      `Warning. The number of runs left out because they have no usable grade is ${leftOut}. ` +
        "Run the grade command again.",
    );
  }
  const errors = sum(setups.map((setup) => setup.errors));
  if (errors > 0) {
    warnings.push(
      `Warning. The number of runs that ended without an answer is ${errors}. They score 0. ` +
        "A run that failed for a reason outside the agent, such as a rate limit, is retried when the eval is run again. A run where the agent itself gave no answer is final.",
    );
  }
  // A different number of repeats is not a warning. Extra repeats can be run for some setups
  // only, and the table says so under it.
  if (new Set(setups.map((setup) => setup.questions)).size > 1) {
    warnings.push(
      "Warning. The setups did not all cover the same number of questions, " +
        "so their rows cannot be compared directly.",
    );
  }

  return { summary, warnings };
}

/** The part of the audit score that goes in the summary. Null when nothing is labelled yet. */
function auditSummary(audit: AuditScore | undefined): JudgeAuditSummary | null {
  if (!audit || audit.agreement_rate === null) return null;
  return {
    labelled: audit.labelled,
    agreed: audit.agreed,
    agreement_rate: audit.agreement_rate,
    claims: audit.claims,
    answers: audit.answers,
  };
}

// ---------- Formatting ----------

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function dollars(value: number, digits: number): string {
  return `$${value.toFixed(digits)}`;
}

/** A percentage, followed by the lowest and highest repeat when there is more than one. */
function percentWithRange(value: number, min: number, max: number, repeats: number): string {
  if (repeats <= 1) return percent(value);
  return `${percent(value)} (${percent(min)} to ${percent(max)})`;
}

function tableRow(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

/** The warnings, in bold, as the first lines of a report. */
function warningLines(warnings: string[]): string[] {
  return warnings.flatMap((warning) => [`**${warning}**`, ""]);
}

/** Builds `summary.md`. One row per setup, one column per metric. */
export function renderSummaryMd(summary: EvalSummary, warnings: string[]): string {
  const header = [
    "Setup",
    "Model",
    "Effort",
    "Verifier",
    "Questions",
    "Repeats",
    "Correctness",
    "Unsupported claims",
    "Behaviour accuracy",
    "Retrieval hit rate",
    "Cost per answer",
    "Latency p50",
    "Latency p95",
    "Claims shown",
    "Errors",
    "Dropped by quote check",
    "Dropped by verifier",
    "Repairs",
  ];
  const rows = summary.setups.map((s) =>
    tableRow([
      s.setup.id,
      `\`${s.setup.model}\``,
      s.setup.effort ?? "default",
      s.setup.verifier ? "on" : "off",
      s.questions,
      s.repeats,
      percentWithRange(s.correctness, s.correctness_min, s.correctness_max, s.repeats),
      percentWithRange(
        s.unsupported_claim_rate,
        s.unsupported_claim_rate_min,
        s.unsupported_claim_rate_max,
        s.repeats,
      ),
      percent(s.behaviour_accuracy),
      percent(s.retrieval_hit_rate),
      dollars(s.cost_per_answer_usd, 4),
      `${s.latency_p50_s.toFixed(1)} s`,
      `${s.latency_p95_s.toFixed(1)} s`,
      s.claims_shown,
      s.errors,
      s.dropped_by_quote_check,
      s.dropped_by_verifier,
      s.repairs_ran,
    ]),
  );

  const gold = summary.gold_set;
  return [
    ...warningLines(warnings),
    "# Eval results",
    "",
    `Generated on ${summary.generated_at.slice(0, 10)}. The gold set has ${gold.questions} questions and ${gold.verified} of them have been checked by hand. The judge model is \`${summary.judge_model}\`. The verifier model is \`${summary.verifier_model}\`.`,
    "",
    tableRow(header),
    tableRow(header.map(() => "---")),
    ...rows,
    "",
    "With more than one repeat, correctness and unsupported claims show the mean, then the lowest and the highest repeat in brackets. Every metric is defined in `eval/rubric.md`.",
    ...repeatsNote(summary),
    "",
    `The runs and the judge cost ${dollars(summary.total_cost_usd, 2)} in total at list prices. A draft shared by a verifier-off setup and its verifier-on twin is counted in both, so the amount spent is lower.`,
    "",
    judgeAuditLine(summary.judge_audit),
    "",
  ].join("\n");
}

/** A paragraph for the case where some setups ran more repeats than others. Empty when all ran the same. */
function repeatsNote(summary: EvalSummary): string[] {
  if (new Set(summary.setups.map((setup) => setup.repeats)).size <= 1) return [];
  return [
    "",
    "The setups did not all run the same number of repeats, so only some rows show a range. The Repeats column says how many each row is based on.",
  ];
}

/** One paragraph on how often the judge agreed with a person, or on how to measure it. */
function judgeAuditLine(audit: JudgeAuditSummary | null): string {
  if (!audit) {
    return "How often the judge agrees with a person is reported separately. Label `eval/judge-audit.csv`, then run `npm run eval -- audit-score`.";
  }
  return (
    `A person labelled ${audit.labelled} of the judge's decisions without seeing them. ` +
    `The judge gave the same label on ${audit.agreed} of them, which is ${percent(audit.agreement_rate)}. ` +
    `That is ${audit.claims.agreed} of ${audit.claims.labelled} claims and ${audit.answers.agreed} of ${audit.answers.labelled} answers. ` +
    "The sample is in `eval/judge-audit.csv` and the judge's labels are in `eval/judge-audit-key.json`."
  );
}

/** Builds `frontier.md`. Every setup's cost and correctness, the frontier, and the headline pair. */
export function renderFrontierMd(summary: EvalSummary, warnings: string[]): string {
  const byId = new Map(summary.setups.map((setup) => [setup.setup.id, setup]));
  const header = [
    "Setup",
    "Correctness",
    "Unsupported claims",
    "Cost per answer",
    "On the frontier",
  ];
  const rows = summary.setups.map((s) =>
    tableRow([
      s.setup.id,
      percent(s.correctness),
      percent(s.unsupported_claim_rate),
      dollars(s.cost_per_answer_usd, 4),
      summary.frontier.pareto.includes(s.setup.id) ? "yes" : "no",
    ]),
  );

  const describe = (id: string): string => {
    const s = byId.get(id)!;
    return `${id}, with a correctness of ${percent(s.correctness)} at ${dollars(s.cost_per_answer_usd, 4)} per answer`;
  };

  // Ask the rule again, only to learn whether one setup was both. The summary has no field for it.
  const headline = pickHeadlineSetups(summary.setups);
  const lines: string[] = [];
  if (headline.most_accurate) {
    lines.push(`The most accurate setup is ${describe(headline.most_accurate)}.`);
  }
  if (headline.one_setup_is_both && headline.cheapest_accurate) {
    lines.push(
      `It is also the cheapest accurate setup. By the rule, the second headline setup is the next cheapest one on the frontier, which is ${describe(headline.cheapest_accurate)}.`,
    );
  } else if (headline.one_setup_is_both) {
    lines.push("It is also the cheapest accurate setup, and it is alone on the frontier.");
  } else if (headline.cheapest_accurate) {
    lines.push(`The cheapest accurate setup is ${describe(headline.cheapest_accurate)}.`);
  }
  if (headline.most_accurate && headline.cheapest_accurate && headline.cost_ratio !== null) {
    lines.push(
      `${headline.most_accurate} costs ${headline.cost_ratio.toFixed(1)} times as much per answer as ${headline.cheapest_accurate}.`,
    );
  }

  return [
    ...warningLines(warnings),
    "# Cost and correctness frontier",
    "",
    tableRow(header),
    tableRow(header.map(() => "---")),
    ...rows,
    "",
    `A setup is on the frontier when no other setup is both cheaper and more accurate. From cheapest to most expensive, the frontier is ${summary.frontier.pareto.join(", ")}.`,
    "",
    "## Headline setups",
    "",
    lines.join(" "),
    "",
    "## The rule",
    "",
    "The rule was fixed before any results existed. It is written down in `eval/rubric.md`.",
    "",
    ...HEADLINE_RULE.map((line, index) => `${index + 1}. ${line}`),
    "",
  ].join("\n");
}

/** Writes `summary.json`, `summary.md` and `frontier.md` into the results folder. */
export function writeReport(options: ReportOptions): Report {
  const report = buildSummary(options);
  mkdirSync(options.outDir, { recursive: true });
  writeFileSync(
    join(options.outDir, "summary.json"),
    JSON.stringify(report.summary, null, 2) + "\n",
  );
  writeFileSync(
    join(options.outDir, "summary.md"),
    renderSummaryMd(report.summary, report.warnings),
  );
  writeFileSync(
    join(options.outDir, "frontier.md"),
    renderFrontierMd(report.summary, report.warnings),
  );
  return report;
}
