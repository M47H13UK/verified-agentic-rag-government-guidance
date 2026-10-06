// Opens one build step in its own folder, so its code can be run without touching this checkout.
// Run with `npm run step 3`, `npm run step list` or `npm run step clean`.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, symlinkSync } from "node:fs";
import path from "node:path";

// The repository is the folder the command runs in. `npm run` always starts in the project root.
const repoRoot = process.cwd();

// Step folders live next to the repository, not inside it.
// Inside it, the linter, the type check and the tests of this checkout would all scan them.
const stepsDir = path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-steps`);

const USAGE = `Usage:
  npm run step 3                   open step 3 in its own folder
  npm run step -- 3 --no-install   the same, without running npm ci
  npm run step list                list the steps
  npm run step clean               remove the step folders`;

/** Runs git and returns what it printed. The arguments never pass through a shell. */
function git(args: string[], cwd = repoRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Turns "3", "03" or "step-03" into "step-03". Returns null for anything else. */
function toStepTag(arg: string): string | null {
  const match = /^(?:step-)?(\d{1,2})$/.exec(arg);
  if (!match) {
    return null;
  }
  return `step-${match[1]!.padStart(2, "0")}`;
}

/** Prints each step tag with its subject line. */
function listSteps(): void {
  const output = git([
    "tag",
    "--list",
    // A glob, so it matches "step-" followed by exactly two digits.
    "step-[0-9][0-9]",
    "--sort=refname",
    "--format=%(refname:short)  %(contents:subject)",
  ]);
  console.log(output.trim() === "" ? "No step tags found." : output.trimEnd());
}

/** Creates the folder for one step, or reuses it, then installs its dependencies. */
function openStep(tag: string, install: boolean): void {
  if (git(["tag", "--list", tag]).trim() !== tag) {
    console.error(`There is no tag named ${tag}. Run "npm run step list" to see the steps.`);
    process.exitCode = 1;
    return;
  }

  const folder = path.join(stepsDir, tag);
  // Git remembers a worktree even after its folder is deleted by hand, and then refuses to
  // create it again. Pruning first forgets those.
  git(["worktree", "prune"]);

  if (existsSync(folder)) {
    console.log(`Reusing ${folder}`);
    // A tag can be moved after the folder was created. The folder would then show old code.
    const folderCommit = git(["rev-parse", "HEAD"], folder).trim();
    const tagCommit = git(["rev-parse", `${tag}^{commit}`]).trim();
    if (folderCommit !== tagCommit) {
      console.log(
        `Warning. This folder is not at ${tag}. Run "npm run step clean", then this command again.`,
      );
    }
  } else {
    // Detached, because the folder is for reading and running a fixed snapshot, not for new commits.
    git(["worktree", "add", "--detach", folder, tag]);
    console.log(`Created ${folder}`);
  }

  if (install) {
    console.log("Running npm ci in the step folder.");
    execFileSync("npm", ["ci"], { cwd: folder, stdio: "inherit" });
  }

  const mainEnv = path.join(repoRoot, ".env");
  const stepEnv = path.join(folder, ".env");
  if (existsSync(mainEnv) && !existsSync(stepEnv)) {
    // A symlink, not a copy. The secrets stay in one file, so a changed token works in every
    // step folder at once, and no second copy is left behind in a folder that is easy to forget.
    // The file is never opened here, only pointed at.
    symlinkSync(mainEnv, stepEnv);
    console.log("Linked .env from the main checkout.");
  }

  console.log(`
${tag} is ready in ${folder}

Open it in an editor:
  code "${folder}"
  cursor "${folder}"

Run the checks there:
  cd "${folder}"${install ? "" : "\n  npm ci"}
  npm run typecheck
  npm test`);
}

/** Removes every step folder, then tells git to forget them. */
function cleanSteps(): void {
  if (existsSync(stepsDir)) {
    for (const name of readdirSync(stepsDir)) {
      if (!/^step-\d\d$/.test(name)) {
        continue;
      }
      const folder = path.join(stepsDir, name);
      try {
        // No --force. Git refuses to remove a folder with uncommitted changes, so edits made
        // in a step folder are never lost without a warning.
        git(["worktree", "remove", folder]);
        console.log(`Removed ${folder}`);
      } catch {
        console.error(`Kept ${folder}. Git printed the reason above.`);
        process.exitCode = 1;
      }
    }
    if (readdirSync(stepsDir).length === 0) {
      rmdirSync(stepsDir);
    }
  }
  git(["worktree", "prune"]);
}

function main(): void {
  const args = process.argv.slice(2);
  const install = !args.includes("--no-install");
  const command = args.find((arg) => !arg.startsWith("--"));

  if (command === "list") {
    listSteps();
    return;
  }
  if (command === "clean") {
    cleanSteps();
    return;
  }
  const tag = command ? toStepTag(command) : null;
  if (!tag) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  openStep(tag, install);
}

try {
  main();
} catch (error) {
  // A failed git or npm command has already printed its own message. This adds which command it was.
  console.error(String(error));
  process.exitCode = 1;
}
