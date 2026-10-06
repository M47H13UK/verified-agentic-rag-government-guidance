// Builds the review page as one HTML string. Plain template strings, no framework.
// Everything that comes from git goes through escapeHtml before it reaches the page.
// The stylesheet and the small script are at the bottom of the file, out of the way.
import type { DiffLine, FileDiff, FileStatus, Hunk } from "./diff";

/** Everything the page shows for one step tag. */
export type StepView = {
  /** For example "step-03". Only letters, digits and a hyphen, so it is safe inside an id. */
  tag: string;
  title: string;
  /** Date of the tag, YYYY-MM-DD. */
  date: string;
  /** The tag this step is compared with. Null for the first step. */
  previousTag: string | null;
  /** The notes as HTML. Null when the step has no notes file. */
  notesHtml: string | null;
  files: FileDiff[];
};

export type ReviewPage = {
  repoName: string;
  /** For example "https://github.com/owner/repo". Null when there is no GitHub remote. */
  githubUrl: string | null;
  generatedAt: string;
  steps: StepView[];
};

// ---------- What to show and what to collapse ----------

/** A file with more changed lines than this starts collapsed. */
const COLLAPSE_OVER_LINES = 400;
/** A file with more changed lines than this is counted but left out of the page. */
const HIDE_OVER_LINES = 3000;
/** Longer lines are cut. They are generated data, and a single one can be many kilobytes. */
const MAX_LINE_CHARS = 1000;

export type Display = {
  /** "open" shows the hunks, "collapsed" hides them behind a click, "listed" leaves them out. */
  mode: "open" | "collapsed" | "listed";
  /** Shown next to the file when it is not open. */
  reason: string;
};

/** Decides how one file is shown. Noise is collapsed so the code that matters is easy to find. */
export function displayFor(file: FileDiff): Display {
  const changed = file.added + file.removed;
  const fileName = file.newPath.split("/").pop();

  if (file.binary) {
    return { mode: "listed", reason: "Binary file, not shown." };
  }
  if (file.hunks.length === 0) {
    return { mode: "listed", reason: "No line changes." };
  }
  if (changed > HIDE_OVER_LINES) {
    const limit = formatCount(HIDE_OVER_LINES);
    return { mode: "listed", reason: `Over ${limit} changed lines, not shown.` };
  }
  if (fileName === "package-lock.json") {
    return { mode: "collapsed", reason: "Collapsed because npm writes this file." };
  }
  if (file.newPath.startsWith("data/") || file.newPath.startsWith("results/runs/")) {
    return { mode: "collapsed", reason: "Collapsed because it is a data file." };
  }
  if (changed > COLLAPSE_OVER_LINES) {
    const limit = formatCount(COLLAPSE_OVER_LINES);
    return { mode: "collapsed", reason: `Collapsed because it has over ${limit} changed lines.` };
  }
  return { mode: "open", reason: "" };
}

// ---------- Small helpers ----------

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Turns a git remote URL into the address of the repository on GitHub.
 * Handles the SSH form "git@github.com:owner/repo.git" and the HTTPS form
 * "https://github.com/owner/repo.git". Returns null for any other host.
 */
export function githubRepoUrl(remoteUrl: string): string | null {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  if (!match) {
    return null;
  }
  return `https://github.com/${match[1]}/${match[2]}`;
}

function countLines(files: FileDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added;
    removed += file.removed;
  }
  return { added, removed };
}

/** Writes 5608 as "5,608". */
function formatCount(count: number): string {
  return count.toLocaleString("en-GB");
}

function filesChanged(count: number): string {
  return count === 1 ? "1 file changed" : `${formatCount(count)} files changed`;
}

/** The id of one file's diff. The index keeps it unique, and avoids putting a path in an id. */
function fileId(tag: string, index: number): string {
  return `${tag}-file-${index}`;
}

function pathLabel(file: FileDiff): string {
  return file.status === "R" ? `${file.oldPath} → ${file.newPath}` : file.newPath;
}

