import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import { pagesCollection, passagesCollection } from "../src/db";
import { contentFileName, type Manifest } from "../src/ingest/fetchPages";
import { buildCorpus, ensureIndexes, loadPassages, summariseCorpus } from "../src/ingest/load";
import type { Page } from "../src/types";
import { tempDir } from "./helpers/fakeFetch";
import { readSample, samplePassages } from "./helpers/fixtures";
import { createTestDb } from "./helpers/testDb";

const graduatePage: Page = {
  _id: "/graduate-visa",
  title: "Graduate visa",
  format: "guide",
  url: "https://www.gov.uk/graduate-visa",
  updated: "2024-10-31T17:01:07+00:00",
  first_published: "2021-07-01T09:00:03+01:00",
  passage_count: 13,
  word_count: 2998,
  fetched_at: "2026-10-05T22:26:25.000Z",
};

describe("loading passages into MongoDB", () => {
  let db: Db;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
    await loadPassages(db, [graduatePage], samplePassages());
  });

  afterAll(async () => {
    await drop();
  });

  it("leaves one copy of the corpus when it is loaded twice", async () => {
    await loadPassages(db, [graduatePage], samplePassages());

    expect(await passagesCollection(db).countDocuments()).toBe(13);
    expect(await pagesCollection(db).countDocuments()).toBe(1);
  });

  it("creates the text index and the page order index", async () => {
    // A second call must be harmless.
    await ensureIndexes(db);
    const indexes = await passagesCollection(db).indexes();

    const textIndex = indexes.find((index) => index.name === "passage_text");
    expect(textIndex?.weights).toEqual({ title: 5, heading_path: 5, headings: 3, text: 1 });
    expect(textIndex?.default_language).toBe("english");
    expect(indexes.map((index) => index.key)).toContainEqual({ base_path: 1, part_slug: 1, n: 1 });
    // The two above plus the index MongoDB keeps on _id.
    expect(indexes).toHaveLength(3);
  });

  it("ranks the passage about the searched words first", async () => {
    const found = await passagesCollection(db)
      .find({ $text: { $search: "sabbatical officer" } })
      .sort({ score: { $meta: "textScore" } })
      .toArray();

    // "officer" also matches "Office" in other passages, because the index stems English words.
    // The passage with both words, one of them in a heading, must still come first.
    expect(found.length).toBeGreaterThan(1);
    expect(found[0]!._id).toBe("/graduate-visa#course-you-studied#1");
  });
});

describe("buildCorpus", () => {
  it("chunks the cached pages named in the manifest and records what it skipped", () => {
    const { dir, remove } = tempDir();
    const fetchedAt = "2026-10-06T21:11:03.892Z";
    const cached: Record<string, unknown> = {
      "/graduate-visa": readSample("content-graduate-visa.json"),
      "/employee-lose-sponsor-licence": readSample("content-employee-lose-sponsor-licence.json"),
      "/moved-page": { base_path: "/moved-page", document_type: "redirect", details: {} },
    };
    mkdirSync(join(dir, "content"));
    for (const [link, response] of Object.entries(cached)) {
      const file = join(dir, "content", contentFileName(link));
      writeFileSync(file, JSON.stringify({ url: link, fetched_at: fetchedAt, response }));
    }
    const manifest: Manifest = {
      snapshot_date: "2026-10-06",
      total_documents: 2597,
      formats: [],
      requests: 3,
      fetch_seconds: 1.5,
      pages: Object.keys(cached).map((link) => ({
        link,
        title: "",
        format: "",
        public_timestamp: "",
      })),
      failures: [],
      html_attachments: 0,
      skipped_files: { pdf: 2 },
    };

    try {
      const corpus = buildCorpus(dir, manifest);

      expect(corpus.pages.map((page) => page._id)).toEqual([
        "/graduate-visa",
        "/employee-lose-sponsor-licence",
      ]);
      expect(corpus.pages[0]).toEqual({ ...graduatePage, fetched_at: fetchedAt });
      expect(corpus.passages).toHaveLength(13 + 2);
      expect(corpus.skipped).toEqual([{ link: "/moved-page", reason: "redirect" }]);

      const summary = summariseCorpus(manifest, corpus, 0.4);
      expect(summary.documents).toBe(2);
      expect(summary.documents_by_format).toEqual({ guide: 1, answer: 1 });
      expect(summary.passages).toBe(15);
      expect(summary.total_words).toBe(2998 + 462);
      expect(summary.passage_words).toEqual({ min: 97, median: 221, max: 336 });
      expect(summary.pages_skipped).toEqual({ redirect: 1 });
      expect(summary.files_skipped).toEqual({ pdf: 2 });
    } finally {
      remove();
    }
  });
});
