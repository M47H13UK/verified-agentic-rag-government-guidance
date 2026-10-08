// The judge audit sheet as the labelling page reads and writes it. See `npm run judge:check`.
// `readSheet` and `writeSheet` touch the file. Every other function is plain data in, plain data out.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseCsv, toCsv } from "../../src/eval/judgeAudit";

/** The invisible character that marks a file as UTF-8. Excel needs it at the start of a CSV. */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** The columns the page uses. The sheet has more, and a save keeps them as they are. */
const COLUMNS = ["id", "kind", "question", "to_label", "evidence", "human_label"];

const CLAIM_LABELS = ["supported", "partially_supported", "not_supported"];

// The sentences that `writeAuditFiles` in src/eval/judgeAudit.ts puts in the evidence cell.
const NO_CITATION = "The claim cites no passage.";
const MISSING_PASSAGE = "This passage is missing.";

/** One passage that a claim cites, and the words the claim quotes from it. */
export type Citation = {
  quote: string;
  passage_id: string;
  /** The address of the page, and the passage text. Both are null when the passage is missing. */
  url: string | null;
  text: string | null;
};

type SharedFields = {
  id: string;
  question: string;
  /** Empty when the row is not labelled yet. */
  human_label: string;
  /** Stands for everything in the row but its label. See `rowHash`. */
  row_hash: string;
};

export type ClaimItem = SharedFields & {
  kind: "claim";
  claim: string;
  citations: Citation[];
};

export type AnswerItem = SharedFields & {
  kind: "answer";
  summary: string;
  claims: string[];
  expected_points: string[];
  must_not_say: string[];
};

export type SheetItem = ClaimItem | AnswerItem;

// ---------- The file ----------

/** Reads the sheet into rows of cells. The first row is the header. */
export function readSheet(path: string): string[][] {
  const raw = readFileSync(path, "utf8");
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(1) : raw;
  // In some languages a spreadsheet program saves with semicolons between cells instead of commas.
  const firstLine = text.split("\n")[0] ?? "";
  return parseCsv(text, firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",");
}

/**
 * Writes the rows back in the format `audit-sample` wrote them, byte order mark included.
 * The whole file is written under another name and then renamed over the real one.
 * A rename either happens or does not, so a crash during the write cannot leave half a file.
 */
export function writeSheet(path: string, rows: string[][]): void {
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, BYTE_ORDER_MARK + toCsv(rows));
  renameSync(temporaryPath, path);
}

// ---------- Rows to items ----------

function checkHeader(header: string[]): void {
  const missing = COLUMNS.filter((name) => !header.includes(name));
  if (missing.length > 0) {
    throw new Error(`The sheet has no column named ${missing.join(" or ")}.`);
  }
}

/**
 * Turns the rows into the items the page shows, in the order of the sheet.
 * Throws when a row is not in the format `audit-sample` writes.
 */
export function sheetItems(rows: string[][]): SheetItem[] {
  const header = rows[0];
  // An empty file has no header and nothing to label.
  if (!header) return [];
  checkHeader(header);
  const cell = (row: string[], name: string): string => row[header.indexOf(name)] ?? "";

  const items: SheetItem[] = [];
  for (const row of rows.slice(1)) {
    const id = cell(row, "id").trim();
    // A spreadsheet program can leave an empty line in the file.
    if (id === "") continue;

    const kind = cell(row, "kind").trim();
    const shared = {
      id,
      question: cell(row, "question"),
      human_label: cell(row, "human_label").trim(),
      row_hash: rowHash(header, row),
    };
    if (kind === "claim") {
      const citations = parseClaimEvidence(cell(row, "evidence"));
      if (!citations) throw new Error(unreadable(id));
      items.push({ ...shared, kind, claim: cell(row, "to_label"), citations });
    } else if (kind === "answer") {
      const lists = parseAnswerEvidence(cell(row, "evidence"));
      if (!lists) throw new Error(unreadable(id));
      items.push({ ...shared, kind, ...parseAnswerText(cell(row, "to_label")), ...lists });
    } else {
      throw new Error(`Row ${id} has the kind "${kind}". It must be claim or answer.`);
    }
  }
  return items;
}

function unreadable(id: string): string {
  return `The evidence cell of row ${id} is not in the format audit-sample writes.`;
}

/**
 * A fingerprint of everything in a row but its label. The page gets it with each item and sends
 * it back with a save. When a new sample has replaced the sheet in between, the row with that ID
 * holds another claim or answer. Its fingerprint then differs, and the server refuses the save.
 */
export function rowHash(header: string[], row: string[]): string {
  const labelColumn = header.indexOf("human_label");
  const content = row.filter((_, index) => index !== labelColumn);
  return createHash("sha1").update(JSON.stringify(content)).digest("hex");
}

