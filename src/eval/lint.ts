import type { Db } from "mongodb";
import { passagesCollection } from "../db";
import { getPassagesById } from "../tools/readPassage";
import type { Passage } from "../types";
import { MIN_QUOTE_WORDS, checkCitation } from "../verify/quoteCheck";
import type { Category, GoldQuestion } from "./types";

// The gold set lint. It catches drafting mistakes by code, before a person spends time on the hand check.
// `lintQuestions` is plain code with no database. The lookups at the end of the file fetch what it needs.

export type LintProblem = {
  /** Null when the problem is about the whole set and not one question. */
  question_id: string | null;
  /** An error must be fixed before an eval run. A warning is worth a look. */
  level: "error" | "warning";
  message: string;
};

/** How many questions each category should have. The targets add up to 61. */
export const CATEGORY_TARGETS: Record<Category, number> = {
  single_page: 18,
  multi_page: 11,
  numbers: 10,
  not_covered: 8,
  personal_judgement: 6,
  false_premise: 5,
  ambiguous: 3,
};

/** A category count this far from its target is still fine. */
const TARGET_TOLERANCE = 2;

/**
 * The rule that ties a gold source to a passage.
 * A gold source names a whole page ("/graduate-visa") or one part of a guide ("/graduate-visa/overview").
 */
export function passageMatchesSource(
  source: string,
  passage: Pick<Passage, "base_path" | "part_slug">,
): boolean {
  return source === passage.base_path || source === `${passage.base_path}/${passage.part_slug}`;
}

/**
 * Checks the whole gold set and returns every problem found.
 * `passages` holds every passage the evidence refers to. A passage that is missing from the map
 * is reported as not existing. `sourceExists` answers "does any passage match this gold source".
 */
export function lintQuestions(
  questions: GoldQuestion[],
  passages: Map<string, Passage>,
  sourceExists: (source: string) => boolean,
): LintProblem[] {
  const problems: LintProblem[] = [];

  // Results are stored by question ID, so two questions with one ID would overwrite each other.
  const idCounts = new Map<string, number>();
  for (const question of questions) {
    idCounts.set(question.id, (idCounts.get(question.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      problems.push({
        question_id: id,
        level: "error",
        message: `${count} questions have this ID.`,
      });
    }
  }

  for (const question of questions) {
    problems.push(...lintOneQuestion(question, passages, sourceExists));
  }

  // The mix of categories decides what the scores mean, so a set that drifts from the plan is flagged.
  for (const [category, target] of Object.entries(CATEGORY_TARGETS)) {
    const count = questions.filter((question) => question.category === category).length;
    if (Math.abs(count - target) > TARGET_TOLERANCE) {
      problems.push({
        question_id: null,
        level: "warning",
        message: `Category ${category} has ${count} of a target of ${target} questions.`,
      });
    }
  }

  return problems;
}

function lintOneQuestion(
  question: GoldQuestion,
  passages: Map<string, Passage>,
  sourceExists: (source: string) => boolean,
): LintProblem[] {
  const problems: LintProblem[] = [];
  const error = (message: string) =>
    problems.push({ question_id: question.id, level: "error", message });
  const warning = (message: string) =>
    problems.push({ question_id: question.id, level: "warning", message });

  const evidence = question.evidence ?? [];

  if (question.expected_behaviour === "answer") {
    // Without points there is nothing to score. Without a source the retrieval hit rate cannot be measured.
    if (question.expected_points.length === 0) {
      error('An "answer" question needs at least one expected point.');
    }
    if (question.gold_sources.length === 0) {
      error('An "answer" question needs at least one gold source.');
    }
    for (const point of question.expected_points) {
      if (!evidence.some((item) => item.point === point)) {
        warning(`Expected point "${shorten(point)}" has no evidence.`);
      }
    }
  } else if (question.expected_points.length > 0) {
    warning(
      `A "${question.expected_behaviour}" question should have no expected points. It has ${question.expected_points.length}.`,
    );
  }

  for (const source of question.gold_sources) {
    if (!sourceExists(source)) {
      error(`Gold source ${source} matches no passage.`);
    }
  }

  for (const item of evidence) {
    // The page pairs evidence with a point by comparing the two strings, so they must be equal.
    if (!question.expected_points.includes(item.point)) {
      error(`Evidence point "${shorten(item.point)}" is not one of the expected points.`);
    }

    // The same check the answers go through. It also reports a passage ID that does not exist.
    const check = checkCitation(item, passages);
    if (!check.ok) {
      switch (check.reason) {
        case "passage_not_found":
          error(`Evidence passage ${item.passage_id} does not exist.`);
          break;
        case "quote_too_short":
          error(
            `Evidence quote "${shorten(item.quote)}" is shorter than ${MIN_QUOTE_WORDS} words.`,
          );
          break;
        case "quote_not_found":
          error(`Evidence quote "${shorten(item.quote)}" is not in passage ${item.passage_id}.`);
          break;
      }
    }

    // Retrieval is scored against the gold sources, so evidence from another page means one of the two is wrong.
    const passage = passages.get(item.passage_id);
    if (passage && !question.gold_sources.some((s) => passageMatchesSource(s, passage))) {
      warning(`Evidence passage ${item.passage_id} is not under any gold source.`);
    }
  }

  if ((question.verified_by === null) !== (question.verified_on === null)) {
    error("verified_by and verified_on must both be set or both be null.");
  }

  return problems;
}

/** Keeps a message to one line when it quotes a long point. */
function shorten(text: string, maxLength = 60): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

// ---------- MongoDB lookups ----------
// These fetch what `lintQuestions` needs. The check page also uses them to show a gold source.

/**
 * The base paths a gold source could belong to.
 * "/graduate-visa/overview" is either a page with that exact path, or the part "overview" of "/graduate-visa".
 */
function possibleBasePaths(source: string): string[] {
  const lastSlash = source.lastIndexOf("/");
  return lastSlash > 0 ? [source, source.slice(0, lastSlash)] : [source];
}

/** The passages a gold source points at, ordered by part and then by position in the part. */
export async function findPassagesForSource(db: Db, source: string): Promise<Passage[]> {
  const candidates = await passagesCollection(db)
    .find({ base_path: { $in: possibleBasePaths(source) } })
    .sort({ part_slug: 1, n: 1 })
    .toArray();
  // The query is wider than the rule. The rule itself lives in one place, `passageMatchesSource`.
  return candidates.filter((passage) => passageMatchesSource(source, passage));
}

/** Loads from MongoDB what the questions refer to, then runs `lintQuestions`. */
export async function lintWithDb(db: Db, questions: GoldQuestion[]): Promise<LintProblem[]> {
  const evidenceIds = questions.flatMap((q) => (q.evidence ?? []).map((item) => item.passage_id));
  const passages = await getPassagesById(db, evidenceIds);

  // One query for all gold sources. Only the page and the part are fetched, not the text.
  const sources = questions.flatMap((question) => question.gold_sources);
  const parts = await passagesCollection(db)
    .find({ base_path: { $in: sources.flatMap(possibleBasePaths) } })
    .project<Pick<Passage, "base_path" | "part_slug">>({ _id: 0, base_path: 1, part_slug: 1 })
    .toArray();

  return lintQuestions(questions, passages, (source) =>
    parts.some((part) => passageMatchesSource(source, part)),
  );
}
