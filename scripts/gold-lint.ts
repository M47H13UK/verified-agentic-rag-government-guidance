// Checks the gold set for drafting mistakes. Run with `npm run gold:lint`.
//   npm run gold:lint -- --file eval/drafts.jsonl
import { parseArgs } from "node:util";
import { closeDb, getDb, passagesCollection } from "../src/db";
import { loadEnv } from "../src/env";
import { CATEGORY_TARGETS, lintWithDb, type LintProblem } from "../src/eval/lint";
import { isVerified, loadQuestions } from "../src/eval/questions";
import type { GoldQuestion } from "../src/eval/types";

loadEnv();

const { values: flags } = parseArgs({
  options: { file: { type: "string", default: "eval/questions.jsonl" } },
});

try {
  const questions = loadQuestions(flags.file);
  const db = await getDb();
  console.log(
    `Gold set ${flags.file}, ${questions.length} questions, database "${db.databaseName}"\n`,
  );

  if ((await passagesCollection(db).estimatedDocumentCount()) === 0) {
    console.log(
      "This database has no passages, so every gold source and evidence passage is reported as missing. Load the corpus first.\n",
    );
  }

  const problems = await lintWithDb(db, questions);
  printProblems(problems);
  printCounts(questions);

  const verified = questions.filter(isVerified).length;
  const errors = problems.filter((problem) => problem.level === "error").length;
  console.log(`Verified ${verified} of ${questions.length}.`);
  console.log(`Errors ${errors}. Warnings ${problems.length - errors}.`);

  // A non-zero exit code lets a script or CI stop on a broken gold set. Warnings do not fail the run.
  if (errors > 0) process.exitCode = 1;
} catch (error) {
  // A missing file, a bad line in the file, or MongoDB not running.
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await closeDb();
}

/** Prints the problems under the ID of their question. Problems about the whole set come last. */
function printProblems(problems: LintProblem[]): void {
  if (problems.length === 0) {
    console.log("No problems found.\n");
    return;
  }
  // A Map keeps the order in which keys were first added, so questions print in file order.
  const groups = new Map<string, LintProblem[]>();
  for (const problem of problems) {
    const key = problem.question_id ?? "Whole set";
    groups.set(key, [...(groups.get(key) ?? []), problem]);
  }
  for (const [key, group] of groups) {
    console.log(key);
    for (const problem of group) {
      console.log(`  ${problem.level.padEnd(8)} ${problem.message}`);
    }
    console.log("");
  }
}

/** Prints one row per category, with a column per persona, the row total and the target. */
function printCounts(questions: GoldQuestion[]): void {
  const personas = [1, 2, 3, 4, 5, 6];
  const countWhere = (test: (question: GoldQuestion) => boolean) => questions.filter(test).length;

  const rows: Record<string, Record<string, number>> = {};
  for (const [category, target] of Object.entries(CATEGORY_TARGETS)) {
    const row: Record<string, number> = {};
    for (const persona of personas) {
      row[`persona ${persona}`] = countWhere(
        (q) => q.category === category && q.persona === persona,
      );
    }
    row.total = countWhere((q) => q.category === category);
    row.target = target;
    rows[category] = row;
  }

  const totals: Record<string, number> = {};
  for (const persona of personas) {
    totals[`persona ${persona}`] = countWhere((q) => q.persona === persona);
  }
  totals.total = questions.length;
  totals.target = Object.values(CATEGORY_TARGETS).reduce((sum, target) => sum + target, 0);
  rows.total = totals;

  console.table(rows);
}