const STATUS_NAMES: Record<FileStatus, string> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
};

function statusBadge(status: FileStatus): string {
  return `<span class="status status-${status}" title="${STATUS_NAMES[status]}">${status}</span>`;
}

// ---------- The diff of one file ----------

/** The character git puts in front of each kind of line. */
const SIGNS: Record<DiffLine["kind"], string> = { context: " ", add: "+", del: "-", note: " " };

function renderLine(line: DiffLine): string {
  let code = escapeHtml(line.text.slice(0, MAX_LINE_CHARS));
  if (line.text.length > MAX_LINE_CHARS) {
    const left = formatCount(line.text.length - MAX_LINE_CHARS);
    code += ` <span class="cut">[${left} more characters not shown]</span>`;
  }
  const oldNumber = line.oldNumber ?? "";
  const newNumber = line.newNumber ?? "";
  return `<tr class="${line.kind}"><td class="num">${oldNumber}</td><td class="num">${newNumber}</td><td class="code">${SIGNS[line.kind]}${code}</td></tr>`;
}

function renderHunk(hunk: Hunk): string {
  const header = `<tr class="hunk"><td colspan="3">${escapeHtml(hunk.header)}</td></tr>`;
  return [header, ...hunk.lines.map(renderLine)].join("\n");
}

function renderFile(file: FileDiff, id: string): string {
  const display = displayFor(file);
  if (display.mode === "listed") {
    return "";
  }
  const open = display.mode === "open" ? " open" : "";
  return `<details class="file" id="${id}"${open}>
<summary>${statusBadge(file.status)} <span class="path">${escapeHtml(pathLabel(file))}</span> <span class="added">+${formatCount(file.added)}</span> <span class="removed">-${formatCount(file.removed)}</span> <span class="reason">${escapeHtml(display.reason)}</span></summary>
<table class="diff">
<colgroup><col class="num"><col class="num"><col></colgroup>
<tbody>
${file.hunks.map(renderHunk).join("\n")}
</tbody>
</table>
</details>`;
}

// ---------- One step ----------

function renderFileList(step: StepView): string {
  const rows = step.files.map((file, index) => {
    const display = displayFor(file);
    const label = escapeHtml(pathLabel(file));
    // A file that is only listed has no diff on the page, so there is nothing to link to.
    const name =
      display.mode === "listed" ? label : `<a href="#${fileId(step.tag, index)}">${label}</a>`;
    return `<tr><td>${statusBadge(file.status)}</td><td class="path">${name}</td><td class="count added">+${formatCount(file.added)}</td><td class="count removed">-${formatCount(file.removed)}</td><td class="reason">${escapeHtml(display.reason)}</td></tr>`;
  });
  return `<table class="files">
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

function renderGithubLinks(step: StepView, githubUrl: string | null): string {
  if (!githubUrl) {
    return "";
  }
  const base = escapeHtml(githubUrl);
  const links = [`<a href="${base}/tree/${step.tag}">Files at ${step.tag} on GitHub</a>`];
  if (step.previousTag) {
    links.unshift(
      `<a href="${base}/compare/${step.previousTag}...${step.tag}">Compare ${step.previousTag} with ${step.tag} on GitHub</a>`,
    );
  }
  return `<p class="links">${links.join("")}</p>`;
}

function renderStep(step: StepView, githubUrl: string | null): string {
  const total = countLines(step.files);
  const comparedWith = step.previousTag
    ? `Compared with ${step.previousTag}.`
    : "Compared with an empty repository, so every file shows as added.";
  const notes =
    step.notesHtml ??
    `<p class="placeholder">No notes yet. Write them in <code>review/notes/${step.tag}.md</code>, then run <code>npm run review</code> again.</p>`;
  return `<section class="step" id="${step.tag}">
<h2><code>${step.tag}</code> ${escapeHtml(step.title)}</h2>
<p class="meta">${escapeHtml(step.date)}. ${filesChanged(step.files.length)}, <span class="added">+${formatCount(total.added)}</span> <span class="removed">-${formatCount(total.removed)}</span>. ${comparedWith}</p>
${renderGithubLinks(step, githubUrl)}
<div class="notes">
${notes}
</div>
<h3>Files changed</h3>
<p class="meta">A added, M modified, D deleted, R renamed. Click a file to jump to its diff.</p>
${renderFileList(step)}
${step.files.map((file, index) => renderFile(file, fileId(step.tag, index))).join("\n")}
</section>`;
}

// ---------- The whole page ----------

function renderNavItem(step: StepView): string {
  return `<li><a href="#${step.tag}"><code>${step.tag}</code>${escapeHtml(step.title)}</a></li>`;
}

function renderSummary(steps: StepView[]): string {
  const rows = steps.map((step) => {
    const total = countLines(step.files);
    return `<tr><td><a href="#${step.tag}"><code>${step.tag}</code></a></td><td>${escapeHtml(step.title)}</td><td>${escapeHtml(step.date)}</td><td class="count">${formatCount(step.files.length)}</td><td class="count added">+${formatCount(total.added)}</td><td class="count removed">-${formatCount(total.removed)}</td></tr>`;
  });
  return `<table class="summary">
<thead>
<tr><th>Tag</th><th>Title</th><th>Date</th><th class="count">Files changed</th><th class="count">Lines added</th><th class="count">Lines removed</th></tr>
</thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
}

