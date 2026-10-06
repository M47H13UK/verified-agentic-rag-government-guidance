// Records a spoken clip of every gold question with the local Kokoro voice. Run with `npm run gold:audio`.
//   npm run gold:audio -- --voice af_heart --file eval/questions.jsonl
//   KOKORO_BIN=/path/to/bin/kokoro npm run gold:audio
// The check page plays the clips. Without them it reads the question with the browser's own voice.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { loadEnv } from "../src/env";
import { loadQuestions } from "../src/eval/questions";
import { AUDIO_DIR, audioFileName } from "./lib/goldAudio";

// KOKORO_BIN can also be set in `.env`.
loadEnv();

/** Kokoro loads its model on every run, so one clip takes several seconds. This many run side by side. */
const AT_A_TIME = 3;
/** A run that takes longer than this is stuck. The very first run is slow, because Kokoro downloads its model. */
const CLIP_TIMEOUT_MS = 10 * 60 * 1000;
/** What a clip is called. Only files with such a name are ever removed. */
const CLIP_NAME = /^[0-9a-f]{40}\.wav$/;
/** Kokoro writes under this name first. A file with this prefix is a clip that was never finished. */
const UNFINISHED = "unfinished-";

const run = promisify(execFile);

const { values: flags } = parseArgs({
  options: {
    file: { type: "string", default: "eval/questions.jsonl" },
    voice: { type: "string", default: "af_heart" },
  },
});
// `||` and not `??`, so an empty KOKORO_BIN also means the default.
const kokoro = process.env.KOKORO_BIN || "kokoro";

/** One clip to have: its file name, the words to speak, and the questions that use it. */
type Clip = { name: string; text: string; ids: string[] };

try {
  const clips = clipsFor(flags.file);
  mkdirSync(AUDIO_DIR, { recursive: true });
  removeUnfinished();

  const missing = clips.filter((clip) => !existsSync(join(AUDIO_DIR, clip.name)));
  const kept = clips.length - missing.length;
  console.log(
    `Gold set ${flags.file}, ${clips.length} clips wanted, ${missing.length} to record with voice "${flags.voice}".`,
  );

  const result = await recordAll(missing);
  if (result.cannotStart) {
    console.error(`Could not start the Kokoro command "${kokoro}".`);
    console.error("Set KOKORO_BIN to the path of the kokoro program, for example");
    console.error("  KOKORO_BIN=/path/to/bin/kokoro npm run gold:audio");
    console.error(
      "The check page works without clips. It then reads the question with the browser's own voice.",
    );
    process.exitCode = 1;
  } else {
    const removed = removeUnused(new Set(clips.map((clip) => clip.name)));
    console.log(`Made ${result.made}, kept ${kept}, removed ${removed}.`);
    if (result.failed.length > 0) {
      console.error(`Could not record ${result.failed.join(", ")}.`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  // A missing questions file, or a bad line in it.
  console.error(String(error));
  process.exitCode = 1;
}

/** The clips the gold set needs, one per question text. Two questions with the same words share a clip. */
function clipsFor(file: string): Clip[] {
  const byName = new Map<string, Clip>();
  for (const question of loadQuestions(file)) {
    const name = audioFileName(question.question);
    const clip = byName.get(name) ?? { name, text: question.question, ids: [] };
    clip.ids.push(question.id);
    byName.set(name, clip);
  }
  return [...byName.values()];
}

/**
 * Records the given clips, a few at a time.
 * `cannotStart` is true when the Kokoro command itself could not be run. Nothing more is tried then.
 * `failed` lists the questions whose run started and went wrong.
 */
async function recordAll(
  clips: Clip[],
): Promise<{ made: number; failed: string[]; cannotStart: boolean }> {
  const queue = [...clips];
  const result = { made: 0, failed: [] as string[], cannotStart: false };

  // Each worker takes the next clip off the queue until the queue is empty.
  async function worker(): Promise<void> {
    for (let clip = queue.shift(); clip !== undefined; clip = queue.shift()) {
      const who = clip.ids.join(" and ");
      try {
        await record(clip);
        result.made++;
        console.log(`Recorded ${who} (${result.made} of ${clips.length}).`);
      } catch (error) {
        if (isStartFailure(error)) {
          // Every other clip would fail the same way, so the queue is emptied.
          result.cannotStart = true;
          queue.length = 0;
          return;
        }
        result.failed.push(who);
        console.error(`Could not record ${who}. ${lastLine(error)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: AT_A_TIME }, worker));
  return result;
}

/** Runs Kokoro for one clip. */
async function record(clip: Clip): Promise<void> {
  const unfinished = join(AUDIO_DIR, UNFINISHED + clip.name);
  // `execFile` hands the text over as one argument. No shell reads it, so a quote or a "$" in a
  // question cannot turn into a command.
  await run(kokoro, ["-m", flags.voice, "-t", clip.text, "-o", unfinished], {
    timeout: CLIP_TIMEOUT_MS,
  });
  // Kokoro writes the file piece by piece. After the rename the clip is there whole, or not at all.
  renameSync(unfinished, join(AUDIO_DIR, clip.name));
}

/** True when the program could not be run at all, for example because no such file exists. */
function isStartFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "syscall" in error &&
    typeof error.syscall === "string" &&
    error.syscall.startsWith("spawn")
  );
}

/** The last line Kokoro wrote before it failed. That is where a Python program names its error. */
function lastLine(error: unknown): string {
  const stderr =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr
      : "";
  const lines = (stderr.trim() === "" ? String(error) : stderr).trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

/** Removes what a run that was stopped half way left behind. */
function removeUnfinished(): void {
  for (const name of readdirSync(AUDIO_DIR)) {
    if (name.startsWith(UNFINISHED)) rmSync(join(AUDIO_DIR, name));
  }
}

/**
 * Removes the clips that no question uses any more, for example after a question was reworded.
 * Returns how many were removed.
 */
function removeUnused(wanted: Set<string>): number {
  let removed = 0;
  for (const name of readdirSync(AUDIO_DIR)) {
    if (CLIP_NAME.test(name) && !wanted.has(name)) {
      rmSync(join(AUDIO_DIR, name));
      removed++;
    }
  }
  return removed;
}
