import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreAudit, toCsv, type AuditItem } from "../src/eval/judgeAudit";
import {
  cleanLabel,
  parseAnswerEvidence,
  parseAnswerText,
  parseClaimEvidence,
  readSheet,
  rowHash,
  setLabel,
  sheetItems,
  writeSheet,
} from "../scripts/lib/auditSheet";
import { tempDir } from "./eval/builders";

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

const HEADER = [
  "id",
  "kind",
  "question",
  "to_label",
  "evidence",
  "instructions",
  "human_label",
  "licence",
];

// The evidence cells below are written the way `writeAuditFiles` writes them.

/** A passage with a blank line inside it, cited with a quote that runs over two lines. */
const FEE_PASSAGE =
  "How much it costs\nThe fee is £880.\n\nYou also pay the “healthcare surcharge”.";
const FEE_CITATION =
  'Quoted "The fee is £880.\n\nYou also pay" from passage /graduate-visa#how-much-it-costs#1\n' +
  `https://www.gov.uk/graduate-visa/how-much-it-costs\n${FEE_PASSAGE}`;

const LENGTH_PASSAGE = "A Graduate visa lasts for 2 years.";
const LENGTH_CITATION =
  'Quoted "lasts for 2 years" from passage /graduate-visa#overview#2\n' +
  `https://www.gov.uk/graduate-visa\n${LENGTH_PASSAGE}`;

const MISSING_CITATION =
  'Quoted "You can work" from passage /gone#part#1\nThis passage is missing.';

const ANSWER_EVIDENCE =
  "Expected points\n[0] The fee is £880.\n[1] The visa lasts 2 years.\n\n" +
  "Must not say\n[0] The visa can be extended.";

/** A sheet of two claims and one answer. The cells hold commas, quotes, line breaks and pound signs. */
function sampleRows(): string[][] {
  const row = (id: string, kind: string, toLabel: string, evidence: string): string[] => [
    id,
    kind,
    `Question for ${id}, with a "quoted" word?`,
    toLabel,
    evidence,
    `Instructions for ${id}.`,
    "",
    "Licence line.",
  ];
  return [
    HEADER,
    row(
      "c01",
      "claim",
      "The fee is £880, and it lasts 2 years.",
      `${FEE_CITATION}\n\n${LENGTH_CITATION}`,
    ),
    row("c02", "claim", "You can work.", MISSING_CITATION),
    row(
      "a01",
      "answer",
      "It costs £880.\n- The fee is £880.\n- It lasts 2 years.",
      ANSWER_EVIDENCE,
    ),
  ];
}

/** Writes the sample sheet into a temp folder, as `audit-sample` would, and returns its path. */
function sampleFile(): string {
  const path = join(tempDir(), "judge-audit.csv");
  writeFileSync(path, BYTE_ORDER_MARK + toCsv(sampleRows()));
  return path;
}

describe("parseClaimEvidence", () => {
  it("reads two citations, one with a blank line inside its passage and its quote", () => {
    expect(parseClaimEvidence(`${FEE_CITATION}\n\n${LENGTH_CITATION}`)).toEqual([
      {
        quote: "The fee is £880.\n\nYou also pay",
        passage_id: "/graduate-visa#how-much-it-costs#1",
        url: "https://www.gov.uk/graduate-visa/how-much-it-costs",
        text: FEE_PASSAGE,
      },
      {
        quote: "lasts for 2 years",
        passage_id: "/graduate-visa#overview#2",
        url: "https://www.gov.uk/graduate-visa",
        text: LENGTH_PASSAGE,
      },
    ]);
  });

  it("keeps a quote mark that is inside the quote", () => {
    const cell = 'Quoted "the "new" route" from passage /p#s#1\nhttps://www.gov.uk/p\nText.';
    expect(parseClaimEvidence(cell)?.[0]?.quote).toBe('the "new" route');
  });

  it("gives no citations for a claim that cites no passage", () => {
    expect(parseClaimEvidence("The claim cites no passage.")).toEqual([]);
  });

  it("gives a citation with no address and no text for a missing passage", () => {
    expect(parseClaimEvidence(MISSING_CITATION)).toEqual([
      { quote: "You can work", passage_id: "/gone#part#1", url: null, text: null },
    ]);
  });

  it("reads a missing passage followed by one that is there", () => {
    const citations = parseClaimEvidence(`${MISSING_CITATION}\n\n${LENGTH_CITATION}`);
    expect(citations?.map((citation) => citation.text)).toEqual([null, LENGTH_PASSAGE]);
  });

  it("gives null for a cell in another format", () => {
    expect(parseClaimEvidence("")).toBeNull();
    expect(parseClaimEvidence("Some text typed by hand.")).toBeNull();
    expect(parseClaimEvidence(ANSWER_EVIDENCE)).toBeNull();
  });
});