/** Returns the complete page. It has no links to stylesheets, scripts or images, so it works offline. */
export function renderPage(page: ReviewPage): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build review, ${escapeHtml(page.repoName)}</title>
<style>${CSS}</style>
</head>
<body>
<nav>
<p>Steps</p>
<ul>
${page.steps.map(renderNavItem).join("\n")}
</ul>
</nav>
<main>
<h1>Build review, ${escapeHtml(page.repoName)}</h1>
<p class="meta">Generated ${escapeHtml(page.generatedAt)}. Each step is compared with the step before it.</p>
${renderSummary(page.steps)}
${page.steps.map((step) => renderStep(step, page.githubUrl)).join("\n")}
<footer>
<p>This page is built by <code>npm run review</code> and stays on this machine.</p>
<p>The project is unofficial. It is not affiliated with GOV.UK or the Home Office. Contains public sector information licensed under the Open Government Licence v3.0.</p>
</footer>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

// A link from a file list opens its diff, even when that diff starts collapsed.
const SCRIPT = `
function openLinkedFile() {
  const target = document.getElementById(location.hash.slice(1));
  if (target instanceof HTMLDetailsElement) target.open = true;
}
addEventListener("hashchange", openLinkedFile);
openLinkedFile();
`;

// Colours are variables, so the dark theme only has to replace the values.
const CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --panel: #f5f6f8;
  --text: #1b1f24;
  --muted: #59626e;
  --border: #d4d9e0;
  --link: #0a58b0;
  --add-bg: #e4f8e9;
  --add-num: #c8eed1;
  --add-text: #0f6b2b;
  --del-bg: #fdeae8;
  --del-num: #f8cdc9;
  --del-text: #b0241c;
  --hunk-bg: #e7f0fb;
  --hunk-text: #3f536b;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1318;
    --panel: #171c23;
    --text: #e3e8ee;
    --muted: #9ba6b4;
    --border: #2d3540;
    --link: #74b5ff;
    --add-bg: #12301e;
    --add-num: #1a4429;
    --add-text: #75dd90;
    --del-bg: #3b191b;
    --del-num: #522326;
    --del-text: #ff9790;
    --hunk-bg: #17283c;
    --hunk-text: #a3bbd8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
