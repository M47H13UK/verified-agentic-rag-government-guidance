import { describe, expect, it } from "vitest";
import { parseDiff, type FileDiff } from "../scripts/lib/diff";
import { displayFor, githubRepoUrl, renderPage } from "../scripts/lib/reviewHtml";

// The diffs below were copied from real `git diff` output, one line per string.

/** Joins lines the way git prints them, with a newline after the last one. */
function gitOutput(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

/** Builds the diff of a new text file with the given number of lines, then parses it. */
function addedFile(path: string, lineCount: number): FileDiff {
  const lines = Array.from({ length: lineCount }, (_, index) => `+line ${index + 1}`);
  const text = gitOutput(
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..8f6b117",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lineCount} @@`,
    ...lines,
  );
  return parseDiff(text)[0]!;
}

describe("parseDiff", () => {
  it("reads an added file", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/run.sh b/run.sh",
        "new file mode 100644",
        "index 0000000..85ba14d",
        "--- /dev/null",
        "+++ b/run.sh",
        "@@ -0,0 +1,2 @@",
        "+#!/bin/sh",
        "+echo run",
      ),
    );

    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file).toMatchObject({ newPath: "run.sh", status: "A", added: 2, removed: 0 });
    expect(file.hunks[0]!.lines).toEqual([
      { kind: "add", text: "#!/bin/sh", oldNumber: null, newNumber: 1 },
      { kind: "add", text: "echo run", oldNumber: null, newNumber: 2 },
    ]);
  });

  it("reads a deleted file", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/docs/remove-me.md b/docs/remove-me.md",
        "deleted file mode 100644",
        "index 6f23ba1..0000000",
        "--- a/docs/remove-me.md",
        "+++ /dev/null",
        "@@ -1,3 +0,0 @@",
        "-# Remove me",
        "-",
        "-This file goes away in step 1.",
      ),
    );

    const file = files[0]!;
    expect(file).toMatchObject({
      oldPath: "docs/remove-me.md",
      newPath: "docs/remove-me.md",
      status: "D",
      added: 0,
      removed: 3,
    });
    expect(file.hunks[0]!.lines[1]).toEqual({
      kind: "del",
      text: "",
      oldNumber: 2,
      newNumber: null,
    });
  });

  it("reads a rename, with and without a change inside the file", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/src/keep.ts b/lib/keep.ts",
        "similarity index 100%",
        "rename from src/keep.ts",
        "rename to lib/keep.ts",
        "diff --git a/src/old-name.ts b/src/new-name.ts",
        "similarity index 86%",
        "rename from src/old-name.ts",
        "rename to src/new-name.ts",
        "index b76461c..13e78cc 100644",
        "--- a/src/old-name.ts",
        "+++ b/src/new-name.ts",
        "@@ -1,5 +1,5 @@",
        " export function oldName(): string {",
        '-  return "old";',
        '+  return "new";',
        " }",
        " ",
        " export const a = 1;",
      ),
    );

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      oldPath: "src/keep.ts",
      newPath: "lib/keep.ts",
      status: "R",
      hunks: [],
    });
    expect(files[1]).toMatchObject({
      oldPath: "src/old-name.ts",
      newPath: "src/new-name.ts",
      status: "R",
      added: 1,
      removed: 1,
    });
  });

  it("lists a binary file without hunks", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/logo.png b/logo.png",
        "new file mode 100644",
        "index 0000000..b437676",
        "Binary files /dev/null and b/logo.png differ",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
      ),
    );

    expect(files[0]).toMatchObject({ newPath: "logo.png", status: "A", binary: true, hunks: [] });
    // A mode change has no hunks either, but it is not binary.
    expect(files[1]).toMatchObject({ newPath: "run.sh", status: "M", binary: false, hunks: [] });
  });

  it("keeps two hunks of one file apart and numbers the lines of each", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/src/hello.ts b/src/hello.ts",
        "index d811270..3552f4f 100644",
        "--- a/src/hello.ts",
        "+++ b/src/hello.ts",
        "@@ -1,4 +1,4 @@",
        " export const line1 = 1;",
        " export const line2 = 2;",
        "-export const line3 = 3;",
        "+export const line3 = 33;",
        " export const line4 = 4;",
        "@@ -35,4 +35,5 @@ export const line34 = 34;",
        " export const line35 = 35;",
        "-export const line36 = 36;",
        "+export const line36 = 360;",
        '+export const extra = "added near the bottom";',
        " export const line37 = 37;",
        " export const line38 = 38;",
      ),
    );

    const file = files[0]!;
    expect(file).toMatchObject({ status: "M", added: 3, removed: 2 });
    expect(file.hunks).toHaveLength(2);
    expect(file.hunks[0]!.header).toBe("@@ -1,4 +1,4 @@");
    expect(file.hunks[1]!.header).toBe("@@ -35,4 +35,5 @@ export const line34 = 34;");
    // After one removed and two added lines, old and new numbers are one apart.
    expect(file.hunks[1]!.lines.at(-1)).toEqual({
      kind: "context",
      text: "export const line38 = 38;",
      oldNumber: 38,
      newNumber: 39,
    });
  });

  it("treats a removed line that starts with -- as content, not as a file header", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/sql/schema.sql b/sql/schema.sql",
        "index 45f24b3..1ba8b72 100644",
        "--- a/sql/schema.sql",
        "+++ b/sql/schema.sql",
        "@@ -3,5 +3,4 @@ CREATE TABLE users (",
        "   id INT,",
        "   name TEXT",
        " );",
        "--- drop the old table",
        "-DROP TABLE old_users;",
        "+++ a line that starts with two plus signs",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
      ),
    );

    expect(files).toHaveLength(2);
    const file = files[0]!;
    expect(file).toMatchObject({ newPath: "sql/schema.sql", added: 1, removed: 2 });
    expect(file.hunks[0]!.lines.slice(3)).toEqual([
      { kind: "del", text: "-- drop the old table", oldNumber: 6, newNumber: null },
      { kind: "del", text: "DROP TABLE old_users;", oldNumber: 7, newNumber: null },
      {
        kind: "add",
        text: "++ a line that starts with two plus signs",
        oldNumber: null,
        newNumber: 6,
      },
    ]);
  });

  it("reads a path with a space and the marker for a missing final newline", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/my notes.txt b/my notes.txt",
        "index da57d34..e1d3c02 100644",
        // Git adds a tab after a path with a space on these two lines.
        "--- a/my notes.txt\t",
        "+++ b/my notes.txt\t",
        "@@ -1,2 +1,2 @@",
        " first note",
        "-second note",
        "+second note, edited",
        "\\ No newline at end of file",
      ),
    );

    const file = files[0]!;
    expect(file).toMatchObject({ oldPath: "my notes.txt", newPath: "my notes.txt" });
    expect(file).toMatchObject({ added: 1, removed: 1 });
    expect(file.hunks[0]!.lines.at(-1)).toEqual({
      kind: "note",
      text: "No newline at end of file",
      oldNumber: null,
      newNumber: null,
    });
  });

  it("returns no files for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("displayFor", () => {
  it("shows an ordinary source file open", () => {
    expect(displayFor(addedFile("src/db.ts", 400)).mode).toBe("open");
  });

  it("collapses the lockfile, data files and files over 400 changed lines", () => {
    expect(displayFor(addedFile("package-lock.json", 10)).mode).toBe("collapsed");
    expect(displayFor(addedFile("data/sample/passages.json", 10)).mode).toBe("collapsed");
    expect(displayFor(addedFile("results/runs/H0-r1.jsonl", 10)).mode).toBe("collapsed");
    expect(displayFor(addedFile("src/big.ts", 401)).mode).toBe("collapsed");
  });

  it("only lists binary files and files over 3,000 changed lines", () => {
    const binary = parseDiff(
      gitOutput(
        "diff --git a/logo.png b/logo.png",
        "index b437676..9fb3236 100644",
        "Binary files a/logo.png and b/logo.png differ",
      ),
    )[0]!;
    expect(displayFor(addedFile("src/huge.ts", 3001)).mode).toBe("listed");
    expect(displayFor(binary).mode).toBe("listed");
  });
});