describe("parseAnswerEvidence", () => {
  it("reads the expected points and the must-not-say statements", () => {
    expect(parseAnswerEvidence(ANSWER_EVIDENCE)).toEqual({
      expected_points: ["The fee is £880.", "The visa lasts 2 years."],
      must_not_say: ["The visa can be extended."],
    });
  });

  it("reads None. as an empty list", () => {
    expect(parseAnswerEvidence("Expected points\n[0] One point.\n\nMust not say\nNone.")).toEqual({
      expected_points: ["One point."],
      must_not_say: [],
    });
    expect(parseAnswerEvidence("Expected points\nNone.\n\nMust not say\nNone.")).toEqual({
      expected_points: [],
      must_not_say: [],
    });
  });

  it("keeps a point that runs over two lines as one point", () => {
    const cell = "Expected points\n[0] First line\nsecond line\n[1] Next.\n\nMust not say\nNone.";
    expect(parseAnswerEvidence(cell)?.expected_points).toEqual([
      "First line\nsecond line",
      "Next.",
    ]);
  });

  it("gives null for a cell in another format", () => {
    expect(parseAnswerEvidence("")).toBeNull();
    expect(parseAnswerEvidence(LENGTH_CITATION)).toBeNull();
    // A list that is neither numbered nor None.
    expect(parseAnswerEvidence("Expected points\nA point.\n\nMust not say\nNone.")).toBeNull();
  });
});

describe("parseAnswerText", () => {
  it("splits the summary from the claims", () => {
    expect(parseAnswerText("It costs £880.\n- The fee is £880.\n- It lasts 2 years.")).toEqual({
      summary: "It costs £880.",
      claims: ["The fee is £880.", "It lasts 2 years."],
    });
  });

  it("gives no claims for an answer that is only a summary", () => {
    expect(parseAnswerText("Just a summary.")).toEqual({ summary: "Just a summary.", claims: [] });
  });
});

describe("cleanLabel", () => {
  it("takes the three labels of a claim, in any case and with spaces around", () => {
    expect(cleanLabel("claim", "supported")).toBe("supported");
    expect(cleanLabel("claim", " Partially_Supported ")).toBe("partially_supported");
    expect(cleanLabel("claim", "not_supported")).toBe("not_supported");
  });

  it("refuses any other label for a claim", () => {
    expect(() => cleanLabel("claim", "partly")).toThrow(/not a label for a claim/);
    expect(() => cleanLabel("claim", "2")).toThrow(/not a label for a claim/);
  });

  it("takes a whole number of 0 or more for an answer", () => {
    expect(cleanLabel("answer", "0")).toBe("0");
    expect(cleanLabel("answer", " 3 ")).toBe("3");
    // A spreadsheet may turn 3 into 3.0.
    expect(cleanLabel("answer", "3.0")).toBe("3");
  });

  it("refuses anything else for an answer", () => {
    expect(() => cleanLabel("answer", "-1")).toThrow(/whole number/);
    expect(() => cleanLabel("answer", "1.5")).toThrow(/whole number/);
    expect(() => cleanLabel("answer", "supported")).toThrow(/whole number/);
  });

  it("lets an empty label through, which clears the cell", () => {
    expect(cleanLabel("claim", "")).toBe("");
    expect(cleanLabel("answer", "  ")).toBe("");
  });
});

describe("sheetItems", () => {
  it("turns each row into an item with its evidence read", () => {
    const items = sheetItems(sampleRows());

    expect(items.map((item) => item.id)).toEqual(["c01", "c02", "a01"]);
    expect(items[0]).toMatchObject({
      kind: "claim",
      question: 'Question for c01, with a "quoted" word?',
      claim: "The fee is £880, and it lasts 2 years.",
      human_label: "",
    });
    expect(items[0]).toHaveProperty("citations.length", 2);
    expect(items[2]).toEqual({
      id: "a01",
      kind: "answer",
      question: 'Question for a01, with a "quoted" word?',
      human_label: "",
      row_hash: rowHash(HEADER, sampleRows()[3]!),
      summary: "It costs £880.",
      claims: ["The fee is £880.", "It lasts 2 years."],
      expected_points: ["The fee is £880.", "The visa lasts 2 years."],
      must_not_say: ["The visa can be extended."],
    });
  });

  it("shows the label a row already has", () => {
    const items = sheetItems(setLabel(sampleRows(), "c02", "not_supported"));
    expect(items.map((item) => item.human_label)).toEqual(["", "not_supported", ""]);
  });

  it("gives no items for an empty file and for a sheet with only a header", () => {
    expect(sheetItems([])).toEqual([]);
    expect(sheetItems([HEADER])).toEqual([]);
  });

  it("skips a row with no ID", () => {
    expect(sheetItems([...sampleRows(), [""]])).toHaveLength(3);
  });

  it("names the column that is missing", () => {
    const rows = sampleRows().map((row) => row.filter((_, index) => HEADER[index] !== "evidence"));
    expect(() => sheetItems(rows)).toThrow(/no column named evidence/);
  });

  it("names the row whose kind or evidence it cannot read", () => {
    const badKind = sampleRows();
    badKind[2]![1] = "other";
    expect(() => sheetItems(badKind)).toThrow(/Row c02 has the kind "other"/);

    const badEvidence = sampleRows();
    badEvidence[3]![4] = "Typed by hand.";
    expect(() => sheetItems(badEvidence)).toThrow(/evidence cell of row a01/);
  });
});

