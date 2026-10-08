import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { listRepeats } from "./files";
import type { ReviewScore } from "./judgeAudit";
import { mean } from "./metrics";
import { loadGradedRuns } from "./report";
import { SETUPS, twinOf } from "./setups";
import type { Category, EvalRecord, GoldQuestion, Grade } from "./types";

// `detail.md` is a second report. `summary.md` has one row per setup. This file breaks the same
// runs down further, so every finding in the README can be traced to a table here.
// It makes no model call. It only counts what is already in `results/runs` and `results/grades`,
// plus the second opinions on the judge audit sample when that file exists.

/** One graded run. */
type Row = { record: EvalRecord; grade: Grade; question: GoldQuestion };

/** Every graded run of the setups that have results, keyed by setup ID. */
export type DetailInput = Map<string, Row[]>;

const CATEGORIES: Category[] = [
  "single_page",
  "multi_page",
  "numbers",
  "false_premise",
  "not_covered",
  "personal_judgement",
  "ambiguous",
];

/** Reads the graded runs of every setup that has at least one repeat on disk. */
export function loadDetailInput(outDir: string, questions: GoldQuestion[]): DetailInput {
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const input: DetailInput = new Map();
  for (const setup of SETUPS) {
    if (listRepeats(outDir, setup.id).length === 0) continue;
    const { records, grades } = loadGradedRuns(outDir, setup.id, questions);
    const rows = records.map((record, index) => ({
      record,
      grade: grades[index]!,
      question: questionById.get(record.question_id)!,
    }));
    input.set(setup.id, rows);
  }
  return input;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function table(header: string[], rows: (string | number)[][]): string[] {
  const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line), ""];
}

/** The key that pairs a run with the same question and repeat of another setup. */
function pairKey(row: Row): string {
  return `${row.record.repeat}/${row.record.question_id}`;
}

/** What the quote check and the verifier model did, for each verifier-on setup. */
function checksSection(input: DetailInput): string[] {
  const rows: (string | number)[][] = [];
  for (const [setupId, runs] of input) {
    const records = runs.map((run) => run.record.run.verification).filter((v) => v !== null);
    if (records.length === 0) continue;
    const firstPass = records.flatMap((v) => v.first_pass);
    rows.push([
      setupId,
      records.reduce((n, v) => n + v.claims_before, 0),
      firstPass.filter((v) => v.checked_by === "quote_check" && v.verdict !== "supported").length,
      firstPass.filter((v) => v.checked_by === "verifier" && v.verdict === "not_supported").length,
      firstPass.filter((v) => v.verdict === "partially_supported").length,
      records.filter((v) => v.repair_ran).length,
      records.reduce((n, v) => n + v.unconfirmed.length, 0),
      records.filter((v) => v.summary_replaced).length,
    ]);
  }
  return [
    "## What the two checks did",
    "",
    "Counts over all repeats. The verdicts are those on the draft, before any repair. A claim that is not supported starts one repair attempt. A claim marked partially supported is kept and does not start a repair.",
    "",
    ...table(
      [
        "Setup",
        "Claims in the drafts",
        "Failed the quote check",
        "Not supported, by the verifier model",
        "Partially supported",
        "Runs with a repair",
        "Still not supported after the repair, so removed",
        "Summaries rebuilt",
      ],
      rows,
    ),
  ];
}

/**
 * Compares each verifier-on run with the verifier-off run it shares a draft with.
 * When the two final answers are the same text, the judge graded the same answer twice,
 * so any difference in score is the judge. When they differ, the difference is what the
 * verifier's changes did to correctness.
 */
function pairsSection(input: DetailInput): string[] {
  const rows: (string | number)[][] = [];
  for (const [setupId, runs] of input) {
    const setup = SETUPS.find((s) => s.id === setupId);
    const twin = setup?.verifier ? twinOf(setup) : null;
    const twinRuns = twin ? input.get(twin.id) : undefined;
    if (!twin || !twinRuns) continue;
    const twinByKey = new Map(twinRuns.map((row) => [pairKey(row), row]));

    let same = 0;
    let sameButScoredDifferently = 0;
    const changes: number[] = [];
    for (const row of runs) {
      const other = twinByKey.get(pairKey(row));
      const answer = row.record.run.final_answer;
      const otherAnswer = other?.record.run.final_answer;
      if (!other || !answer || !otherAnswer) continue;
      const difference = row.grade.correctness - other.grade.correctness;
      if (JSON.stringify(answer) === JSON.stringify(otherAnswer)) {
        same += 1;
        if (Math.abs(difference) > 1e-9) sameButScoredDifferently += 1;
      } else {
        changes.push(difference);
      }
    }
    rows.push([
      `${twin.id} and ${setupId}`,
      same,
      sameButScoredDifferently,
      changes.length,
      changes.length > 0 ? `${(mean(changes) * 100).toFixed(1)} points` : "none",
    ]);
  }
  return [
    "## Pairs that share a draft",
    "",
    "A verifier-on run checks the draft of its verifier-off twin. When the verifier changes nothing, the judge grades the same text twice. When it changes the answer, the last column is the mean change in that answer's correctness, verifier on minus verifier off.",
    "",
    ...table(
      [
        "Pair",
        "Same final answer",
        "Of those, scored differently by the judge",
        "Answer changed by the verifier",
        "Mean change in correctness",
      ],
      rows,
    ),
  ];
}

