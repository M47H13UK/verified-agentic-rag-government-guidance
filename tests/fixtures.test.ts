import { describe, expect, it } from "vitest";
import { samplePassages, sampleQuotes } from "./helpers/fixtures";

describe("sample fixtures", () => {
  const passages = samplePassages();

  it("has 13 Graduate visa passages with unique IDs", () => {
    expect(passages).toHaveLength(13);
    expect(new Set(passages.map((p) => p._id)).size).toBe(13);
  });

  it("builds every passage ID from the base path, the part slug and the position", () => {
    for (const p of passages) {
      expect(p._id).toBe(`${p.base_path}#${p.part_slug}#${p.n}`);
    }
  });

  it("stores a word count that matches the text", () => {
    for (const p of passages) {
      expect(p.text.split(/\s+/).filter(Boolean)).toHaveLength(p.word_count);
    }
  });

  it("has quotes that point at a real passage", () => {
    const ids = new Set(passages.map((p) => p._id));
    for (const q of sampleQuotes()) {
      expect(ids.has(q.passage_id)).toBe(true);
    }
  });
});
