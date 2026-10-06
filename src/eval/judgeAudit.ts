// The judge audit. A person labels a random sample of the judge's decisions without seeing
// them, and the two sets of labels are compared. This says how far the judge can be trusted.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Passage, Verdict } from "../types";
import type { PassageLookup } from "../types";
import { isUsableGrade } from "./grade";
import type { EvalRecord, GoldQuestion, Grade } from "./types";

/** The sheet the person fills in. */
export const AUDIT_CSV_PATH = "eval/judge-audit.csv";

/** The judge's labels for the same items. Kept apart so the person labelling cannot see them. */
export const AUDIT_KEY_PATH = "eval/judge-audit-key.json";

const LICENCE_LINE =
  "Contains public sector information licensed under the Open Government Licence v3.0.";

const VERDICTS: Verdict[] = ["supported", "partially_supported", "not_supported"];

/**
 * The invisible character that marks a file as UTF-8. Excel needs it at the start of a CSV.
 * Without it, pound signs and curly quotes come out as the wrong characters.
 */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const CLAIM_INSTRUCTIONS =
  "Read the claim and the passages it cites. Write supported, partially_supported or not_supported.";
const ANSWER_INSTRUCTIONS =
  "Write how many of the expected points the answer states, as a number. " +
  "Write 0 if it states a must-not-say statement or contradicts an expected point.";

export type AuditItem = {
  /** "c01" for a claim, "a01" for an answer. The ID gives no hint of which setup wrote it. */
  id: string;
  kind: "claim" | "answer";
  question_id: string;
  setup_id: string;
  repeat: number;
  /** Which claim of the answer. Null for an answer item. */
  claim_index: number | null;
  /** What the judge decided. It goes in the key file and never in the sheet. */
  judge_label: string;
};

// ---------- Sampling ----------

/**
 * A small seeded random number generator (a linear congruential generator).
 * Each call multiplies the state, adds a constant and wraps around at 2 to the power 32.
 * The same seed always gives the same numbers, so a sample can be drawn again exactly.
 * `Math.random` cannot be seeded, which is why it is not used here.
 */
export function seededRandom(seed: number): () => number {
  let state = Math.abs(Math.floor(seed)) % 4294967296;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Returns a shuffled copy of the list (the Fisher-Yates shuffle). */
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const held = result[i]!;
    result[i] = result[j]!;
    result[j] = held;
  }
  return result;
}

/**
 * The single label the judge's reading of an answer comes down to.
 * It is the number of expected points present, or 0 when the answer said something it must
 * not say or contradicted a point. The correctness score is built from this same number.
 */
function answerLabel(grade: Grade): string {
  if (grade.must_not_say_hits.length > 0 || grade.contradiction) return "0";
  return String(grade.points.filter((point) => point.present).length);
}

/**
 * Picks the items a person will label. Every claim the judge gave a verdict on can be picked,
 * and so can every answer to an answer question. The pick is uniform, so it mirrors what the
 * judge mostly sees. The same records, grades and seed always give the same sample.
 */
export function sampleForAudit(
  records: EvalRecord[],
  grades: Grade[],
  options: { claims: number; answers: number; seed: number },
): AuditItem[] {
  const key = (row: { setup_id: string; repeat: number; question_id: string }): string =>
    `${row.setup_id} ${row.repeat} ${row.question_id}`;
  const recordByKey = new Map(records.map((record) => [key(record), record]));

  // Runs are written in the order they finish, which changes from one batch to the next.
  // Sorting first makes the sample depend on the seed alone.
  const usable = grades
    .filter((grade) => {
      const record = recordByKey.get(key(grade));
      return record !== undefined && isUsableGrade(grade, record);
    })
    .sort((a, b) => key(a).localeCompare(key(b)));

  type Candidate = Omit<AuditItem, "id">;
  const claimPool: Candidate[] = [];
  const answerPool: Candidate[] = [];
  for (const grade of usable) {
    const where = {
      question_id: grade.question_id,
      setup_id: grade.setup_id,
      repeat: grade.repeat,
    };
    for (const claim of grade.claims) {
      claimPool.push({
        ...where,
        kind: "claim",
        claim_index: claim.claim_index,
        judge_label: claim.verdict,
      });
    }
    // Only answer questions have expected points, so only they have a reading to check.
    if (grade.points.length > 0 && grade.behaviour === "answered") {
      answerPool.push({
        ...where,
        kind: "answer",
        claim_index: null,
        judge_label: answerLabel(grade),
      });
    }
  }

  const random = seededRandom(options.seed);
  const claims = shuffle(claimPool, random).slice(0, options.claims);
  const answers = shuffle(answerPool, random).slice(0, options.answers);
  const number = (index: number): string => String(index + 1).padStart(2, "0");
  return [
    ...claims.map((item, index) => ({ id: `c${number(index)}`, ...item })),
    ...answers.map((item, index) => ({ id: `a${number(index)}`, ...item })),
  ];
}

