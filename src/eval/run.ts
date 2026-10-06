// The eval runner. It answers every question with every setup and writes one record per run.
import { randomUUID } from "node:crypto";
import type { AnswerResult, Run, Setup, Usage } from "../types";
import type { AnswerFn } from "../types";
import { appendJsonl, dropPartialLastLine, latestByQuestion, readJsonl, runsPath } from "./files";
import { twinOf } from "./setups";
import type { EvalRecord, GoldQuestion } from "./types";

/** The batch stops after this many failures in a row. */
export const MAX_FAILURES_IN_A_ROW = 5;

const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};

// ---------- The promise pool ----------

/** What one piece of work tells the pool. A failure is returned, not thrown. */
export type WorkResult = { ok: true } | { ok: false; error: string };

/**
 * Runs `work` on every item, at most `limit` at a time, and returns when all are finished.
 *
 * It stops early after 5 failures in a row, because that usually means a rate limit or an
 * auth problem, and carrying on would only fill the file with failures. Work that is already
 * under way is allowed to finish first, then it throws.
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<WorkResult>,
): Promise<void> {
  let next = 0;
  let failuresInARow = 0;
  let lastError = "";
  let gaveUp = false;
  const crashes: unknown[] = [];

  // One lane takes the next item, waits for it, and repeats until nothing is left.
  // JavaScript runs one piece of code at a time, so two lanes can never take the same item.
  async function lane(): Promise<void> {
    while (next < items.length && !gaveUp && crashes.length === 0) {
      const item = items[next]!;
      next += 1;
      try {
        const result = await work(item);
        if (result.ok) {
          failuresInARow = 0;
        } else {
          failuresInARow += 1;
          lastError = result.error;
          // `gaveUp` is never set back. A success that arrives late from another lane resets
          // the count, and without the flag the pool would quietly start up again.
          if (failuresInARow >= MAX_FAILURES_IN_A_ROW) gaveUp = true;
        }
      } catch (error) {
        // `work` returns its failures. A throw means the harness itself broke, for example
        // the disk is full, so every lane stops.
        crashes.push(error);
      }
    }
  }

  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) lanes.push(lane());
  await Promise.all(lanes);

  if (crashes.length > 0) throw crashes[0];
  if (gaveUp) {
    throw new Error(
      `Stopped after ${MAX_FAILURES_IN_A_ROW} failures in a row. ` +
        "This usually means a rate limit or an auth problem. " +
        `The last error was "${lastError}". ` +
        "Everything that finished is saved. Fix the problem and run the same command again.",
    );
  }
}

// ---------- Records ----------

/**
 * Errors that come from the agent itself: it used up its turns, or it never produced an answer
 * in the right shape. These are results. They are kept, they score 0, and they are never run
 * again, because running a question until it passes would flatter the setup.
 */
const AGENT_FAILURES = [
  "error_max_turns",
  "error_max_structured_output_retries",
  "no answer matching the schema",
];

/** True when a run has no answer because of the agent, not because of something around it. */
export function isAgentFailure(record: EvalRecord): boolean {
  const { answer, error } = record.run.draft;
  return answer === null && AGENT_FAILURES.some((text) => (error ?? "").includes(text));
}

/**
 * A failed record is a run with no draft answer for a reason outside the agent, such as a rate
 * limit, a dropped connection or a crash. It is not counted as done and is run again on resume.
 */
export function isFailedRecord(record: EvalRecord): boolean {
  return record.run.draft.answer === null && !isAgentFailure(record);
}

/**
 * Throws when a stored run answered a different wording of its question.
 * That happens when the questions file is edited after a run. The old answer would then be
 * scored against the new question without anyone noticing.
 */
export function assertSameWording(record: EvalRecord, question: GoldQuestion, path: string): void {
  if (record.run.question.trim() === question.question.trim()) return;
  throw new Error(
    `${path} holds an answer to an older wording of question ${question.id}. ` +
      "The questions file changed after that run. Run the eval again with a new --out folder.",
  );
}

/** Builds the record for a run that threw. It has no answer and carries the error message. */
function failedRun(question: string, setup: Setup, error: string, latencyMs: number): Run {
  return {
    _id: randomUUID(),
    question,
    setup,
    created_at: new Date().toISOString(),
    draft: { answer: null, trace: [], usage: NO_USAGE, latencyMs, numTurns: 0, error },
    verification: null,
    final_answer: null,
    final_verdicts: [],
    total_usage: NO_USAGE,
    total_latency_ms: latencyMs,
  };
}