describe("rowHash", () => {
  /** The fingerprint that `sheetItems` gives each row, by row ID. */
  function hashes(rows: string[][]): Record<string, string> {
    return Object.fromEntries(sheetItems(rows).map((item) => [item.id, item.row_hash]));
  }

  it("stays the same when the label of the row changes", () => {
    const before = hashes(sampleRows());
    const labelled = setLabel(setLabel(sampleRows(), "c01", "supported"), "a01", "2");
    expect(hashes(labelled)).toEqual(before);
  });

  it("changes when any other cell of the row changes", () => {
    const row = sampleRows()[1]!;
    for (const column of HEADER.filter((name) => name !== "human_label")) {
      const changed = [...row];
      changed[HEADER.indexOf(column)] += " changed";
      expect(rowHash(HEADER, changed), column).not.toBe(rowHash(HEADER, row));
    }
  });

  it("differs for a new sample that uses the same IDs for other rows", () => {
    const first = sampleRows();
    // A new sample draws other claims and gives them the IDs c01 and c02 again.
    const second = [first[0]!, [...first[2]!], [...first[1]!], first[3]!];
    second[1]![0] = "c01";
    second[2]![0] = "c02";

    expect(hashes(second).c01).not.toBe(hashes(first).c01);
    expect(hashes(second).c02).not.toBe(hashes(first).c02);
    expect(hashes(second).a01).toBe(hashes(first).a01);
  });

  it("is 40 hex characters, so it is short to send back", () => {
    expect(rowHash(HEADER, sampleRows()[1]!)).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("saving a label", () => {
  it("changes one cell and leaves the rest of the file byte for byte the same", () => {
    const path = sampleFile();
    const before = readFileSync(path, "utf8");

    writeSheet(path, setLabel(readSheet(path), "c02", "supported"));

    const after = readFileSync(path, "utf8");
    // The label cell of c02 sits between its instructions and its licence line.
    expect(after).toBe(
      before.replace(
        '"Instructions for c02.","","Licence line."',
        '"Instructions for c02.","supported","Licence line."',
      ),
    );
    expect(after).not.toBe(before);
    expect(after.startsWith(BYTE_ORDER_MARK)).toBe(true);
  });

  it("gives back the first file exactly when the label is cleared again", () => {
    const path = sampleFile();
    const before = readFileSync(path);

    writeSheet(path, setLabel(readSheet(path), "a01", "2"));
    expect(readFileSync(path).equals(before)).toBe(false);
    writeSheet(path, setLabel(readSheet(path), "a01", ""));

    expect(readFileSync(path).equals(before)).toBe(true);
    // The temporary file was renamed over the sheet, so none is left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("does not change the rows it was given", () => {
    const rows = sampleRows();
    const changed = setLabel(rows, "c01", "supported");
    expect(rows).toEqual(sampleRows());
    expect(changed[1]![6]).toBe("supported");
    // The rows that did not change are the same arrays, not copies.
    expect(changed[2]).toBe(rows[2]);
  });

  it("reads a sheet that a spreadsheet program saved with semicolons and no byte order mark", () => {
    const path = join(tempDir(), "judge-audit.csv");
    const line = (cells: string[]): string => cells.map((cell) => `"${cell}"`).join(";");
    const row = ["c01", "claim", "Q?", "A claim.", "The claim cites no passage.", "Label it.", ""];
    writeFileSync(path, `${line(HEADER.slice(0, 7))}\r\n${line(row)}\r\n`);

    expect(sheetItems(readSheet(path))).toEqual([
      {
        id: "c01",
        kind: "claim",
        question: "Q?",
        human_label: "",
        row_hash: rowHash(HEADER.slice(0, 7), row),
        claim: "A claim.",
        citations: [],
      },
    ]);
  });

  it("writes a sheet that the scoring still reads", () => {
    const path = sampleFile();
    const keyPath = join(tempDir(), "key.json");
    const where = { question_id: "q01", setup_id: "H0", repeat: 1 };
    const key: AuditItem[] = [
      { id: "c01", kind: "claim", ...where, claim_index: 0, judge_label: "supported" },
      { id: "c02", kind: "claim", ...where, claim_index: 1, judge_label: "not_supported" },
      { id: "a01", kind: "answer", ...where, claim_index: null, judge_label: "2" },
    ];
    writeFileSync(keyPath, JSON.stringify(key));

    writeSheet(path, setLabel(readSheet(path), "c01", cleanLabel("claim", "supported")));
    writeSheet(path, setLabel(readSheet(path), "a01", cleanLabel("answer", "1")));

    const score = scoreAudit(path, keyPath);
    expect(score.labelled).toBe(2);
    expect(score.unlabelled).toBe(1);
    expect(score.agreed).toBe(1);
    expect(score.disagreements.map((item) => item.id)).toEqual(["a01"]);
  });
});
