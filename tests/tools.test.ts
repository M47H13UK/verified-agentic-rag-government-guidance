import type { Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadPassages } from "../src/ingest/load";
import { getPassagesById, readPassage } from "../src/tools/readPassage";
import { makeSnippet, searchGuidance } from "../src/tools/searchGuidance";
import { samplePassages } from "./helpers/fixtures";
import { createTestDb } from "./helpers/testDb";

// These tests run against a real MongoDB text index, loaded with the 13 Graduate visa passages.

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, drop } = await createTestDb());
  await loadPassages(db, [], samplePassages());
});

afterAll(async () => {
  await drop();
});

describe("searchGuidance", () => {
  it("finds the passage that says how long a Graduate visa lasts", async () => {
    const hits = await searchGuidance(db, "graduate visa how long");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(8);
    expect(hits.map((hit) => hit.passage_id)).toContain("/graduate-visa#overview#2");
  });

  it("returns everything a citation needs, and a snippet instead of the full text", async () => {
    const [hit] = await searchGuidance(db, "healthcare surcharge");
    expect(hit).toMatchObject({
      title: "Graduate visa",
      url: expect.stringContaining("https://www.gov.uk/graduate-visa"),
      updated: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
    });
    expect(hit!.heading_path).toContain("Graduate visa");
    expect(hit!.snippet.toLowerCase()).toContain("surcharge");
    expect(hit!.snippet.split(" ").length).toBeLessThanOrEqual(82);
  });

  it("ranks a heading match above a body match", async () => {
    // "Your partner and children" is a part title, so it is in the heading path of four passages.
    const hits = await searchGuidance(db, "partner children", 3);
    for (const hit of hits) {
      expect(hit.heading_path).toContain("Your partner and children");
    }
  });

  it("respects k and returns nothing for an empty query", async () => {
    expect(await searchGuidance(db, "visa", 2)).toHaveLength(2);
    expect(await searchGuidance(db, "   ")).toEqual([]);
  });

  it("returns the same order every time", async () => {
    const first = await searchGuidance(db, "apply online documents");
    const second = await searchGuidance(db, "apply online documents");
    expect(second.map((hit) => hit.passage_id)).toEqual(first.map((hit) => hit.passage_id));
  });
});

describe("makeSnippet", () => {
  const long = [
    "Graduate visa fees are listed first.",
    "filler ".repeat(120).trim(),
    "With a Graduate visa you can work in most jobs and be self-employed.",
    "filler ".repeat(60).trim(),
  ].join(" ");

  it("returns a short passage whole", () => {
    expect(makeSnippet("Short text here.", "anything")).toBe("Short text here.");
  });

  it("shows the window with the most query words, not the start of the passage", () => {
    const snippet = makeSnippet(long, "work self-employed jobs", "Graduate visa");
    expect(snippet).toContain("work in most jobs");
    expect(snippet.startsWith("… ")).toBe(true);
  });

  it("ignores words from the page title when choosing the window", () => {
    // "graduate" and "visa" appear at the start, but they are title words and must not win.
    const snippet = makeSnippet(long, "graduate visa self-employed", "Graduate visa");
    expect(snippet).toContain("self-employed");
  });
});

describe("readPassage", () => {
  it("returns the full text and both neighbours", async () => {
    const passage = await readPassage(db, "/graduate-visa#overview#2");
    expect(passage).toMatchObject({
      passage_id: "/graduate-visa#overview#2",
      previous_passage_id: "/graduate-visa#overview#1",
      next_passage_id: "/graduate-visa#overview#3",
    });
    expect(passage!.text).toContain("18 months if you apply on or after 1 January 2027");
  });

  it("has no previous neighbour for the first passage of a part", async () => {
    const passage = await readPassage(db, "/graduate-visa#how-much-it-costs#1");
    expect(passage!.previous_passage_id).toBeNull();
    expect(passage!.next_passage_id).toBeNull();
  });

  it("returns null for an unknown ID", async () => {
    expect(await readPassage(db, "/graduate-visa#overview#99")).toBeNull();
  });
});

describe("getPassagesById", () => {
  it("returns the passages that exist and leaves out the rest", async () => {
    const found = await getPassagesById(db, [
      "/graduate-visa#overview#2",
      "/graduate-visa#overview#2",
      "/nope#body#1",
    ]);
    expect([...found.keys()]).toEqual(["/graduate-visa#overview#2"]);
  });
});