/** Reads the drafts of the verifier-off twin of this setup, by question ID. */
function readTwinDrafts(
  outDir: string,
  setup: Setup,
  repeat: number,
  questions: GoldQuestion[],
): Map<string, AnswerResult> {
  const drafts = new Map<string, AnswerResult>();
  const twin = twinOf(setup);
  if (!twin) return drafts;

  const path = runsPath(outDir, twin.id, repeat);
  const records = latestByQuestion(readJsonl<EvalRecord>(path));
  for (const question of questions) {
    const record = records.get(question.id);
    if (!record) continue;
    assertSameWording(record, question, path);
    drafts.set(question.id, record.run.draft);
  }
  return drafts;
}

// ---------- The runner ----------

export type Progress = {
  /** Runs finished in this session, failed ones included. */
  done: number;
  /** Runs this session set out to do. Runs already in the files are not counted. */
  total: number;
  failed: number;
  /** Seconds left, worked out from the average time per finished run. */
  eta_seconds: number;
  /** The run that just finished. */
  setup_id: string;
  question_id: string;
  /** False when the run failed for a reason outside the agent and will be run again. */
  ok: boolean;
  /** True when the agent itself gave no answer, for example at the turn cap. The run is final. */
  no_answer: boolean;
};

export type RunEvalOptions = {
  questions: GoldQuestion[];
  setups: Setup[];
  /** The repeat number, starting at 1. It is part of the file name. */
  repeat: number;
  answer: AnswerFn;
  /** How many runs are under way at once. Default 4. */
  concurrency?: number;
  /** The results folder. Runs go to `<outDir>/runs/`. */
  outDir: string;
  /** Default true. See the comment in `runEval`. */
  reuseDrafts?: boolean;
  onProgress?: (progress: Progress) => void;
};

export type RunEvalResult = {
  /** Runs that finished with an answer in this session. */
  completed: number;
  failed: number;
  /** Runs that were already in the files and were not run again. */
  skipped: number;
};

/**
 * Runs every question against every setup for one repeat.
 * Each finished run is added to `<outDir>/runs/<setup>-r<repeat>.jsonl` straight away, so a
 * crash loses only the runs that were under way. Running it again picks up where it stopped.
 */
export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  const { questions, repeat, answer, outDir, onProgress } = options;
  const concurrency = options.concurrency ?? 4;
  const reuseDrafts = options.reuseDrafts ?? true;

  // Verifier-off setups run first, so that each verifier-on setup finds the draft of its twin
  // already on disk and checks that same draft instead of asking the agent again. The two
  // setups of a pair then differ only by the verifier. If each wrote its own draft, the gap
  // between them would also include the random difference between two drafts.
  const setups = [
    ...options.setups.filter((setup) => !setup.verifier),
    ...options.setups.filter((setup) => setup.verifier),
  ];

  // Work out what is left for every setup before starting, so the progress total is right.
  const plans = setups.map((setup) => {
    const path = runsPath(outDir, setup.id, repeat);
    dropPartialLastLine(path);
    const records = latestByQuestion(readJsonl<EvalRecord>(path));

    const pending = questions.filter((question) => {
      const record = records.get(question.id);
      if (!record) return true;
      assertSameWording(record, question, path);
      return isFailedRecord(record);
    });
    return { setup, path, pending };
  });

  const total = plans.reduce((sum, plan) => sum + plan.pending.length, 0);
  const skipped = setups.length * questions.length - total;
  const startedAt = Date.now();
  let done = 0;
  let failed = 0;

  for (const plan of plans) {
    const { setup, path } = plan;
    // Read the twin's drafts now and not earlier. In a batch with both setups, the twin has
    // just finished.
    const twinDrafts =
      reuseDrafts && setup.verifier
        ? readTwinDrafts(outDir, setup, repeat, plan.pending)
        : new Map<string, AnswerResult>();

    await runPool(plan.pending, concurrency, async (question) => {
      const runStartedAt = Date.now();
      let run: Run;
      try {
        // With no draft from the twin this passes undefined, and the agent is called as usual.
        run = await answer(question.question, setup, twinDrafts.get(question.id));
      } catch (error) {
        // A run that throws is written down as a failure. It is not retried here, so a
        // problem that keeps happening shows up in the file instead of being hidden.
        const message = error instanceof Error ? error.message : String(error);
        run = failedRun(question.question, setup, message, Date.now() - runStartedAt);
      }

      const record: EvalRecord = { question_id: question.id, setup_id: setup.id, repeat, run };
      appendJsonl(path, record);

      const ok = !isFailedRecord(record);
      done += 1;
      if (!ok) failed += 1;
      const secondsPerRun = (Date.now() - startedAt) / 1000 / done;
      onProgress?.({
        done,
        total,
        failed,
        eta_seconds: Math.round(secondsPerRun * (total - done)),
        setup_id: setup.id,
        question_id: question.id,
        ok,
        no_answer: isAgentFailure(record),
      });

      if (ok) return { ok: true };
      return { ok: false, error: run.draft.error ?? "The run returned no answer." };
    });
  }

  return { completed: done - failed, failed, skipped };
}
