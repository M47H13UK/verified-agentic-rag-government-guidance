import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PassageLookup } from "../../src/types";
import {
  parseCsv,
  sampleForAudit,
  scoreAudit,
  scoreReviews,
  seededRandom,
  toCsv,
  writeAuditFiles,
  type AuditItem,
} from "../../src/eval/judgeAudit";
import type { EvalRecord, GoldQuestion, Grade } from "../../src/eval/types";
import { samplePassages } from "../helpers/fixtures";
import { H0, H1, makeAnswer, makeGrade, makeQuestion, makeRecord, tempDir } from "./builders";

const passages = samplePassages();
const getPassages: PassageLookup = async (ids) =>
  new Map(passages.filter((p) => ids.includes(p._id)).map((p) => [p._id, p]));

/** Five questions answered by two setups. Every answer has 3 claims, so there are 30 claims. */
function fixture(): { questions: GoldQuestion[]; records: EvalRecord[]; grades: Grade[] } {
  const questions = [1, 2, 3, 4, 5].map((n) =>
    makeQuestion({ id: `q0${n}`, question: `Question ${n}?`, expected_points: ["P1.", "P2."] }),
  );
  const records: EvalRecord[] = [];
  const grades: Grade[] = [];
  for (const setup of [H0, H1]) {
    for (const question of questions) {
      const texts = ["First claim.", "Second claim.", "Third claim."];
      records.push(makeRecord(setup, question, makeAnswer(texts)));
      grades.push(
        makeGrade({
          question_id: question.id,
          setup_id: setup.id,
          points: [
            { point: "P1.", present: true },
            { point: "P2.", present: false },
          ],
          claims: [
            { claim_index: 0, verdict: "supported", reason: "Stated." },
            { claim_index: 1, verdict: "partially_supported", reason: "Adds a detail." },
            { claim_index: 2, verdict: "not_supported", reason: "Not stated." },
          ],
          total_claims: 3,
          unsupported_claims: 1,
          correctness: 0.5,
        }),
      );
    }
  }
  return { questions, records, grades };
}

describe("seededRandom", () => {
  it("gives the same numbers for the same seed, all from 0 up to but not including 1", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const fromA = [a(), a(), a(), a(), a()];
    expect(fromA).toEqual([b(), b(), b(), b(), b()]);
    expect(fromA.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(fromA).size).toBe(5);
  });
});

describe("sampleForAudit", () => {
  const { records, grades } = fixture();
  const options = { claims: 6, answers: 4, seed: 1 };

  it("draws the asked number of claims and answers and gives them neutral IDs", () => {
    const items = sampleForAudit(records, grades, options);

    expect(items.map((item) => item.id)).toEqual([
      "c01",
      "c02",
      "c03",
      "c04",
      "c05",
      "c06",
      "a01",
      "a02",
      "a03",
      "a04",
    ]);
    // 1 of the 2 points is present and nothing forbidden was said, so the judge's label is 1.
    expect(items.filter((item) => item.kind === "answer").map((item) => item.judge_label)).toEqual([
      "1",
      "1",
      "1",
      "1",
    ]);
  });

  it("draws the same sample for the same seed, whatever order the files were in", () => {
    const first = sampleForAudit(records, grades, options);
    const second = sampleForAudit([...records].reverse(), [...grades].reverse(), options);
    expect(second).toEqual(first);
  });

  it("draws a different sample for a different seed", () => {
    const first = sampleForAudit(records, grades, options);
    const other = sampleForAudit(records, grades, { ...options, seed: 2 });
    expect(other).not.toEqual(first);
  });

  it("never draws the same claim twice and stops when there is nothing left", () => {
    const items = sampleForAudit(records, grades, { claims: 100, answers: 100, seed: 1 });
    const claims = items.filter((item) => item.kind === "claim");
    const keys = claims.map((c) => `${c.setup_id} ${c.question_id} ${c.claim_index}`);

    expect(claims).toHaveLength(30);
    expect(new Set(keys).size).toBe(30);
    expect(items.filter((item) => item.kind === "answer")).toHaveLength(10);
  });

  it("leaves out grades with a judge error", () => {
    const broken = grades.map((grade) => ({ ...grade, judge_error: "overloaded" }));
    expect(sampleForAudit(records, broken, options)).toEqual([]);
  });
});

