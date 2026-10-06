// Small builders for the eval tests. Each one returns a valid object with plain defaults,
// and a test overrides only the fields it cares about.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { JudgeOutput } from "../../src/eval/judge";
import type { EvalRecord, GoldQuestion, Grade } from "../../src/eval/types";
import type { AnswerResult, Run, Setup, StructuredAnswer, Usage } from "../../src/types";

export const H0: Setup = { id: "H0", model: "claude-haiku-4-5", verifier: false };
export const H1: Setup = { id: "H1", model: "claude-haiku-4-5", verifier: true };

/**
 * A fresh folder under the system temp folder, so a test never writes into the real results.
 * Call it inside a test. The folder is removed when that test finishes.
 */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "visa-eval-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function usage(costUsd = 0): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd };
}

export function makeQuestion(overrides: Partial<GoldQuestion> = {}): GoldQuestion {
  return {
    id: "q01",
    persona: 1,
    category: "single_page",
    question: "How long does a Graduate visa last?",
    expected_behaviour: "answer",
    expected_points: ["It lasts 2 years if you apply on or before 31 December 2026."],
    gold_sources: ["/graduate-visa"],
    must_not_say: [],
    verified_by: "tester",
    verified_on: "2026-10-06",
    ...overrides,
  };
}

/** An answer with one claim per text. Every claim cites the same sample passage. */
export function makeAnswer(
  claimTexts: string[] = ["A Graduate visa lasts 2 years."],
  overrides: Partial<StructuredAnswer> = {},
): StructuredAnswer {
  return {
    status: "answered",
    summary: "A short summary.",
    claims: claimTexts.map((text) => ({
      text,
      citations: [{ passage_id: "/graduate-visa#overview#2", quote: "A Graduate visa lasts for:" }],
    })),
    ...overrides,
  };
}

export function makeDraft(
  answer: StructuredAnswer | null,
  passageIds: string[] = [],
): AnswerResult {
  return {
    answer,
    trace: [
      {
        tool_use_id: "tool-1",
        tool: "search_guidance",
        input: { query: "graduate visa" },
        ok: true,
        result_chars: 100,
        passage_ids: passageIds,
        duration_ms: 5,
        started_at: "2026-10-06T10:00:00.000Z",
      },
    ],
    usage: usage(0.01),
    latencyMs: 1000,
    numTurns: 2,
  };
}

/** A run with the verifier off, so the final answer is the draft answer. */
export function makeRun(
  setup: Setup,
  question: string,
  answer: StructuredAnswer | null,
  overrides: Partial<Run> = {},
): Run {
  return {
    _id: "run-1",
    question,
    setup,
    created_at: "2026-10-06T10:00:00.000Z",
    draft: makeDraft(answer, ["/graduate-visa#overview#2"]),
    verification: null,
    final_answer: answer,
    final_verdicts: [],
    total_usage: usage(0.01),
    total_latency_ms: 1000,
    ...overrides,
  };
}

export function makeRecord(
  setup: Setup,
  question: GoldQuestion,
  answer: StructuredAnswer | null,
  overrides: Partial<EvalRecord> = {},
): EvalRecord {
  return {
    question_id: question.id,
    setup_id: setup.id,
    repeat: 1,
    run: makeRun(setup, question.question, answer),
    ...overrides,
  };
}

export function makeGrade(overrides: Partial<Grade> = {}): Grade {
  return {
    question_id: "q01",
    setup_id: "H0",
    repeat: 1,
    behaviour: "answered",
    behaviour_correct: true,
    retrieval_hit: true,
    points: [],
    must_not_say_hits: [],
    contradiction: false,
    correctness: 1,
    claims: [],
    total_claims: 0,
    unsupported_claims: 0,
    judge_usage: usage(0),
    ...overrides,
  };
}

/** What a judge would return when every point is present and every claim is supported. */
export function allGoodJudgeOutput(question: GoldQuestion, answer: StructuredAnswer): JudgeOutput {
  return {
    points: question.expected_points.map((_, index) => ({ index, present: true })),
    must_not_say_hits: [],
    contradiction: false,
    claims: answer.claims.map((_, index) => ({
      claim_index: index,
      reason: "The passage says so.",
      verdict: "supported" as const,
    })),
  };
}
