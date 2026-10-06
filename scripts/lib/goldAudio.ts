import { createHash } from "node:crypto";

// Shared by `npm run gold:audio`, which records the clips, and the check page server, which plays them.

/** The folder of the recorded clips. It is not in git. */
export const AUDIO_DIR = "data/audio";

/**
 * The file name of the clip for a question text.
 * The name is a hash of the text and not the question ID. A question that is edited after its clip
 * was recorded gets another name, so an old clip can never play for new words.
 */
export function audioFileName(text: string): string {
  return `${createHash("sha1").update(text).digest("hex")}.wav`;
}
