import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AnswerFn } from "../../src/types";
import { latestByQuestion, readJsonl, runsPath } from "../../src/eval/files";
import { isAgentFailure, isFailedRecord, runEval, runPool } from "../../src/eval/run";
import type { EvalRecord, GoldQuestion } from "../../src/eval/types";
import type { AnswerResult } from "../../src/types";
import { H0, H1, makeAnswer, makeQuestion, makeRun, tempDir } from "./builders";

/** Ten questions, q01 to q10, each with its own wording. */
function tenQuestions(): GoldQuestion[] {
  return Array.from({ length: 10 }, (_, i) => {
    const id = `q${String(i + 1).padStart(2, "0")}`;
    return makeQuestion({ id, question: `Question ${id}?` });
  });
}

/** A fake agent that answers at once. It notes every question it was asked. */
function fakeAnswer(asked: string[] = []): AnswerFn {
  return async (question, setup) => {
    asked.push(question);
    return makeRun(setup, question, makeAnswer([`An answer to ${question}`]));
  };
}

function readRecords(outDir: string, setupId: string): EvalRecord[] {
  return readJsonl<EvalRecord>(runsPath(outDir, setupId, 1));
}

describe("runPool", () => {
  it("never runs more items at once than the limit", async () => {
    let running = 0;
    let mostRunning = 0;
    const finished: number[] = [];

    await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (item) => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      finished.push(item);
      return { ok: true };
    });

    expect(mostRunning).toBe(3);
    expect(finished.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("stops after 5 failures in a row and leaves the rest untouched", async () => {
    const started: number[] = [];
    const pool = runPool([1, 2, 3, 4, 5, 6, 7, 8], 1, async (item) => {
      started.push(item);
      return { ok: false, error: "rate limited" };
    });

    await expect(pool).rejects.toThrow(/5 failures in a row.*rate limited/);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it("still stops when a slow success finishes after the fifth failure", async () => {
    const started: number[] = [];
    // Item 1 succeeds slowly in one lane while items 2 to 6 fail quickly in the other.
    const pool = runPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
      started.push(item);
      if (item === 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { ok: true };
      }
      return { ok: false, error: "rate limited" };
    });

    await expect(pool).rejects.toThrow(/5 failures in a row/);
    expect(started).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("stops every lane and passes the error on when the work itself throws", async () => {
    const started: number[] = [];
    const pool = runPool([1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 2) throw new Error("disk full");
      return { ok: true };
    });

    await expect(pool).rejects.toThrow("disk full");
    expect(started).toEqual([1, 2]);
  });

  it("starts the count again after a success", async () => {
    // Four failures, one success, four failures. Never 5 in a row, so it runs to the end.
    const outcomes = [false, false, false, false, true, false, false, false, false];
    const pool = runPool(outcomes, 1, async (ok) =>
      ok ? { ok: true } : { ok: false, error: "rate limited" },
    );
    await expect(pool).resolves.toBeUndefined();
  });
});

describe("runEval", () => {
  it("writes one record per question and setup", async () => {
    const outDir = tempDir();
    const questions = tenQuestions();

    const result = await runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(),
      outDir,
    });

    expect(result).toEqual({ completed: 10, failed: 0, skipped: 0 });
    const records = readRecords(outDir, "H0");
    expect(records.map((record) => record.question_id).sort()).toEqual(questions.map((q) => q.id));
    expect(records[0]!.setup_id).toBe("H0");
    expect(records[0]!.repeat).toBe(1);
  });

  it("records a run that throws as a failed record and carries on", async () => {
    const outDir = tempDir();
    const answer: AnswerFn = async (question, setup) => {
      if (question === "Question q03?") throw new Error("the model timed out");
      return makeRun(setup, question, makeAnswer());
    };

    const result = await runEval({
      questions: tenQuestions(),
      setups: [H0],
      repeat: 1,
      answer,
      outDir,
    });

    expect(result).toEqual({ completed: 9, failed: 1, skipped: 0 });
    const failed = readRecords(outDir, "H0").filter(isFailedRecord);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.question_id).toBe("q03");
    expect(failed[0]!.run.draft.answer).toBeNull();
    expect(failed[0]!.run.draft.error).toBe("the model timed out");
    expect(failed[0]!.run.final_answer).toBeNull();
  });

  it("keeps a run that hit the turn cap as a final result and never runs it again", async () => {
    const outDir = tempDir();
    const questions = tenQuestions().slice(0, 3);
    const turnCap: AnswerFn = async (question, setup) => {
      const run = makeRun(setup, question, makeAnswer());
      if (question !== "Question q02?") return run;
      // What the pipeline returns when the agent used up its turns. No answer, and the SDK's error.
      const draft = {
        ...run.draft,
        answer: null,
        error: "error_max_turns: Reached maximum number of turns (10)",
      };
      return { ...run, draft, final_answer: null };
    };

    const first = await runEval({ questions, setups: [H0], repeat: 1, answer: turnCap, outDir });
    // The run is finished, not failed. Its record says the agent gave no answer.
    expect(first).toEqual({ completed: 3, failed: 0, skipped: 0 });
    const record = readRecords(outDir, "H0").find((r) => r.question_id === "q02")!;
    expect(isAgentFailure(record)).toBe(true);
    expect(isFailedRecord(record)).toBe(false);

    // A second session does not give the agent another try.
    const asked: string[] = [];
    const second = await runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(asked),
      outDir,
    });
    expect(second).toEqual({ completed: 0, failed: 0, skipped: 3 });
    expect(asked).toEqual([]);
  });

  it("resumes after a stop without running a finished question twice", async () => {
    const outDir = tempDir();
    const questions = tenQuestions();

    // First session. The agent works for 3 questions, then every call fails.
    let calls = 0;
    const breaksAfterThree: AnswerFn = async (question, setup) => {
      calls += 1;
      if (calls > 3) throw new Error("rate limited");
      return makeRun(setup, question, makeAnswer());
    };
    const first = runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: breaksAfterThree,
      outDir,
      concurrency: 1,
    });
    await expect(first).rejects.toThrow(/5 failures in a row/);
    // 3 good records and 5 failed ones are on disk. q09 and q10 were never started.
    expect(readRecords(outDir, "H0")).toHaveLength(8);

    // Second session, with a working agent.
    const asked: string[] = [];
    const second = await runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(asked),
      outDir,
    });

    // The 3 finished questions are skipped. The 5 failed ones and the 2 new ones are run.
    expect(second).toEqual({ completed: 7, failed: 0, skipped: 3 });
    expect(asked.sort()).toEqual(questions.slice(3).map((q) => q.question));

    // Every question now has exactly one record with an answer.
    const good = readRecords(outDir, "H0").filter((record) => !isFailedRecord(record));
    expect(good.map((record) => record.question_id).sort()).toEqual(questions.map((q) => q.id));
    // And the newest record of every question is a good one.
    const latest = latestByQuestion(readRecords(outDir, "H0"));
    expect([...latest.values()].some(isFailedRecord)).toBe(false);

    // A third session has nothing left to do.
    const third = await runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(asked),
      outDir,
    });
    expect(third).toEqual({ completed: 0, failed: 0, skipped: 10 });
  });

  it("tolerates a last line that a crash cut short", async () => {
    const outDir = tempDir();
    const questions = tenQuestions().slice(0, 3);
    await runEval({
      questions: questions.slice(0, 2),
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(),
      outDir,
    });

    // A crash in the middle of writing q03 leaves half a line with no newline.
    appendFileSync(runsPath(outDir, "H0", 1), '{"question_id":"q03","setup_id":"H0","rep');

    const asked: string[] = [];
    const result = await runEval({
      questions,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(asked),
      outDir,
    });

    expect(result).toEqual({ completed: 1, failed: 0, skipped: 2 });
    expect(asked).toEqual(["Question q03?"]);
    // The half line is gone, so every line parses and q03 is there once.
    expect(
      readRecords(outDir, "H0")
        .map((record) => record.question_id)
        .sort(),
    ).toEqual(["q01", "q02", "q03"]);
  });

  it("refuses to resume when a question was reworded after its run", async () => {
    const outDir = tempDir();
    const questions = tenQuestions().slice(0, 2);
    await runEval({ questions, setups: [H0], repeat: 1, answer: fakeAnswer(), outDir });

    const reworded = [questions[0]!, { ...questions[1]!, question: "A new wording?" }];
    const again = runEval({
      questions: reworded,
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(),
      outDir,
    });
    await expect(again).rejects.toThrow(/older wording of question q02/);
  });

  it("reports progress with a count and a time left", async () => {
    const seen: { done: number; total: number }[] = [];
    await runEval({
      questions: tenQuestions().slice(0, 3),
      setups: [H0],
      repeat: 1,
      answer: fakeAnswer(),
      outDir: tempDir(),
      onProgress: (progress) => {
        seen.push({ done: progress.done, total: progress.total });
        expect(progress.eta_seconds).toBeGreaterThanOrEqual(0);
      },
    });
    expect(seen).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
      { done: 3, total: 3 },
    ]);
  });
});

