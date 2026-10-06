// Turns the text printed by `git diff` into files, hunks and lines.
// It is a pure function, so it can be tested without a git repository.

export type DiffLine = {
  /** "note" is git's marker "\ No newline at end of file". It is not a line of the file. */
  kind: "context" | "add" | "del" | "note";
  /** The line without its leading "+", "-" or space. */
  text: string;
  /** Line number in the old file. Null for added lines. */
  oldNumber: number | null;
  /** Line number in the new file. Null for removed lines. */
  newNumber: number | null;
};

/** One changed region of a file, with a few unchanged lines around it. */
export type Hunk = {
  /** The whole "@@ -1,6 +1,7 @@" line, including the text git prints after it. */
  header: string;
  lines: DiffLine[];
};

/** A for added, D for deleted, R for renamed, M for modified. */
export type FileStatus = "A" | "D" | "R" | "M";

export type FileDiff = {
  /** Equal to `newPath` unless the file was renamed. */
  oldPath: string;
  newPath: string;
  status: FileStatus;
  /** Git does not print hunks for binary files. */
  binary: boolean;
  added: number;
  removed: number;
  /** Empty for binary files, pure renames, empty files and mode changes. */
  hunks: Hunk[];
};

const FILE_START = "diff --git ";

/** Parses the output of `git diff --no-color -M --unified=3 <a> <b>`. */
export function parseDiff(text: string): FileDiff[] {
  const lines = text.split("\n");
  // The output ends with a newline, which leaves one empty string at the end.
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of lines) {
    // Lines inside a hunk always start with "+", "-", a space or "\",
    // so these two checks can never match a line of file content.
    if (line.startsWith(FILE_START)) {
      file = startFile(line);
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) {
      continue;
    }
    const hunkStart = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkStart) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      oldNumber = Number(hunkStart[1]);
      newNumber = Number(hunkStart[2]);
      continue;
    }

    // Before the first hunk, every line describes the file.
    // This is the only place where "--- a/path" and "+++ b/path" appear.
    if (!hunk) {
      readFileHeaderLine(file, line);
      continue;
    }

    // Inside a hunk, only the first character matters. A removed line whose content is
    // "-- note" arrives as "--- note" and must not be mistaken for a file header.
    const sign = line[0];
    const content = line.slice(1);
    if (sign === "+") {
      hunk.lines.push({ kind: "add", text: content, oldNumber: null, newNumber });
      newNumber += 1;
      file.added += 1;
    } else if (sign === "-") {
      hunk.lines.push({ kind: "del", text: content, oldNumber, newNumber: null });
      oldNumber += 1;
      file.removed += 1;
    } else if (sign === "\\") {
      hunk.lines.push({ kind: "note", text: content.trim(), oldNumber: null, newNumber: null });
    } else {
      hunk.lines.push({ kind: "context", text: content, oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
    }
  }

  return files;
}

/** Reads the path from a "diff --git a/path b/path" line. */
function startFile(line: string): FileDiff {
  const paths = line.slice(FILE_START.length);
  // A path can contain spaces, so splitting on a space is not safe. Unless the file was
  // renamed, the two paths are equal, so the text is cut exactly in the middle instead.
  // For a rename, the "rename from" and "rename to" lines below replace both paths.
  const middle = Math.floor(paths.length / 2);
  const oldPath = paths.slice(0, middle).replace(/^a\//, "");
  const newPath = paths.slice(middle + 1).replace(/^b\//, "");
  return { oldPath, newPath, status: "M", binary: false, added: 0, removed: 0, hunks: [] };
}

/** Handles one of the lines between "diff --git" and the first hunk. */
function readFileHeaderLine(file: FileDiff, line: string): void {
  if (line.startsWith("new file mode ")) {
    file.status = "A";
  } else if (line.startsWith("deleted file mode ")) {
    file.status = "D";
  } else if (line.startsWith("rename from ")) {
    file.status = "R";
    file.oldPath = line.slice("rename from ".length);
  } else if (line.startsWith("rename to ")) {
    file.newPath = line.slice("rename to ".length);
  } else if (line.startsWith("Binary files ")) {
    file.binary = true;
  }
  // Every other header line ("index", "similarity index", "---", "+++", mode changes) is ignored.
}