describe("CSV", () => {
  it("reads back what it wrote, with commas, quotes and line breaks inside cells", () => {
    const rows = [
      ["id", "text"],
      ["c01", 'He said "no", then left.'],
      ["c02", "Line one\nLine two"],
      ["c03", ""],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it("reads unquoted cells, Windows line endings and a missing final line break", () => {
    expect(parseCsv("id,label\r\nc01,supported\r\nc02,")).toEqual([
      ["id", "label"],
      ["c01", "supported"],
      ["c02", ""],
    ]);
  });
});

describe("writeAuditFiles and scoreAudit", () => {
  /** Writes the sheet and the key into a temp folder and returns where they are. */
  async function writeSheet() {
    const { questions, records, grades } = fixture();
    const items = sampleForAudit(records, grades, { claims: 6, answers: 4, seed: 1 });
    const dir = tempDir();
    const paths = { csvPath: join(dir, "judge-audit.csv"), keyPath: join(dir, "key.json") };
    await writeAuditFiles(items, { records, questions, getPassages }, paths);
    return { items, paths };
  }

  /** Fills in the sheet the way a person would. `label` picks the label for each item. */
  function fillIn(csvPath: string, items: AuditItem[], label: (item: AuditItem) => string): void {
    const rows = parseCsv(readFileSync(csvPath, "utf8").slice(1));
    const labelColumn = rows[0]!.indexOf("human_label");
    rows.slice(1).forEach((row, index) => {
      row[labelColumn] = label(items[index]!);
    });
    writeFileSync(csvPath, toCsv(rows));
  }

  it("writes a sheet with empty labels that shows the passage and hides the judge", async () => {
    const { items, paths } = await writeSheet();
    const sheet = readFileSync(paths.csvPath, "utf8");
    const rows = parseCsv(sheet.slice(1));
    const header = rows[0]!;

    expect(rows).toHaveLength(items.length + 1);
    expect(header).not.toContain("judge_label");
    expect(header).not.toContain("setup_id");
    expect(rows.slice(1).every((row) => row[header.indexOf("human_label")] === "")).toBe(true);
    // A claim row shows the text of the passage the claim cites.
    expect(sheet).toContain(passages[1]!.text.slice(0, 80));
    expect(sheet).toContain(
      "Contains public sector information licensed under the Open Government Licence v3.0.",
    );
    // The judge's labels are in the key file only.
    const key = JSON.parse(readFileSync(paths.keyPath, "utf8")) as AuditItem[];
    expect(key).toEqual(items);
  });

  it("reports full agreement when the person agrees with the judge everywhere", async () => {
    const { items, paths } = await writeSheet();
    fillIn(paths.csvPath, items, (item) => item.judge_label);

    const score = scoreAudit(paths.csvPath, paths.keyPath);
    expect(score.labelled).toBe(10);
    expect(score.agreement_rate).toBe(1);
    expect(score.disagreements).toEqual([]);
  });

  it("reports the agreement rate and lists each disagreement", async () => {
    const { items, paths } = await writeSheet();
    // The person disagrees on the first claim and the first answer, and skips the last answer.
    fillIn(paths.csvPath, items, (item) => {
      if (item.id === "c01")
        return item.judge_label === "supported" ? "not_supported" : "supported";
      if (item.id === "a01") return "2";
      if (item.id === "a04") return "";
      return item.judge_label;
    });

    const score = scoreAudit(paths.csvPath, paths.keyPath);

    expect(score.labelled).toBe(9);
    expect(score.unlabelled).toBe(1);
    expect(score.agreed).toBe(7);
    expect(score.agreement_rate).toBeCloseTo(7 / 9);
    expect(score.claims).toEqual({ labelled: 6, agreed: 5 });
    expect(score.answers).toEqual({ labelled: 3, agreed: 2 });
    expect(score.disagreements.map((item) => item.id)).toEqual(["c01", "a01"]);
    expect(score.disagreements[1]).toMatchObject({ human_label: "2", judge_label: "1" });
  });

  it("reads a sheet that a spreadsheet saved with semicolons and extra capitals", async () => {
    const { items, paths } = await writeSheet();
    const rows = parseCsv(readFileSync(paths.csvPath, "utf8").slice(1));
    const labelColumn = rows[0]!.indexOf("human_label");
    rows.slice(1).forEach((row, index) => {
      row[labelColumn] = ` ${items[index]!.judge_label.toUpperCase()} `;
    });
    const withSemicolons = rows
      .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(";"))
      .join("\r\n");
    writeFileSync(paths.csvPath, withSemicolons);

    expect(scoreAudit(paths.csvPath, paths.keyPath).agreement_rate).toBe(1);
  });

  it("rejects a label that is not one of the allowed ones, and names the row", async () => {
    const { items, paths } = await writeSheet();
    fillIn(paths.csvPath, items, (item) => (item.id === "c02" ? "suported" : item.judge_label));

    expect(() => scoreAudit(paths.csvPath, paths.keyPath)).toThrow(
      /Row c02 has the label "suported"/,
    );
  });
});

describe("scoreReviews", () => {
  /** Two claims and one answer, with the judge's labels. */
  const key: AuditItem[] = [
    { id: "c01", kind: "claim", judge_label: "supported" },
    { id: "c02", kind: "claim", judge_label: "partially_supported" },
    { id: "a01", kind: "answer", judge_label: "2" },
  ].map((item) => ({
    ...item,
    kind: item.kind as "claim" | "answer",
    question_id: "q01",
    setup_id: "H0",
    repeat: 1,
    claim_index: item.kind === "claim" ? 0 : null,
  }));

  /** Writes the key and a reviews file where each reviewer gives the labels in `given`. */
  function writeReviews(given: Record<string, string[]>): { reviews: string; key: string } {
    const dir = tempDir();
    const paths = { reviews: join(dir, "reviews.json"), key: join(dir, "key.json") };
    writeFileSync(paths.key, JSON.stringify(key));
    writeFileSync(
      paths.reviews,
      JSON.stringify({
        reviewers: Object.keys(given).map((id) => ({ id, model: `model-${id}`, run_as: "" })),
        labels: key.map((item, index) => ({
          id: item.id,
          ...Object.fromEntries(
            Object.entries(given).map(([id, labels]) => [
              id,
              { label: labels[index], reason: "r" },
            ]),
          ),
        })),
      }),
    );
    return paths;
  }

  it("counts agreement with the judge for each reviewer, by kind of item", () => {
    // The first reviewer agrees everywhere. The second differs on one claim and on the answer.
    const paths = writeReviews({
      one: ["supported", "partially_supported", "2"],
      two: ["supported", "supported", "1"],
    });
    const score = scoreReviews(paths.reviews, paths.key);

    expect(score.items).toBe(3);
    expect(score.reviewers[0]).toMatchObject({ id: "one", model: "model-one", agreed: 3 });
    expect(score.reviewers[1]).toMatchObject({
      id: "two",
      agreed: 1,
      claims: { items: 2, agreed: 1 },
      answers: { items: 1, agreed: 0 },
    });
    expect(score.reviewers_agree).toBe(1);
    expect(score.all_agree).toBe(1);
    expect(score.split.map((item) => item.id)).toEqual(["c02", "a01"]);
    expect(score.split[0]!.labels).toEqual({ one: "partially_supported", two: "supported" });
  });

  it("lists an item where the reviewers agree with each other and not with the judge", () => {
    const paths = writeReviews({
      one: ["supported", "supported", "2"],
      two: ["supported", "supported", "2.0"],
    });
    const score = scoreReviews(paths.reviews, paths.key);

    // "2.0" reads as 2, the same way a person's label does.
    expect(score.reviewers_agree).toBe(3);
    expect(score.all_agree).toBe(2);
    expect(score.split.map((item) => item.id)).toEqual(["c02"]);
  });

  it("rejects a file where a reviewer has no label for an item", () => {
    const paths = writeReviews({ one: ["supported", "supported", "2"] });
    const file = JSON.parse(readFileSync(paths.reviews, "utf8")) as {
      labels: Record<string, unknown>[];
    };
    delete file.labels[1]!.one;
    writeFileSync(paths.reviews, JSON.stringify(file));

    expect(() => scoreReviews(paths.reviews, paths.key)).toThrow(/no label from one for c02/);
  });
});
