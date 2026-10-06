// Builds review/index.html, a local page for reading the build one step at a time.
// Run with `npm run review`. Use `npm run review -- --no-open` to skip opening the page.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { parseDiff } from "./lib/diff";
import { githubRepoUrl, renderPage, type StepView } from "./lib/reviewHtml";

// The ID of git's empty tree. Diffing against it shows every file of the first step as added.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// The repository is the folder the command runs in. `npm run` always starts in the project root.
const repoRoot = process.cwd();

/** Runs git in the repository and returns what it printed. The arguments never pass through a shell. */
function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    // The default limit is 1 MB of output, and the diff of a data file can be far larger.
    maxBuffer: 1024 * 1024 * 1024,
  });
}

type StepTag = { tag: string; date: string; subject: string };

/** Lists the tags named step-00, step-01 and so on, in order. */
function listStepTags(): StepTag[] {
  const output = git([
    "tag",
    "--list",
    // A glob, so it matches "step-" followed by exactly two digits.
    "step-[0-9][0-9]",
    "--sort=refname",
    // %09 is a tab. The subject is the tag message, or the commit subject for a plain tag.
    "--format=%(refname:short)%09%(creatordate:short)%09%(contents:subject)",
  ]);
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      // The subject comes last because it is the only field that could contain a tab.
      const [tag = "", date = "", ...subject] = line.split("\t");
      return { tag, date, subject: subject.join("\t") };
    });
}

/** Returns the diff between two tags as text. */
function diffBetween(from: string, to: string): string {
  return git([
    // Print paths with accents as they are, not as escape codes.
    "-c",
    "core.quotePath=false",
    "diff",
    "--no-color",
    // These three keep the output the same whatever the git config on this machine says.
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    // -M reports a moved file as a rename, not as one deleted file and one added file.
    "-M",
    "--unified=3",
    from,
    to,
  ]);
}

/** Reads the notes of one step and turns the Markdown into HTML. Null when there are none. */
function readNotes(tag: string): string | null {
  const file = path.join(repoRoot, "review", "notes", `${tag}.md`);
  if (!existsSync(file)) {
    return null;
  }
  // The notes are local files written by the owner, so their HTML is trusted and not escaped.
  return marked.parse(readFileSync(file, "utf8"), { async: false });
}

/** Returns the GitHub address of the remote named origin. Null when there is none. */
function findGithubUrl(): string | null {
  const remotes = git(["remote"]).split("\n");
  if (!remotes.includes("origin")) {
    return null;
  }
  return githubRepoUrl(git(["remote", "get-url", "origin"]));
}

function main(): void {
  const tags = listStepTags();
  if (tags.length === 0) {
    console.error("No step tags found. The page is built from tags named step-00, step-01, ...");
    process.exitCode = 1;
    return;
  }

  const steps: StepView[] = tags.map((current, index) => {
    const previousTag = index === 0 ? null : tags[index - 1]!.tag;
    const diffText = diffBetween(previousTag ?? EMPTY_TREE, current.tag);
    return {
      tag: current.tag,
      // The subject usually reads "step-03: quote check". The tag is shown next to it anyway.
      title: current.subject.replace(/^step-\d\d:\s*/, ""),
      date: current.date,
      previousTag,
      notesHtml: readNotes(current.tag),
      files: parseDiff(diffText),
    };
  });

  const html = renderPage({
    repoName: path.basename(repoRoot),
    githubUrl: findGithubUrl(),
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    steps,
  });

  const outFile = path.join(repoRoot, "review", "index.html");
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, html);
  console.log(`Wrote ${steps.length === 1 ? "1 step" : `${steps.length} steps`} to ${outFile}`);

  // `open` is the macOS command that shows a file in the default browser.
  if (process.platform === "darwin" && !process.argv.includes("--no-open")) {
    execFileSync("open", [outFile]);
  }
}

main();
