import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CATEGORY_TARGETS } from "../../src/eval/lint";
import {
  assertAllVerified,
  assertScorable,
  loadQuestions,
  questionSchema,
  saveQuestions,
} from "../../src/eval/questions";
import type { GoldQuestion } from "../../src/eval/types";

/** A valid question. Each test changes the one field it is about. */
function makeQuestion(changes: Partial<GoldQuestion> = {}): GoldQuestion {
  return {
    id: "q-001",
    persona: 1,
    category: "single_page",
    question: "How long does a Graduate visa last?",
    expected_behaviour: "answer",
    expected_points: ["It lasts 3 years if you have a PhD."],
    gold_sources: ["/graduate-visa"],
    must_not_say: ["It can be extended."],
    verified_by: null,
    verified_on: null,
    ...changes,
  };
}

describe("questionSchema", () => {
  it("accepts a question with and without the optional fields", () => {
    expect(questionSchema.safeParse(makeQuestion()).success).toBe(true);

    const full = makeQuestion({
      notes: "From the overview part.",
      evidence: [
        {
          point: "It lasts 3 years if you have a PhD.",
          passage_id: "/graduate-visa#overview#2",
          quote: "it will last for 3 years",
        },
      ],
      verified_by: "A Checker",
      verified_on: "2026-10-06",
    });
    expect(questionSchema.parse(full)).toEqual(full);
  });

  it("accepts every category that has a target, and no other", () => {
    for (const category of Object.keys(CATEGORY_TARGETS)) {
      expect(questionSchema.safeParse({ ...makeQuestion(), category }).success).toBe(true);
    }
    expect(questionSchema.safeParse({ ...makeQuestion(), category: "easy" }).success).toBe(false);
  });

  it("rejects a persona outside 1 to 6", () => {
    for (const persona of [0, 7, 1.5]) {
      expect(questionSchema.safeParse(makeQuestion({ persona })).success).toBe(false);
    }
    expect(questionSchema.safeParse(makeQuestion({ persona: 6 })).success).toBe(true);
  });

  it("rejects a misspelt key instead of dropping it", () => {
    const misspelt = { ...makeQuestion(), expected_behavior: "answer" };
    expect(questionSchema.safeParse(misspelt).success).toBe(false);
  });

  it("rejects a verified_on that is not a date", () => {
    const question = makeQuestion({ verified_by: "A Checker", verified_on: "6 October" });
    expect(questionSchema.safeParse(question).success).toBe(false);
  });
});

describe("loadQuestions and saveQuestions", () => {
  const dir = mkdtempSync(join(tmpdir(), "gold-set-"));
  const path = join(dir, "questions.jsonl");

  afterAll(() => {
    rmSync(dir, { recursive: true });
  });

  it("saves questions and loads the same questions back", () => {
    const questions = [
      makeQuestion(),
      makeQuestion({
        id: "q-002",
        category: "not_covered",
        expected_behaviour: "decline",
        expected_points: [],
        gold_sources: [],
        notes: "Outside the corpus.",
        verified_by: "A Checker",
        verified_on: "2026-10-06",
      }),
    ];

    saveQuestions(path, questions);

    expect(loadQuestions(path)).toEqual(questions);
    // One question per line, and the temporary file is gone.
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(3);
    expect(readdirSync(dir)).toEqual(["questions.jsonl"]);
  });

  it("writes the keys in one fixed order, whatever order they came in", () => {
    const shuffled = {
      verified_on: null,
      must_not_say: [],
      question: "How much does it cost?",
      notes: "A note.",
      id: "q-003",
      gold_sources: ["/graduate-visa"],
      verified_by: null,
      expected_points: ["It costs £937."],
      category: "numbers",
      persona: 2,
      expected_behaviour: "answer",
    } as GoldQuestion;

    saveQuestions(path, [shuffled]);

    const saved = JSON.parse(readFileSync(path, "utf8")) as GoldQuestion;
    expect(Object.keys(saved)).toEqual([
      "id",
      "persona",
      "category",
      "question",
      "expected_behaviour",
      "expected_points",
      "gold_sources",
      "must_not_say",
      "notes",
      "verified_by",
      "verified_on",
    ]);
  });

  it("refuses to save a bad question and leaves the file as it was", () => {
    saveQuestions(path, [makeQuestion()]);
    const before = readFileSync(path, "utf8");

    expect(() => saveQuestions(path, [makeQuestion(), makeQuestion({ persona: 9 })])).toThrow();

    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("skips blank lines", () => {
    const line = JSON.stringify(makeQuestion());
    writeFileSync(path, `\n${line}\n\n   \n${line.replace("q-001", "q-002")}\n\n`);

    expect(loadQuestions(path).map((question) => question.id)).toEqual(["q-001", "q-002"]);
  });

  it("names the line number of a question that does not match the schema", () => {
    const good = JSON.stringify(makeQuestion());
    const bad = JSON.stringify({ ...makeQuestion(), category: "easy" });
    // Line 2 is blank. Blank lines still count, so the number matches what an editor shows.
    writeFileSync(path, `${good}\n\n${bad}\n`);

    expect(() => loadQuestions(path)).toThrow(/questions\.jsonl line 3 .*category/);
  });

  it("names the line number of a line that is not JSON", () => {
    writeFileSync(path, `${JSON.stringify(makeQuestion())}\n{"id": "q-002",\n`);

    expect(() => loadQuestions(path)).toThrow(/line 2 is not valid JSON/);
  });
});

describe("assertAllVerified", () => {
  const verified = { verified_by: "A Checker", verified_on: "2026-10-06" };

  it("passes when every question is verified", () => {
    expect(() =>
      assertAllVerified([makeQuestion(verified), makeQuestion({ id: "q-002", ...verified })]),
    ).not.toThrow();
  });

  it("throws and lists the IDs of the unverified questions", () => {
    const questions = [
      makeQuestion({ id: "q-001" }),
      makeQuestion({ id: "q-002", ...verified }),
      makeQuestion({ id: "q-003" }),
    ];

    expect(() => assertAllVerified(questions)).toThrow(
      "2 of 3 gold questions are not verified: q-001, q-003.",
    );
  });
});

describe("assertScorable", () => {
  it("passes a set the eval can score", () => {
    const decline = makeQuestion({
      id: "q-002",
      expected_behaviour: "decline",
      expected_points: [],
    });
    expect(() => assertScorable([makeQuestion(), decline])).not.toThrow();
  });

  it("rejects two questions with the same ID", () => {
    expect(() => assertScorable([makeQuestion(), makeQuestion()])).toThrow("q-001 is used twice");
  });

  it("rejects an answer question with no expected points", () => {
    expect(() => assertScorable([makeQuestion({ expected_points: [] })])).toThrow(
      "lists no expected points",
    );
  });

  it("rejects a decline question that lists expected points", () => {
    expect(() => assertScorable([makeQuestion({ expected_behaviour: "decline" })])).toThrow(
      "but lists expected points",
    );
  });
});
