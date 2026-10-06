import { describe, expect, it } from "vitest";
import { chunkPage, MAX_WORDS } from "../src/ingest/chunk";
import { parsePage, type Block, type ParsedPage } from "../src/ingest/parse";
import type { Passage } from "../src/types";
import { readSample, samplePassages, sampleQuotes } from "./helpers/fixtures";

/** Parses and chunks one of the sample Content API responses. */
function chunkSample(name: string): Passage[] {
  const result = parsePage(readSample(name));
  if (!result.ok) throw new Error(result.reason);
  return chunkPage(result.page);
}

/** A page without parts, made of the given blocks. */
function pageOf(blocks: Block[]): ParsedPage {
  return {
    base_path: "/test-page",
    title: "Test page",
    format: "answer",
    updated: "2026-01-01T00:00:00+00:00",
    first_published: null,
    parts: [{ slug: "body", title: null, blocks }],
  };
}

function heading(level: number, text: string): Block {
  return { type: "heading", level, text };
}

/** A paragraph of `count` words. Each word carries the label, so the tests can tell paragraphs apart. */
function paragraph(count: number, label = "word"): Block {
  return { type: "paragraph", text: Array.from({ length: count }, () => label).join(" ") };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

describe("chunking the Graduate visa guide", () => {
  const passages = chunkSample("content-graduate-visa.json");

  it("reproduces the 13 stored passages exactly", () => {
    expect(passages).toEqual(samplePassages());
  });

  it("contains every sample quote word for word, after collapsing whitespace", () => {
    for (const quote of sampleQuotes()) {
      const passage = passages.find((p) => p._id === quote.passage_id);
      expect(passage, quote.passage_id).toBeDefined();
      expect(collapse(passage!.text)).toContain(collapse(quote.quote));
    }
  });
});

describe("chunking the Skilled Worker guide", () => {
  const passages = chunkSample("content-skilled-worker-visa.json");

  it("gives passages for all 14 parts, numbered from 1 inside each part", () => {
    const slugs = [...new Set(passages.map((p) => p.part_slug))];
    expect(slugs).toHaveLength(14);

    for (const slug of slugs) {
      const numbers = passages.filter((p) => p.part_slug === slug).map((p) => p.n);
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
    expect(new Set(passages.map((p) => p._id)).size).toBe(passages.length);
  });

  it("keeps every passage within the word limit and never empty", () => {
    for (const p of passages) {
      expect(p._id).toBe(`/skilled-worker-visa#${p.part_slug}#${p.n}`);
      expect(p.word_count).toBeGreaterThan(0);
      expect(p.word_count).toBeLessThanOrEqual(MAX_WORDS);
      expect(p.text.split(/\s+/).filter(Boolean)).toHaveLength(p.word_count);
    }
  });

  it("links the first part to the guide and later parts to their own address", () => {
    const first = passages.find((p) => p.part_slug === "overview")!;
    expect(first.url).toBe("https://www.gov.uk/skilled-worker-visa");
    expect(first.heading_path).toBe("Skilled Worker visa > Overview");

    // The URL uses the slug and the heading path uses the title. Here the two differ.
    const last = passages.find((p) => p.part_slug === "second-job")!;
    expect(last.url).toBe("https://www.gov.uk/skilled-worker-visa/second-job");
    expect(last.heading_path).toBe("Skilled Worker visa > Taking on additional work");
  });
});

describe("chunking a page without parts", () => {
  const passages = chunkSample("content-employee-lose-sponsor-licence.json");

  it("uses the part slug body and leaves the part title out of the heading path", () => {
    expect(passages.map((p) => p._id)).toEqual([
      "/employee-lose-sponsor-licence#body#1",
      "/employee-lose-sponsor-licence#body#2",
    ]);
    expect(passages[0]!.heading_path).toBe("Employees: if your visa sponsor loses their licence");
    expect(passages[1]!.heading_path).toBe(
      "Employees: if your visa sponsor loses their licence > If you’re outside the UK",
    );
    for (const p of passages) {
      expect(p.url).toBe("https://www.gov.uk/employee-lose-sponsor-licence");
      expect(p.format).toBe("answer");
    }
  });

  it("writes a table row as one line of text", () => {
    expect(passages[0]!.text.split("\n")).toContain("Already working | You can keep working");
  });
});

describe("merging and splitting", () => {
  it("merges small sections forward and keeps their headings as lines of text", () => {
    const passages = chunkPage(
      pageOf([
        heading(2, "First"),
        paragraph(50, "one"),
        heading(2, "Second"),
        paragraph(60, "two"),
        heading(2, "Third"),
        paragraph(70, "three"),
      ]),
    );

    expect(passages).toHaveLength(1);
    const passage = passages[0]!;
    // The passage starts at "First", so that heading is in the path and not in the text.
    expect(passage.heading_path).toBe("Test page > First");
    expect(passage.headings).toEqual(["Second", "Third"]);
    expect(passage.text.split("\n")).toHaveLength(5);
    expect(passage.text.split("\n")[1]).toBe("Second");
    expect(passage.word_count).toBe(50 + 1 + 60 + 1 + 70);
  });

  it("does not merge past the word limit", () => {
    const passages = chunkPage(
      pageOf([heading(2, "Short"), paragraph(100), heading(2, "Long"), paragraph(350)]),
    );

    expect(passages.map((p) => p.word_count)).toEqual([100, 350]);
    expect(passages.map((p) => p.heading_path)).toEqual(["Test page > Short", "Test page > Long"]);
  });

  it("joins a short last section to the passage before it", () => {
    const passages = chunkPage(
      pageOf([heading(2, "Main"), paragraph(200), heading(2, "Contact"), paragraph(40)]),
    );

    expect(passages).toHaveLength(1);
    expect(passages[0]!.headings).toEqual(["Contact"]);
  });

  it("splits a long section on paragraph boundaries into even pieces", () => {
    const paragraphs = Array.from({ length: 9 }, (_, i) => paragraph(100, `p${i}`));
    const passages = chunkPage(pageOf([heading(2, "Long section"), ...paragraphs]));

    // 900 words need three passages. Even pieces are 300 words each, not 400, 400 and 100.
    expect(passages.map((p) => p.word_count)).toEqual([300, 300, 300]);
    expect(passages.map((p) => p._id)).toEqual([
      "/test-page#body#1",
      "/test-page#body#2",
      "/test-page#body#3",
    ]);
    for (const p of passages) {
      expect(p.heading_path).toBe("Test page > Long section");
    }
    // No paragraph is lost, cut in two or moved.
    const allLines = passages.flatMap((p) => p.text.split("\n"));
    expect(allLines).toEqual(paragraphs.map((block) => block.text));
  });

  it("keeps a list with the sentence that introduces it when it splits", () => {
    const listItems: Block[] = Array.from({ length: 6 }, () => ({
      type: "list_item",
      text: paragraph(20, "item").text,
    }));
    const passages = chunkPage(
      pageOf([
        heading(2, "Rules"),
        paragraph(180, "before"),
        { type: "paragraph", text: "You must do all of the following:" },
        ...listItems,
        paragraph(150, "after"),
      ]),
    );

    expect(passages).toHaveLength(2);
    const firstLines = passages[0]!.text.split("\n");
    expect(firstLines[1]).toBe("You must do all of the following:");
    expect(firstLines).toHaveLength(2 + listItems.length);
    expect(passages[1]!.word_count).toBe(150);
  });

  it("splits a long h2 section at its h3 headings and names both in the heading path", () => {
    const passages = chunkPage(
      pageOf([
        heading(2, "Money"),
        heading(3, "Course fees"),
        paragraph(250),
        heading(3, "Living costs"),
        paragraph(250),
      ]),
    );

    expect(passages.map((p) => p.heading_path)).toEqual([
      "Test page > Money > Course fees",
      "Test page > Money > Living costs",
    ]);
    expect(passages.map((p) => p.word_count)).toEqual([250, 250]);
  });
});