function categorySection(input: DetailInput, questions: GoldQuestion[]): string[] {
  const count = (category: Category) => questions.filter((q) => q.category === category).length;
  const rows = [...input].map(([setupId, runs]) => [
    setupId,
    ...CATEGORIES.map((category) => {
      const scores = runs.filter((run) => run.question.category === category);
      return scores.length > 0 ? percent(mean(scores.map((run) => run.grade.correctness))) : "";
    }),
  ]);
  return [
    "## Correctness by category",
    "",
    "The mean over all repeats. The number of questions is in brackets. A category with 3 questions moves by 11 points when one run changes.",
    "",
    ...table(["Setup", ...CATEGORIES.map((c) => `${c} (${count(c)})`)], rows),
  ];
}

function behaviourSection(input: DetailInput): string[] {
  const share = (runs: Row[], expected: GoldQuestion["expected_behaviour"]) => {
    const subset = runs.filter((run) => run.question.expected_behaviour === expected);
    const right = subset.filter((run) => run.grade.behaviour_correct).length;
    return `${right} of ${subset.length}`;
  };
  const rows = [...input].map(([setupId, runs]) => [
    setupId,
    share(runs, "answer"),
    share(runs, "decline"),
    share(runs, "clarify"),
  ]);
  return [
    "## Behaviour",
    "",
    "Runs where the agent did what the question called for, over all repeats.",
    "",
    ...table(
      ["Setup", "Answered when it should", "Declined when it should", "Asked when it should"],
      rows,
    ),
  ];
}

/** The page of a passage. A passage ID is "<base_path>#<part_slug>#<n>". */
function pageOf(passageId: string): string {
  return passageId.split("#")[0]!;
}

/**
 * For every expected point the judge found missing, says how far its evidence passage got.
 * The evidence passage is the one the drafter of the question took the point from.
 */
function missingPointsSection(input: DetailInput): string[] {
  const rows: (string | number)[][] = [];
  for (const [setupId, runs] of input) {
    if (SETUPS.find((s) => s.id === setupId)?.verifier) continue;
    const counts = {
      points: 0,
      missing: 0,
      noAnswer: 0,
      never: 0,
      neverButSamePage: 0,
      searchOnly: 0,
      read: 0,
    };
    for (const { record, grade, question } of runs) {
      if (question.expected_behaviour !== "answer") continue;
      const inSearch = new Set<string>();
      const readInFull = new Set<string>();
      for (const call of record.run.draft.trace) {
        const target = call.tool === "read_passage" ? readInFull : inSearch;
        for (const id of call.passage_ids) target.add(id);
      }
      const pagesSeen = new Set([...inSearch, ...readInFull].map(pageOf));
      question.expected_points.forEach((point, index) => {
        counts.points += 1;
        if (grade.behaviour === "answered" && grade.points[index]?.present) return;
        counts.missing += 1;
        if (grade.behaviour === "error") {
          counts.noAnswer += 1;
          return;
        }
        const evidence = (question.evidence ?? [])
          .filter((entry) => entry.point === point)
          .map((entry) => entry.passage_id);
        if (evidence.some((id) => readInFull.has(id))) counts.read += 1;
        else if (evidence.some((id) => inSearch.has(id))) counts.searchOnly += 1;
        else {
          counts.never += 1;
          if (evidence.some((id) => pagesSeen.has(pageOf(id)))) counts.neverButSamePage += 1;
        }
      });
    }
    rows.push([
      setupId,
      counts.points,
      counts.missing,
      counts.noAnswer,
      counts.never,
      counts.neverButSamePage,
      counts.searchOnly,
      counts.read,
    ]);
  }
  return [
    "## Missing points and retrieval",
    "",
    "Expected points of the questions that call for an answer, over all repeats. Only verifier-off setups are listed, because a verifier-on setup shares their searches. The columns after the fourth split the missing points of runs that did not fail by how far the point's evidence passage got. The evidence passage is the one the question's drafter took the point from. It was never returned by a search, or it was in a search result but not opened, or the agent read it in full. For the passages never returned, one column counts those where another passage of the same page was returned or read, so the agent had the right page and not the right passage.",
    "",
    ...table(
      [
        "Setup",
        "Expected points",
        "Missing",
        "In runs with no answer",
        "Passage never returned",
        "Of those, same page was returned",
        "In a search result only",
        "Read in full",
      ],
      rows,
    ),
  ];
}

