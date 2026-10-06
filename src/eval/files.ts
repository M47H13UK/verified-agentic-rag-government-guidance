// Where the eval keeps its files, and how it reads and writes them.
// Runs and grades are JSONL, one JSON object per line. A line is only ever added at the end,
// so a crash can damage the last line at most and everything before it stays readable.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** The runs of one setup and one repeat, for example `results/runs/H1-r1.jsonl`. */
export function runsPath(outDir: string, setupId: string, repeat: number): string {
  return join(outDir, "runs", `${setupId}-r${repeat}.jsonl`);
}

/** The grades of one setup and one repeat, for example `results/grades/H1-r1.jsonl`. */
export function gradesPath(outDir: string, setupId: string, repeat: number): string {
  return join(outDir, "grades", `${setupId}-r${repeat}.jsonl`);
}

/** Lists the repeat numbers that have a runs file for this setup, lowest first. */
export function listRepeats(outDir: string, setupId: string): number[] {
  const dir = join(outDir, "runs");
  if (!existsSync(dir)) return [];

  const repeats: number[] = [];
  for (const name of readdirSync(dir)) {
    const match = /^(.+)-r(\d+)\.jsonl$/.exec(name);
    if (match && match[1] === setupId) repeats.push(Number(match[2]));
  }
  return repeats.sort((a, b) => a - b);
}

/**
 * Reads a JSONL file. A missing file gives an empty list.
 * The rows are trusted to have the right shape, because this project wrote them.
 * A last line that does not parse is skipped, because a crash in the middle of a write leaves
 * exactly that. A bad line anywhere else means the file was damaged some other way, so it throws.
 */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf8").split("\n");
  // The last entry is the text after the final newline. It is empty when the last write finished.
  const lastIndex = lines.length - 1;
  const rows: T[] = [];

  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      if (index !== lastIndex) {
        throw new Error(`Line ${index + 1} of ${path} is not valid JSON.`);
      }
    }
  });
  return rows;
}

/** Adds one row to the end of a JSONL file. Creates the file and its folder when needed. */
export function appendJsonl(path: string, row: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  // One call writes the whole line, newline included. The call is synchronous, so two runs
  // that finish at the same moment can never mix their lines.
  appendFileSync(path, JSON.stringify(row) + "\n");
}

/**
 * Cuts off a half-written last line. Call it before adding to a file from an earlier session.
 * Every complete line ends with a newline, so text after the last newline is a line that a
 * crash interrupted. Left in place, the next row would be joined onto it and both would be lost.
 */
export function dropPartialLastLine(path: string): void {
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  if (text === "" || text.endsWith("\n")) return;
  writeFileSync(path, text.slice(0, text.lastIndexOf("\n") + 1));
}

/**
 * Keeps the last row for each question.
 * A question can have several rows in one file, because a failed run is recorded and then
 * run again on resume. The newest row is the one that counts.
 */
export function latestByQuestion<T extends { question_id: string }>(rows: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const row of rows) latest.set(row.question_id, row);
  return latest;
}