// ---------- CSV ----------

/** Writes rows as CSV. Every cell is quoted, and a quote inside a cell is doubled. */
export function toCsv(rows: string[][]): string {
  return rows
    .map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(","))
    .join("\n")
    .concat("\n");
}

/**
 * Reads CSV text into rows of cells. It handles quoted cells, doubled quotes and line breaks
 * inside a cell, which is everything a spreadsheet program writes.
 */
export function parseCsv(text: string, separator = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        // Two quotes in a row inside a quoted cell stand for one quote.
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  // The last row when the text does not end with a line break.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------- Writing the sheet ----------

function numbered(items: string[]): string {
  if (items.length === 0) return "None.";
  return items.map((item, index) => `[${index}] ${item}`).join("\n");
}

/**
 * Writes the sheet to label and the key file.
 * It looks up the passages that the sampled claims cite, so the person labelling reads the
 * same text the judge read.
 */
export async function writeAuditFiles(
  items: AuditItem[],
  context: { records: EvalRecord[]; questions: GoldQuestion[]; getPassages: PassageLookup },
  paths: { csvPath: string; keyPath: string },
): Promise<void> {
  const questionById = new Map(context.questions.map((question) => [question.id, question]));

  // Pair every item with its answer and its question before anything is written.
  const entries = items.map((item) => {
    const record = context.records.find(
      (r) =>
        r.question_id === item.question_id &&
        r.setup_id === item.setup_id &&
        r.repeat === item.repeat,
    );
    const answer = record?.run.final_answer;
    const question = questionById.get(item.question_id);
    if (!answer || !question) {
      throw new Error(`The run or the question for audit item ${item.id} is missing.`);
    }
    const claim = item.claim_index === null ? null : (answer.claims[item.claim_index] ?? null);
    if (item.kind === "claim" && !claim) {
      throw new Error(`The claim for audit item ${item.id} is missing.`);
    }
    return { item, answer, question, claim };
  });

  const ids = new Set<string>();
  for (const { claim } of entries) {
    for (const citation of claim?.citations ?? []) ids.add(citation.passage_id);
  }
  const passages = ids.size > 0 ? await context.getPassages([...ids]) : new Map<string, Passage>();

  const header = [
    "id",
    "kind",
    "question",
    "to_label",
    "evidence",
    "instructions",
    "human_label",
    "licence",
  ];
  const rows = entries.map(({ item, answer, question, claim }) => {
    let toLabel: string;
    let evidence: string;
    let instructions: string;
    if (claim) {
      toLabel = claim.text;
      evidence = claim.citations
        .map((citation) => {
          const passage = passages.get(citation.passage_id);
          const text = passage ? `${passage.url}\n${passage.text}` : "This passage is missing.";
          return `Quoted "${citation.quote}" from passage ${citation.passage_id}\n${text}`;
        })
        .join("\n\n");
      if (claim.citations.length === 0) evidence = "The claim cites no passage.";
      instructions = CLAIM_INSTRUCTIONS;
    } else {
      toLabel = [answer.summary, ...answer.claims.map((c) => `- ${c.text}`)].join("\n");
      evidence =
        `Expected points\n${numbered(question.expected_points)}\n\n` +
        `Must not say\n${numbered(question.must_not_say)}`;
      instructions = ANSWER_INSTRUCTIONS;
    }
    // The human_label cell is left empty for the person to fill in.
    return [
      item.id,
      item.kind,
      question.question,
      toLabel,
      evidence,
      instructions,
      "",
      LICENCE_LINE,
    ];
  });

  mkdirSync(dirname(paths.csvPath), { recursive: true });
  mkdirSync(dirname(paths.keyPath), { recursive: true });
  writeFileSync(paths.csvPath, BYTE_ORDER_MARK + toCsv([header, ...rows]));
  writeFileSync(paths.keyPath, JSON.stringify(items, null, 2) + "\n");
}

// ---------- Scoring ----------

export type AuditScore = {
  labelled: number;
  /** Rows the person has not filled in yet. They are left out of the rate. */
  unlabelled: number;
  agreed: number;
  /** Agreed divided by labelled. Null when nothing is labelled. */
  agreement_rate: number | null;
  claims: { labelled: number; agreed: number };
  answers: { labelled: number; agreed: number };
  disagreements: (AuditItem & { human_label: string })[];
};

/** Tidies a label typed by a person, or throws when it is not one of the allowed labels. */
function cleanLabel(raw: string, item: AuditItem): string {
  const label = raw.trim().toLowerCase();
  if (item.kind === "claim") {
    if (!VERDICTS.some((verdict) => verdict === label)) {
      throw new Error(
        `Row ${item.id} has the label "${raw}". Use supported, partially_supported or not_supported.`,
      );
    }
    return label;
  }
  const count = Number(label);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Row ${item.id} has the label "${raw}". Use a whole number.`);
  }
  // A spreadsheet may turn 3 into 3.0. Going through a number makes both read as "3".
  return String(count);
}

/**
 * Reads the filled-in sheet and compares it with the judge's labels in the key file.
 * Returns the agreement rate and every item where the two differ.
 */
export function scoreAudit(csvPath: string, keyPath: string): AuditScore {
  if (!existsSync(csvPath) || !existsSync(keyPath)) {
    throw new Error(`${csvPath} or ${keyPath} does not exist. Run audit-sample first.`);
  }
  const key = JSON.parse(readFileSync(keyPath, "utf8")) as AuditItem[];
  const itemById = new Map(key.map((item) => [item.id, item]));

  // A spreadsheet program may add a byte order mark, and in some languages it saves with
  // semicolons between cells instead of commas.
  const raw = readFileSync(csvPath, "utf8");
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  const firstLine = text.split("\n")[0] ?? "";
  const rows = parseCsv(text, firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",");

  const header = rows[0] ?? [];
  const idColumn = header.indexOf("id");
  const labelColumn = header.indexOf("human_label");
  if (idColumn === -1 || labelColumn === -1) {
    throw new Error(`${csvPath} needs the columns id and human_label.`);
  }

  const score: AuditScore = {
    labelled: 0,
    unlabelled: 0,
    agreed: 0,
    agreement_rate: null,
    claims: { labelled: 0, agreed: 0 },
    answers: { labelled: 0, agreed: 0 },
    disagreements: [],
  };

  for (const row of rows.slice(1)) {
    const id = (row[idColumn] ?? "").trim();
    if (id === "") continue;
    const item = itemById.get(id);
    if (!item) {
      throw new Error(
        `Row ${id} is not in ${keyPath}. The two files are not from the same sample.`,
      );
    }

    const typed = row[labelColumn] ?? "";
    if (typed.trim() === "") {
      score.unlabelled += 1;
      continue;
    }
    const humanLabel = cleanLabel(typed, item);
    const agreed = humanLabel === item.judge_label;
    const group = item.kind === "claim" ? score.claims : score.answers;

    score.labelled += 1;
    group.labelled += 1;
    if (agreed) {
      score.agreed += 1;
      group.agreed += 1;
    } else {
      score.disagreements.push({ ...item, human_label: humanLabel });
    }
  }

  if (score.labelled > 0) score.agreement_rate = score.agreed / score.labelled;
  return score;
}