describe("runEval with paired drafts", () => {
  /** A fake pipeline. It counts agent calls, which are the calls that come without a draft. */
  function fakePipeline() {
    const calls = { agent: 0, reused: [] as AnswerResult[] };
    const answer: AnswerFn = async (question, setup, existingDraft) => {
      if (existingDraft) {
        calls.reused.push(existingDraft);
        return { ...makeRun(setup, question, existingDraft.answer), draft: existingDraft };
      }
      calls.agent += 1;
      return makeRun(setup, question, makeAnswer([`Draft ${calls.agent} for ${question}`]));
    };
    return { calls, answer };
  }

  it("calls the agent once per pair and gives the verifier-on setup its twin's draft", async () => {
    const outDir = tempDir();
    const questions = tenQuestions().slice(0, 4);
    const { calls, answer } = fakePipeline();

    // H1 is listed first on purpose. The runner must still run H0 first.
    await runEval({ questions, setups: [H1, H0], repeat: 1, answer, outDir });

    expect(calls.agent).toBe(4);
    expect(calls.reused).toHaveLength(4);
    const h0 = latestByQuestion(readRecords(outDir, "H0"));
    const h1 = latestByQuestion(readRecords(outDir, "H1"));
    for (const question of questions) {
      expect(h1.get(question.id)!.run.draft).toEqual(h0.get(question.id)!.run.draft);
    }
  });

  it("keeps a pair on one draft when the twin's run failed and is run again", async () => {
    const outDir = tempDir();
    const questions = tenQuestions().slice(0, 2);
    const { calls, answer } = fakePipeline();

    // First session. The agent fails on q02, so H0 has no draft for it.
    const failsOnQ02: AnswerFn = async (question, setup, existingDraft) => {
      if (question === "Question q02?" && !existingDraft) throw new Error("rate limited");
      return answer(question, setup, existingDraft);
    };
    const first = await runEval({
      questions,
      setups: [H0, H1],
      repeat: 1,
      answer: failsOnQ02,
      outDir,
    });
    // H1 was handed the failed draft, so it has no answer for q02 either.
    expect(first).toEqual({ completed: 2, failed: 2, skipped: 0 });
    expect(calls.agent).toBe(1);

    // Second session. Only q02 is run again, H0 first, and H1 reuses the new draft.
    const second = await runEval({ questions, setups: [H0, H1], repeat: 1, answer, outDir });
    expect(second).toEqual({ completed: 2, failed: 0, skipped: 2 });
    expect(calls.agent).toBe(2);

    const h0 = latestByQuestion(readRecords(outDir, "H0")).get("q02")!;
    const h1 = latestByQuestion(readRecords(outDir, "H1")).get("q02")!;
    expect(h0.run.draft.answer).not.toBeNull();
    expect(h1.run.draft).toEqual(h0.run.draft);
  });

  it("calls the agent normally when the twin has no record", async () => {
    const { calls, answer } = fakePipeline();
    await runEval({
      questions: tenQuestions().slice(0, 4),
      setups: [H1],
      repeat: 1,
      answer,
      outDir: tempDir(),
    });
    expect(calls.agent).toBe(4);
    expect(calls.reused).toHaveLength(0);
  });

  it("lets every setup call the agent itself when reuseDrafts is off", async () => {
    const { calls, answer } = fakePipeline();
    await runEval({
      questions: tenQuestions().slice(0, 4),
      setups: [H0, H1],
      repeat: 1,
      answer,
      outDir: tempDir(),
      reuseDrafts: false,
    });
    expect(calls.agent).toBe(8);
    expect(calls.reused).toHaveLength(0);
  });
});