function hardestSection(input: DetailInput, questions: GoldQuestion[]): string[] {
  const setupIds = [...input.keys()];
  const scored = questions.map((question) => {
    const perSetup = setupIds.map((id) =>
      mean(
        input
          .get(id)!
          .filter((run) => run.question.id === question.id)
          .map((run) => run.grade.correctness),
      ),
    );
    return { question, perSetup, overall: mean(perSetup) };
  });
  scored.sort((a, b) => a.overall - b.overall);
  const full = scored.filter((entry) => entry.overall > 0.999).length;
  return [
    "## The hardest questions",
    "",
    `The 12 questions with the lowest mean correctness over all setups and repeats. ${full} of ${questions.length} questions scored 100% in every run.`,
    "",
    ...table(
      ["Question", "Category", "Mean", ...setupIds],
      scored
        .slice(0, 12)
        .map((entry) => [
          entry.question.id,
          entry.question.category,
          percent(entry.overall),
          ...entry.perSetup.map(percent),
        ]),
    ),
  ];
}

function noAnswerSection(input: DetailInput): string[] {
  const rows: (string | number)[][] = [];
  for (const [setupId, runs] of input) {
    for (const { record } of runs) {
      if (record.run.final_answer) continue;
      const reason = (record.run.draft.error ?? "no answer").split(":")[0]!;
      rows.push([setupId, record.repeat, record.question_id, reason]);
    }
  }
  if (rows.length === 0) return ["## Runs with no answer", "", "None.", ""];
  return [
    "## Runs with no answer",
    "",
    "A verifier-on setup shares the draft of its twin, so each failed draft shows twice.",
    "",
    ...table(["Setup", "Repeat", "Question", "Reason"], rows),
  ];
}

/** How often other model reviewers gave the same label as the judge on the audit sample. */
function reviewsSection(reviews: ReviewScore): string[] {
  const share = (agreed: number, items: number) => `${agreed} of ${items}`;
  const ids = reviews.reviewers.map((reviewer) => reviewer.id);
  return [
    "## Second opinions on the judge",
    "",
    `Other model reviewers labelled the ${reviews.items} sampled decisions of the judge audit. They saw what the labelling page shows and not the judge's labels. A reviewer is a model too, so this is a weaker check than a person's labels, and no person has labelled the sample. The labels and each reviewer's reasons are in \`eval/judge-audit-reviews.json\`.`,
    "",
    ...table(
      ["Reviewer", "Model", "Same label as the judge", "Claims", "Answers"],
      reviews.reviewers.map((reviewer) => [
        reviewer.id,
        reviewer.model,
        share(reviewer.agreed, reviews.items),
        share(reviewer.claims.agreed, reviewer.claims.items),
        share(reviewer.answers.agreed, reviewer.answers.items),
      ]),
    ),
    `The reviewers gave each other the same label on ${share(reviews.reviewers_agree, reviews.items)} items. The judge and every reviewer gave the same label on ${share(reviews.all_agree, reviews.items)}.`,
    "",
    ...(reviews.split.length === 0
      ? []
      : [
          "The items where the labels differ. The label of an answer is the number of expected points it states.",
          "",
          ...table(
            ["Item", "Kind", "Question", "Setup", "Judge", ...ids],
            reviews.split.map((item) => [
              item.id,
              item.kind,
              item.question_id,
              item.setup_id,
              item.judge_label,
              ...ids.map((id) => item.labels[id] ?? ""),
            ]),
          ),
        ]),
  ];
}

/** Builds `detail.md`. The last section is left out when there are no second opinions. */
export function renderDetailMd(
  input: DetailInput,
  questions: GoldQuestion[],
  reviews: ReviewScore | null = null,
): string {
  return [
    "# Eval results in detail",
    "",
    "This file breaks the runs behind `summary.md` down further. It is written by `npm run eval -- report` from the files in `runs/` and `grades/`, with no model call.",
    "",
    ...checksSection(input),
    ...pairsSection(input),
    ...categorySection(input, questions),
    ...behaviourSection(input),
    ...missingPointsSection(input),
    ...hardestSection(input, questions),
    ...noAnswerSection(input),
    ...(reviews ? reviewsSection(reviews) : []),
  ].join("\n");
}

/** Writes `detail.md` into the results folder. */
export function writeDetail(
  outDir: string,
  questions: GoldQuestion[],
  reviews: ReviewScore | null = null,
): void {
  const input = loadDetailInput(outDir, questions);
  writeFileSync(join(outDir, "detail.md"), renderDetailMd(input, questions, reviews));
}
