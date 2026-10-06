import { describe, expect, it } from "vitest";
import { AUDIO_DIR, audioFileName } from "../scripts/lib/goldAudio";

describe("audioFileName", () => {
  it("gives the same name for the same text", () => {
    const text = "How long does a Graduate visa last?";
    expect(audioFileName(text)).toBe(audioFileName(text));
  });

  it("gives another name when the text changes", () => {
    // One changed character is an edited question. Its old clip must not play.
    expect(audioFileName("How long does a Graduate visa last?")).not.toBe(
      audioFileName("How long does a Graduate visa last"),
    );
  });

  it("is the SHA-1 of the text in hex, with the .wav ending", () => {
    // The well-known SHA-1 of "abc".
    expect(audioFileName("abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d.wav");
  });

  it("is safe as a file name whatever the text holds", () => {
    const texts = ["", "../../etc/passwd", "a/b\\c", "What’s the fee? £937\n", "x".repeat(5000)];
    for (const text of texts) {
      expect(audioFileName(text)).toMatch(/^[0-9a-f]{40}\.wav$/);
    }
  });
});

describe("AUDIO_DIR", () => {
  it("is a folder inside the project", () => {
    expect(AUDIO_DIR).toBe("data/audio");
  });
});
