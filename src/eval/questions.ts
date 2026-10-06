import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { GoldQuestion } from "./types";

// Reading and writing the gold set, eval/questions.jsonl. One JSON object per line.

/**
 * The shape of one gold question.
 * `satisfies` makes the compiler check that this schema and the GoldQuestion type stay the same.
 * The object is strict, so a misspelt key such as "expected_behavior" is an error and not silently dropped.
 */
export const questionSchema = z.strictObject({
  id: z.string().min(1),
  persona: z.int().min(1).max(6),
  category: z.enum([
    "single_page",
    "multi_page",
    "numbers",
    "not_covered",
    "personal_judgement",
    "false_premise",
    "ambiguous",
  ]),
  question: z.string().min(1),
  expected_behaviour: z.enum(["answer", "decline", "clarify"]),
  expected_points: z.array(z.string()),
  gold_sources: z.array(z.string()),
  must_not_say: z.array(z.string()),
  notes: z.string().optional(),
  evidence: z
    .array(z.strictObject({ point: z.string(), passage_id: z.string(), quote: z.string() }))
    .optional(),
  verified_by: z.string().min(1).nullable(),
  /** A date such as "2026-10-06". */
  verified_on: z.iso.date().nullable(),
}) satisfies z.ZodType<GoldQuestion>;

/** Turns a failed parse into one line, for example "persona: Too big: expected number to be <=6". */
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ` : "") + issue.message)
    .join(". ");
}

/**
 * Reads the gold set. Blank lines are skipped.
 * A bad line stops the load with an error that names the line number, so it is quick to find in an editor.
 */
export function loadQuestions(path: string): GoldQuestion[] {
  const questions: GoldQuestion[] = [];
  const lines = readFileSync(path, "utf8").split("\n");

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    const where = `${path} line ${index + 1}`;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${where} is not valid JSON.`);
    }

    const parsed = questionSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`${where} is not a valid question. ${describeIssues(parsed.error)}`);
    }
    questions.push(parsed.data);
  });

  return questions;
}

/** Writes the gold set, one question per line. */
export function saveQuestions(path: string, questions: GoldQuestion[]): void {
  // Parsing each question first means a bad question can never reach the file.
  // It also puts the keys in the schema's order, so a git diff of the file shows only real changes.
  const lines = questions.map((question) => JSON.stringify(questionSchema.parse(question)) + "\n");

  // The whole file is written under another name and then renamed over the real one.
  // A rename either happens or does not, so a crash during the write cannot leave half a file.
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, lines.join(""));
  renameSync(temporaryPath, path);
}

/** True when a person has checked the question by hand. */
export function isVerified(question: GoldQuestion): boolean {
  return question.verified_by !== null && question.verified_on !== null;
}

/**
 * Throws when any question has not been checked by hand, and lists their IDs.
 * It is meant to run before an eval, because every score is measured against these questions.
 */
export function assertAllVerified(questions: GoldQuestion[]): void {
  const unverified = questions.filter((question) => !isVerified(question)).map((q) => q.id);
  if (unverified.length > 0) {
    throw new Error(
      `${unverified.length} of ${questions.length} gold questions are not verified: ${unverified.join(", ")}. ` +
        "Check them with `npm run gold:check`, or pass --allow-unverified for a trial run whose numbers are not final.",
    );
  }
}

/**
 * Throws when the set cannot be scored. The loader accepts such a file, so that it can still be
 * opened and fixed in `npm run gold:check`. An eval run must not start on it.
 */
export function assertScorable(questions: GoldQuestion[]): void {
  const seen = new Set<string>();
  for (const question of questions) {
    // Results are stored by question ID, so two questions with one ID would overwrite each other.
    if (seen.has(question.id)) {
      throw new Error(`The question ID ${question.id} is used twice.`);
    }
    seen.add(question.id);

    // The score of an answer question is the share of its points that are present.
    // With no points that share cannot be worked out.
    if (question.expected_behaviour === "answer" && question.expected_points.length === 0) {
      throw new Error(`${question.id} expects an answer but lists no expected points.`);
    }
    // A decline or clarify question is scored on behaviour alone. Points on it would never be
    // used, which usually means the expected behaviour is wrong.
    if (question.expected_behaviour !== "answer" && question.expected_points.length > 0) {
      throw new Error(
        `${question.id} expects the agent to ${question.expected_behaviour} but lists expected points.`,
      );
    }
  }
}
