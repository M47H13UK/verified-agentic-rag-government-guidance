// The eval command line. Run it with `npm run eval -- <command> [options]`.
// This file only reads the options and calls the functions that do the work.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadEnv } from "../env";
import { gradeFile } from "./grade";
import {
  AUDIT_CSV_PATH,
  AUDIT_KEY_PATH,
  sampleForAudit,
  scoreAudit,
  writeAuditFiles,
} from "./judgeAudit";
import { assertAllVerified, assertScorable, isVerified, loadQuestions } from "./questions";
import { loadGradedRuns, writeReport } from "./report";
import { runEval } from "./run";
import { getSetups, SETUPS } from "./setups";
import type { EvalRecord, GoldQuestion, Grade } from "./types";
import { latestPlanUsage } from "../llm/sdk";
import { createEvalDeps } from "./wiring";

const USAGE = `Usage: npm run eval -- <command> [options]

Commands
  run            Answer the questions with each setup. Costs money.
  grade          Judge the runs and write the grades. Costs money.
  report         Write summary.json, summary.md and frontier.md. Free.
  audit-sample   Write the sheet for checking the judge by hand.
  audit-score    Compare the filled-in sheet with the judge.

Options
  --setups H0,H1        Setups to use. Default all 8.
  --limit 5             Use only the first 5 questions.
  --repeat 1            Which repeat this is. Default 1.
  --concurrency 4       How many calls run at once. Default 4.
  --out results         The results folder. Default results.
  --questions <path>    The questions file. Default eval/questions.jsonl.
  --allow-unverified    Let run start with questions nobody has checked.
  --no-reuse-drafts     Make verifier-on setups write their own drafts.
  --seed 1              Seed for audit-sample. Default 1.
  --force               Let audit-sample replace an existing sheet.`;

/** Reads an option that must be a whole number of 1 or more. */
function wholeNumber(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`--${name} must be a whole number of 1 or more.`);
  }
  return number;
}