a { color: var(--link); }
code, pre { font-family: var(--mono); font-size: 0.9em; }
h1 { margin: 0 0 0.25rem; font-size: 1.6rem; }
h2 { margin: 0 0 0.25rem; font-size: 1.35rem; }
h3 { margin: 1.75rem 0 0.25rem; font-size: 1.05rem; }
.meta { margin: 0 0 1rem; color: var(--muted); }
.added { color: var(--add-text); }
.removed { color: var(--del-text); }
.reason, .placeholder, footer { color: var(--muted); }
footer { margin-top: 4rem; font-size: 0.85rem; }

/* The list of steps stays in view while the page scrolls. */
nav {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
  padding: 1.25rem 0.75rem;
  background: var(--panel);
  border-right: 1px solid var(--border);
}
nav p { margin: 0 0.5rem 0.5rem; font-weight: 600; }
nav ul { margin: 0; padding: 0; list-style: none; }
nav a { display: block; padding: 0.35rem 0.5rem; border-radius: 6px; color: var(--text); text-decoration: none; }
nav a:hover { background: var(--border); }
nav code { display: block; color: var(--muted); font-size: 0.75rem; }

/* min-width 0 lets the diff tables shrink to the column instead of widening the page. */
main { min-width: 0; padding: 1.5rem 2rem 4rem; }
section.step { margin-top: 3rem; padding-top: 1.5rem; border-top: 2px solid var(--border); }
.links a { margin-right: 1.5rem; }

table.summary, table.files { width: 100%; border-collapse: collapse; }
table.summary th, table.summary td, table.files td {
  padding: 0.35rem 0.6rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
}
table.summary th { color: var(--muted); font-weight: 600; }
table.summary .count, table.files .count { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
table.files { font-size: 0.9rem; }
table.files td:first-child { width: 2rem; }
.path { font-family: var(--mono); overflow-wrap: anywhere; }

.status { display: inline-block; width: 1.5em; border-radius: 4px; text-align: center; font: 600 0.75rem/1.5 var(--mono); }
.status-A { background: var(--add-num); color: var(--add-text); }
.status-D { background: var(--del-num); color: var(--del-text); }
.status-M, .status-R { background: var(--hunk-bg); color: var(--hunk-text); }

.notes { max-width: 60rem; margin: 1rem 0; padding: 0.25rem 1.25rem; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; }
.notes h1, .notes h2, .notes h3 { margin: 1rem 0 0.25rem; font-size: 1rem; }
.notes pre { padding: 0.75rem; overflow-x: auto; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; }
.notes table { border-collapse: collapse; }
.notes th, .notes td { padding: 0.25rem 0.6rem; border: 1px solid var(--border); text-align: left; }

details.file { margin: 1rem 0; border: 1px solid var(--border); border-radius: 6px; }
/* The file name stays at the top of the window while its diff scrolls. */
details.file > summary {
  position: sticky;
  top: 0;
  padding: 0.5rem 0.75rem;
  background: var(--panel);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}
details.file[open] > summary { border-bottom: 1px solid var(--border); border-radius: 6px 6px 0 0; }

/* Fixed layout with a colgroup keeps the two number columns narrow and gives the code the rest. */
table.diff { width: 100%; border-collapse: collapse; table-layout: fixed; font: 12.5px/1.5 var(--mono); }
table.diff col.num { width: 3.75rem; }
table.diff td { padding: 0 0.6rem; vertical-align: top; }
td.num { color: var(--muted); text-align: right; user-select: none; }
/* Long lines wrap instead of scrolling sideways, and spaces and tabs are kept. */
td.code { white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
tr.add td.code { background: var(--add-bg); }
tr.add td.num { background: var(--add-num); color: var(--text); }
tr.del td.code { background: var(--del-bg); }
tr.del td.num { background: var(--del-num); color: var(--text); }
tr.hunk td { padding: 0.2rem 0.6rem; background: var(--hunk-bg); color: var(--hunk-text); }
tr.note td.code, .cut { color: var(--muted); font-style: italic; }

/* On a narrow window the list of steps moves to the top. */
@media (max-width: 900px) {
  body { display: block; }
  nav { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  nav ul { display: flex; flex-wrap: wrap; }
  main { padding: 1rem; }
}
`;
