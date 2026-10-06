import type { Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { passagesCollection } from "../../src/db";
import {
  findPassagesForSource,
  lintQuestions,
  lintWithDb,
  passageMatchesSource,
} from "../../src/eval/lint";
import type { GoldQuestion } from "../../src/eval/types";
import type { Passage } from "../../src/types";
import { samplePassages, sampleQuotes } from "../helpers/fixtures";
import { createTestDb } from "../helpers/testDb";

const passages = new Map<string, Passage>(samplePassages().map((p) => [p._id, p]));
const sourceExists = (source: string) =>
  samplePassages().some((passage) => passageMatchesSource(source, passage));

/** A real quote from "/graduate-visa#overview#2", about a PhD. */
const phd = sampleQuotes()[1]!;
const POINT = "It lasts 3 years if you have a PhD.";

/** A question that passes every check. Each test changes the one field it is about. */
function makeQuestion(changes: Partial<GoldQuestion> = {}): GoldQuestion {
  return {
    id: "q-001",
    persona: 1,
    category: "single_page",
    question: "How long does a Graduate visa last?",
    expected_behaviour: "answer",
    expected_points: [POINT],
    gold_sources: ["/graduate-visa/overview"],
    must_not_say: [],
    evidence: [{ point: POINT, passage_id: phd.passage_id, quote: phd.quote }],
    verified_by: null,
    verified_on: null,
    ...changes,
  };
}

/**
 * Lints the questions and returns the problems of single questions as "level: message".
 * Problems about the whole set are left out. A set of one or two questions is always far from
 * the category targets, and those warnings have their own test.
 */
function lint(questions: GoldQuestion[]): string[] {
  return lintQuestions(questions, passages, sourceExists)
    .filter((problem) => problem.question_id !== null)
    .map((problem) => `${problem.level}: ${problem.message}`);
}

describe("passageMatchesSource", () => {
  const passage = passages.get("/graduate-visa#overview#2")!;

  it("matches the page path and the page path with the part", () => {
    expect(passageMatchesSource("/graduate-visa", passage)).toBe(true);
    expect(passageMatchesSource("/graduate-visa/overview", passage)).toBe(true);
  });

  it("does not match another part or another page", () => {
    expect(passageMatchesSource("/graduate-visa/apply", passage)).toBe(false);
    expect(passageMatchesSource("/graduate", passage)).toBe(false);
  });
});

describe("lintQuestions", () => {
  it("finds nothing wrong with a good question", () => {
    expect(lint([makeQuestion()])).toEqual([]);
  });

  it("reports a duplicate ID once, as an error", () => {
    const problems = lintQuestions([makeQuestion(), makeQuestion()], passages, sourceExists);

    expect(problems.filter((problem) => problem.question_id === "q-001")).toEqual([
      { question_id: "q-001", level: "error", message: "2 questions have this ID." },
    ]);
  });

  it("needs an expected point and a gold source on an answer question", () => {
    const question = makeQuestion({ expected_points: [], gold_sources: [], evidence: [] });

    expect(lint([question])).toEqual([
      'error: An "answer" question needs at least one expected point.',
      'error: An "answer" question needs at least one gold source.',
    ]);
  });

  it("warns about expected points on a decline or clarify question", () => {
    const decline = makeQuestion({
      expected_behaviour: "decline",
      gold_sources: [],
      evidence: [],
    });

    expect(lint([decline])).toEqual([
      'warning: A "decline" question should have no expected points. It has 1.',
    ]);
    expect(lint([{ ...decline, expected_points: [] }])).toEqual([]);
    expect(lint([{ ...decline, expected_points: [], expected_behaviour: "clarify" }])).toEqual([]);
  });

  it("reports a gold source that matches no passage", () => {
    const question = makeQuestion({ gold_sources: ["/graduate-visa", "/graduate-visa/fees"] });

    expect(lint([question])).toEqual([
      "error: Gold source /graduate-visa/fees matches no passage.",
    ]);
  });

  it("reports an evidence passage that does not exist", () => {
    const question = makeQuestion({
      evidence: [{ point: POINT, passage_id: "/graduate-visa#overview#99", quote: phd.quote }],
    });

    expect(lint([question])).toEqual([
      "error: Evidence passage /graduate-visa#overview#99 does not exist.",
    ]);
  });

  it("reports an evidence quote that is not in its passage", () => {
    const changed = phd.quote.replace("3 years", "4 years");
    const question = makeQuestion({
      evidence: [{ point: POINT, passage_id: phd.passage_id, quote: changed }],
    });

    expect(lint([question])).toEqual([
      'error: Evidence quote "If you have a PhD or other doctoral qualification, it will l…" is not in passage /graduate-visa#overview#2.',
    ]);
  });

  it("reports an evidence quote of fewer than 3 words", () => {
    const question = makeQuestion({
      evidence: [{ point: POINT, passage_id: phd.passage_id, quote: "3 years" }],
    });

    expect(lint([question])).toEqual(['error: Evidence quote "3 years" is shorter than 3 words.']);
  });

  it("reports evidence written for a point the question does not have", () => {
    const question = makeQuestion({
      evidence: [
        { point: POINT, passage_id: phd.passage_id, quote: phd.quote },
        { point: "It lasts three years.", passage_id: phd.passage_id, quote: phd.quote },
      ],
    });

    expect(lint([question])).toEqual([
      'error: Evidence point "It lasts three years." is not one of the expected points.',
    ]);
  });

  it("warns about an expected point with no evidence", () => {
    const question = makeQuestion({ expected_points: [POINT, "It cannot be extended."] });

    expect(lint([question])).toEqual([
      'warning: Expected point "It cannot be extended." has no evidence.',
    ]);
  });

  it("warns about evidence from a passage that no gold source covers", () => {
    const question = makeQuestion({ gold_sources: ["/graduate-visa/how-much-it-costs"] });

    expect(lint([question])).toEqual([
      "warning: Evidence passage /graduate-visa#overview#2 is not under any gold source.",
    ]);
  });

  it("needs verified_by and verified_on to be set together", () => {
    const message = "error: verified_by and verified_on must both be set or both be null.";

    expect(lint([makeQuestion({ verified_by: "A Checker" })])).toEqual([message]);
    expect(lint([makeQuestion({ verified_on: "2026-10-06" })])).toEqual([message]);
    expect(lint([makeQuestion({ verified_by: "A Checker", verified_on: "2026-10-06" })])).toEqual(
      [],
    );
  });

  it("warns when a category is more than 2 away from its target", () => {
    // Targets: single_page 18, ambiguous 3. This set has 15 and 1.
    const questions = [
      ...Array.from({ length: 15 }, (_, i) => makeQuestion({ id: `single-${i}` })),
      makeQuestion({ id: "ambiguous-1", category: "ambiguous" }),
    ];
    const setWarnings = (set: GoldQuestion[]) =>
      lintQuestions(set, passages, sourceExists)
        .filter((problem) => problem.question_id === null)
        .map((problem) => problem.message);

    const warnings = setWarnings(questions);
    expect(warnings).toContain("Category single_page has 15 of a target of 18 questions.");
    // 1 of 3 is 2 away, which is still fine.
    expect(warnings.some((message) => message.includes("ambiguous"))).toBe(false);
    expect(warnings).toContain("Category numbers has 0 of a target of 10 questions.");

    // One more single_page question makes 16 of 18, which is 2 away.
    const more = [...questions, makeQuestion({ id: "single-15" })];
    expect(setWarnings(more).some((message) => message.includes("single_page"))).toBe(false);
  });
});

describe("gold set lookups in MongoDB", () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    // Inserted in reverse, so the order of the results comes from the sort and not from the insert.
    await passagesCollection(db).insertMany(samplePassages().reverse());
  });

  afterAll(async () => {
    await drop();
  });

  it("finds every passage of a page, ordered by part and position", async () => {
    const found = await findPassagesForSource(db, "/graduate-visa");

    expect(found).toHaveLength(13);
    expect(found.slice(0, 3).map((passage) => passage._id)).toEqual([
      "/graduate-visa#apply#1",
      "/graduate-visa#apply#2",
      "/graduate-visa#course-you-studied#1",
    ]);
  });

  it("finds only the passages of one part when the source names a part", async () => {
    const found = await findPassagesForSource(db, "/graduate-visa/overview");

    expect(found.map((passage) => passage._id)).toEqual([
      "/graduate-visa#overview#1",
      "/graduate-visa#overview#2",
      "/graduate-visa#overview#3",
    ]);
  });

  it("finds nothing for a source that matches no passage", async () => {
    expect(await findPassagesForSource(db, "/graduate-visa/fees")).toEqual([]);
    expect(await findPassagesForSource(db, "/student-visa")).toEqual([]);
  });

  it("lints against the passages in the database", async () => {
    const good = makeQuestion();
    const bad = makeQuestion({
      id: "q-002",
      gold_sources: ["/student-visa"],
      evidence: [{ point: POINT, passage_id: "/student-visa#overview#1", quote: phd.quote }],
    });

    const problems = await lintWithDb(db, [good, bad]);

    expect(problems.filter((problem) => problem.question_id === "q-001")).toEqual([]);
    expect(
      problems.filter((problem) => problem.question_id === "q-002").map((p) => p.message),
    ).toEqual([
      "Gold source /student-visa matches no passage.",
      "Evidence passage /student-visa#overview#1 does not exist.",
    ]);
  });
});