function timeLeft(seconds: number): string {
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      setups: { type: "string" },
      limit: { type: "string" },
      repeat: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      out: { type: "string", default: "results" },
      questions: { type: "string", default: "eval/questions.jsonl" },
      "allow-unverified": { type: "boolean", default: false },
      "no-reuse-drafts": { type: "boolean", default: false },
      seed: { type: "string", default: "1" },
      force: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  const outDir = values.out;
  const repeat = wholeNumber(values.repeat, "repeat");
  const concurrency = wholeNumber(values.concurrency, "concurrency");
  const setups = getSetups(values.setups?.split(",").map((id) => id.trim()));

  // Read inside the commands that need it, so the usage text and audit-score work without it.
  const readQuestions = (): GoldQuestion[] => {
    const all = loadQuestions(values.questions);
    assertScorable(all);
    return values.limit ? all.slice(0, wholeNumber(values.limit, "limit")) : all;
  };

  switch (command) {
    case "run": {
      const questions = readQuestions();
      if (!values["allow-unverified"]) {
        assertAllVerified(questions);
      } else if (!questions.every(isVerified)) {
        const unverified = questions.filter((question) => !isVerified(question)).length;
        console.warn(
          `Warning. Of the ${questions.length} questions, the number not yet checked by hand is ${unverified}. ` +
            "This is a trial run and its numbers are not final. " +
            "Give it its own --out folder so it never mixes with the real results.",
        );
      }

      const deps = await createEvalDeps();
      try {
        const result = await runEval({
          questions,
          setups,
          repeat,
          concurrency,
          outDir,
          answer: deps.answer,
          reuseDrafts: !values["no-reuse-drafts"],
          onProgress: (p) => {
            const state = !p.ok ? "FAILED, will be retried" : p.no_answer ? "no answer" : "ok";
            console.log(
              `[${p.done}/${p.total}] ${p.setup_id} ${p.question_id} ${state}, about ${timeLeft(p.eta_seconds)} left${planUsageNote()}`,
            );
          },
        });
        console.log(
          `Done. Finished ${result.completed}, failed ${result.failed}, already on disk ${result.skipped}.`,
        );
        if (result.failed > 0) console.log("Run the same command again to retry the failed runs.");
      } finally {
        await deps.close();
      }
      break;
    }

    case "grade": {
      const questions = readQuestions();
      const deps = await createEvalDeps();
      try {
        for (const setup of setups) {
          const result = await gradeFile({
            setupId: setup.id,
            repeat,
            questions,
            outDir,
            concurrency,
            judge: deps.judge,
            getPassages: deps.getPassages,
            quoteCheck: deps.quoteCheck,
            onProgress: (p) => {
              const state = p.ok ? "ok" : "JUDGE FAILED";
              console.log(`[${p.done}/${p.total}] ${setup.id} ${p.question_id} ${state}`);
            },
          });
          console.log(
            `${setup.id} done. New grades ${result.graded}, judge errors ${result.judge_errors}, already on disk ${result.skipped}.`,
          );
        }
      } finally {
        await deps.close();
      }
      break;
    }

    case "report": {
      // The report describes the whole gold set, so it ignores --limit.
      const report = writeReport({ questions: loadQuestions(values.questions), outDir });
      for (const warning of report.warnings) console.warn(warning);
      console.log(`Wrote summary.json, summary.md and frontier.md to ${outDir}.`);
      break;
    }

    case "audit-sample": {
      // A new sample would overwrite the labels a person has already typed in.
      if (existsSync(AUDIT_CSV_PATH) && !values.force) {
        throw new Error(`${AUDIT_CSV_PATH} already exists. Move it away, or pass --force.`);
      }

      const questions = loadQuestions(values.questions);
      const records: EvalRecord[] = [];
      const grades: Grade[] = [];
      for (const setup of SETUPS) {
        const graded = loadGradedRuns(outDir, setup.id, questions);
        records.push(...graded.records);
        grades.push(...graded.grades);
      }
      const seed = wholeNumber(values.seed, "seed");
      const items = sampleForAudit(records, grades, { claims: 30, answers: 15, seed });

      const deps = await createEvalDeps();
      try {
        await writeAuditFiles(
          items,
          { records, questions, getPassages: deps.getPassages },
          { csvPath: AUDIT_CSV_PATH, keyPath: AUDIT_KEY_PATH },
        );
      } finally {
        await deps.close();
      }
      console.log(
        `Wrote ${items.length} items to ${AUDIT_CSV_PATH}. Fill in the human_label column. ` +
          `Do not open ${AUDIT_KEY_PATH} until you are done, because it holds the judge's labels.`,
      );
      break;
    }

    case "audit-score": {
      const score = scoreAudit(AUDIT_CSV_PATH, AUDIT_KEY_PATH);
      if (score.agreement_rate === null) {
        console.log("No rows are labelled yet.");
        break;
      }
      console.log(
        `The judge agrees with the person on ${score.agreed} of ${score.labelled} items, which is ${(score.agreement_rate * 100).toFixed(1)}%.`,
      );
      console.log(
        `That is ${score.claims.agreed} of ${score.claims.labelled} claims and ${score.answers.agreed} of ${score.answers.labelled} answers. Rows not labelled yet ${score.unlabelled}.`,
      );
      for (const item of score.disagreements) {
        console.log(
          `${item.id} (${item.setup_id}, ${item.question_id}) has ${item.human_label} from the person and ${item.judge_label} from the judge.`,
        );
      }
      break;
    }

    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// The Agent SDK does not read `.env` files, so load it before anything calls a model.
loadEnv();

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

/** On a subscription the SDK reports how much of the plan's limits is used. Long runs show it. */
function planUsageNote(): string {
  const usage = latestPlanUsage();
  if (!usage || usage.fiveHour === null || usage.sevenDay === null) return "";
  const percent = (share: number) => `${Math.round(share * 100)}%`;
  return `, plan usage ${percent(usage.fiveHour)} of 5 hours and ${percent(usage.sevenDay)} of 7 days`;
}
