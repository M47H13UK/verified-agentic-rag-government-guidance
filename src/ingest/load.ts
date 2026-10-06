import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "mongodb";
import { pagesCollection, passagesCollection } from "../db";
import type { Page, Passage } from "../types";
import { chunkPage } from "./chunk";
import { contentFileName, type Manifest } from "./fetchPages";
import type { CachedResponse } from "./http";
import { parsePage } from "./parse";

export type SkippedPage = { link: string; reason: string };

export type Corpus = { pages: Page[]; passages: Passage[]; skipped: SkippedPage[] };

/** `results/corpus.json`. The numbers the README quotes about the corpus. */
export type CorpusSummary = {
  /** The day the page list was taken from GOV.UK. */
  snapshot_date: string;
  /** Every document of the organisation on that day, in all formats. */
  total_documents: number;
  /** Pages in the corpus, HTML attachments included. */
  documents: number;
  /** The same pages counted by Content API document type. */
  documents_by_format: Record<string, number>;
  html_attachments: number;
  passages: number;
  total_words: number;
  passage_words: { min: number; median: number; max: number };
  /** Fetched pages that are not in the corpus, counted by reason. */
  pages_skipped: Record<string, number>;
  /** Attachments that are not HTML, counted by file type. Version 1 does not read them. */
  files_skipped: Record<string, number>;
  fetch_failures: number;
  fetch_requests: number;
  fetch_seconds: number;
  load_seconds: number;
};

/**
 * Turns the cached GOV.UK responses into pages and passages.
 * It reads only the files named in the manifest. It needs no network and no database.
 */
export function buildCorpus(cacheDir: string, manifest: Manifest): Corpus {
  const pages: Page[] = [];
  const passages: Passage[] = [];
  const skipped: SkippedPage[] = [];
  const seen = new Set<string>();

  for (const listed of manifest.pages) {
    const file = join(cacheDir, "content", contentFileName(listed.link));
    const cached = JSON.parse(readFileSync(file, "utf8")) as CachedResponse;

    const parsed = parsePage(cached.response);
    if (!parsed.ok) {
      skipped.push({ link: listed.link, reason: parsed.reason });
      continue;
    }
    const page = parsed.page;
    // The base path is the start of every passage ID, so the same page must not be loaded twice.
    if (seen.has(page.base_path)) {
      skipped.push({ link: listed.link, reason: "duplicate" });
      continue;
    }
    seen.add(page.base_path);

    const pagePassages = chunkPage(page);
    if (pagePassages.length === 0) {
      // The page has headings and nothing under them.
      skipped.push({ link: listed.link, reason: "no text" });
      continue;
    }
    passages.push(...pagePassages);
    pages.push({
      _id: page.base_path,
      title: page.title,
      format: page.format,
      url: `https://www.gov.uk${page.base_path}`,
      updated: page.updated,
      first_published: page.first_published,
      passage_count: pagePassages.length,
      word_count: pagePassages.reduce((sum, passage) => sum + passage.word_count, 0),
      fetched_at: cached.fetched_at,
    });
  }
  return { pages, passages, skipped };
}

/**
 * Creates the two indexes on the passages collection. Safe to call again when they exist.
 * The text index is what `search_guidance` queries. A match in the page title or in a heading
 * says more about what a passage is about than a match in its body, so those fields weigh more.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  const passages = passagesCollection(db);
  await passages.createIndex(
    { title: "text", heading_path: "text", headings: "text", text: "text" },
    {
      name: "passage_text",
      weights: { title: 5, heading_path: 5, headings: 3, text: 1 },
      default_language: "english",
    },
  );
  // For reading the passages of one page, or of one part, in order.
  await passages.createIndex({ base_path: 1, part_slug: 1, n: 1 });
}

/**
 * Replaces the whole corpus with the given pages and passages, then creates the indexes.
 * Loading twice leaves one copy, not two.
 */
export async function loadPassages(db: Db, pages: Page[], passages: Passage[]): Promise<void> {
  // Dropping a collection removes its documents and its indexes. Building the text index once,
  // after the insert, is about five times faster than updating it for every document.
  await pagesCollection(db).drop();
  await passagesCollection(db).drop();
  // insertMany rejects an empty list.
  if (pages.length > 0) {
    await pagesCollection(db).insertMany(pages);
  }
  if (passages.length > 0) {
    await passagesCollection(db).insertMany(passages);
  }
  await ensureIndexes(db);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  }
  return counts;
}

/** Works out the numbers for `results/corpus.json`. */
export function summariseCorpus(
  manifest: Manifest,
  corpus: Corpus,
  loadSeconds: number,
): CorpusSummary {
  const words = corpus.passages.map((passage) => passage.word_count).sort((a, b) => a - b);
  return {
    snapshot_date: manifest.snapshot_date,
    total_documents: manifest.total_documents,
    documents: corpus.pages.length,
    documents_by_format: countBy(corpus.pages, (page) => page.format),
    html_attachments: manifest.html_attachments,
    passages: corpus.passages.length,
    total_words: words.reduce((sum, count) => sum + count, 0),
    passage_words: {
      // The list is sorted, so the median is the value in the middle.
      min: words[0] ?? 0,
      median: words[Math.floor(words.length / 2)] ?? 0,
      max: words[words.length - 1] ?? 0,
    },
    pages_skipped: countBy(corpus.skipped, (page) => page.reason),
    files_skipped: manifest.skipped_files,
    fetch_failures: manifest.failures.length,
    fetch_requests: manifest.requests,
    fetch_seconds: manifest.fetch_seconds,
    load_seconds: loadSeconds,
  };
}