// ---------- The evidence cell ----------

/**
 * The first lines of one citation. The quote can run over several lines, so it ends at the
 * first `" from passage`. The passage ID is the rest of that line.
 */
const CITATION = /^Quoted "([\s\S]*?)" from passage ([^\n]*)\n([\s\S]*)$/;

/**
 * Reads the evidence cell of a claim row into its citations.
 * Returns null when the cell is not in the format `audit-sample` writes.
 */
export function parseClaimEvidence(cell: string): Citation[] | null {
  if (cell === NO_CITATION) return [];

  // Citations are joined by a blank line. A passage text can hold blank lines too,
  // so a new citation only starts where `Quoted "` follows the blank line.
  const citations: Citation[] = [];
  for (const block of cell.split(/\n\n(?=Quoted ")/)) {
    const match = CITATION.exec(block);
    if (!match) return null;
    const [, quote = "", passageId = "", rest = ""] = match;

    if (rest === MISSING_PASSAGE) {
      citations.push({ quote, passage_id: passageId, url: null, text: null });
      continue;
    }
    // The address of the page is on one line. The passage text is everything after it.
    const lineEnd = rest.indexOf("\n");
    if (lineEnd === -1) return null;
    citations.push({
      quote,
      passage_id: passageId,
      url: rest.slice(0, lineEnd),
      text: rest.slice(lineEnd + 1),
    });
  }
  return citations;
}

const ANSWER_EVIDENCE = /^Expected points\n([\s\S]*?)\n\nMust not say\n([\s\S]*)$/;

/**
 * Reads the evidence cell of an answer row into its two lists.
 * Returns null when the cell is not in the format `audit-sample` writes.
 */
export function parseAnswerEvidence(
  cell: string,
): { expected_points: string[]; must_not_say: string[] } | null {
  const match = ANSWER_EVIDENCE.exec(cell);
  if (!match) return null;
  const expectedPoints = numberedList(match[1] ?? "");
  const mustNotSay = numberedList(match[2] ?? "");
  if (!expectedPoints || !mustNotSay) return null;
  return { expected_points: expectedPoints, must_not_say: mustNotSay };
}

/** Reads "[0] first\n[1] second" back into a list. "None." is the empty list. */
function numberedList(text: string): string[] | null {
  if (text === "None.") return [];
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const prefix = `[${items.length}] `;
    if (line.startsWith(prefix)) {
      items.push(line.slice(prefix.length));
    } else if (items.length > 0) {
      // A line without the next number is a later line of the item above it.
      items[items.length - 1] += `\n${line}`;
    } else {
      return null;
    }
  }
  return items;
}

/**
 * Splits the text of an answer into its summary and its claims.
 * `audit-sample` writes the summary first and then every claim on a line that starts with "- ".
 */
export function parseAnswerText(cell: string): { summary: string; claims: string[] } {
  const summary: string[] = [];
  const claims: string[] = [];
  for (const line of cell.split("\n")) {
    if (line.startsWith("- ")) claims.push(line.slice(2));
    else if (claims.length === 0) summary.push(line);
    // A later line of the claim above it.
    else claims[claims.length - 1] += `\n${line}`;
  }
  return { summary: summary.join("\n"), claims };
}

// ---------- Labels ----------

/**
 * Tidies a label, or throws when the scoring would not accept it. The rules are those of
 * `cleanLabel` in src/eval/judgeAudit.ts. An empty label is allowed here. It clears the cell.
 */
export function cleanLabel(kind: SheetItem["kind"], raw: string): string {
  const label = raw.trim().toLowerCase();
  if (label === "") return "";
  if (kind === "claim") {
    if (!CLAIM_LABELS.includes(label)) {
      throw new Error(
        `"${raw}" is not a label for a claim. Use supported, partially_supported or not_supported.`,
      );
    }
    return label;
  }
  const count = Number(label);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`"${raw}" is not a label for an answer. Use a whole number.`);
  }
  // Going through a number makes "3.0" read as "3".
  return String(count);
}

/**
 * Returns the rows with the `human_label` cell of one row replaced.
 * Every other cell is the same as before.
 */
export function setLabel(rows: string[][], id: string, label: string): string[][] {
  const header = rows[0] ?? [];
  checkHeader(header);
  const idColumn = header.indexOf("id");
  const labelColumn = header.indexOf("human_label");
  return rows.map((row, index) => {
    if (index === 0 || (row[idColumn] ?? "").trim() !== id) return row;
    const changed = [...row];
    changed[labelColumn] = label;
    return changed;
  });
}