describe("githubRepoUrl", () => {
  it("reads SSH and HTTPS remotes", () => {
    const expected = "https://github.com/example-owner/visa-guide";
    expect(githubRepoUrl("git@github.com:example-owner/visa-guide.git\n")).toBe(expected);
    expect(githubRepoUrl("https://github.com/example-owner/visa-guide.git")).toBe(expected);
    expect(githubRepoUrl("https://github.com/example-owner/visa-guide")).toBe(expected);
  });

  it("returns null for a remote that is not on GitHub", () => {
    expect(githubRepoUrl("https://gitlab.com/example-owner/visa-guide.git")).toBeNull();
  });
});

describe("renderPage", () => {
  it("escapes HTML that appears in a diff", () => {
    const files = parseDiff(
      gitOutput(
        "diff --git a/web/page.html b/web/page.html",
        "new file mode 100644",
        "index 0000000..8f6b117",
        "--- /dev/null",
        "+++ b/web/page.html",
        "@@ -0,0 +1 @@",
        '+<script>alert("x & y")</script>',
      ),
    );
    const html = renderPage({
      repoName: "demo",
      githubUrl: null,
      generatedAt: "2026-10-06 12:00 UTC",
      steps: [
        {
          tag: "step-00",
          title: "setup <b>",
          date: "2026-10-06",
          previousTag: null,
          notesHtml: null,
          files,
        },
      ],
    });

    expect(html).toContain("+&lt;script&gt;alert(&quot;x &amp; y&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("setup &lt;b&gt;");
  });
});
