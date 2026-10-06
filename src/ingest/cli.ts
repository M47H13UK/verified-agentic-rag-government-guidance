// The data pipeline, run from the command line.
// `npm run ingest:fetch` downloads the pages into data/raw. Add `-- --refresh` to ignore the cache.
// `npm run ingest:load` chunks the downloaded pages and loads them into MongoDB.
// `npm run ingest` does both.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { closeDb, getDb, passagesCollection } from "../db";
import { loadEnv } from "../env";
import {
  contentFileName,
  fetchPages,
  manifestPath,
  readManifest,
  writeManifest,
  type Manifest,
} from "./fetchPages";
import { createHttp } from "./http";
import { countFormats, listPages, ORGANISATION, type FormatCount } from "./listPages";
import { buildCorpus, loadPassages, summariseCorpus } from "./load";

const RAW_DIR = "data/raw";
const CORPUS_FILE = "results/corpus.json";

/** Prints a label and a right-aligned value, so the numbers line up in a column. */
function row(label: string, value: number | string): void {
  const text = typeof value === "number" ? value.toLocaleString("en-GB") : value;
  console.log(`${label.padEnd(30)}${text.padStart(10)}`);
}

function sumDocuments(formats: FormatCount[]): number {
  return formats.reduce((sum, f) => sum + f.documents, 0);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatDuration(seconds: number): string {
  return seconds < 60
    ? `${seconds.toFixed(1)} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

async function runFetch(refresh: boolean): Promise<void> {
  const started = Date.now();
  const { getJson, stats } = createHttp({ cacheDir: RAW_DIR, refresh });

  const counts = await countFormats(getJson);
  const snapshotDate = counts.fetched_at.slice(0, 10);
  console.log(`Snapshot ${snapshotDate}, organisation ${ORGANISATION}`);
  row("All documents", counts.total);

  const kept = counts.formats.filter((f) => f.kept);
  const skipped = counts.formats.filter((f) => !f.kept);
  console.log("\nKept formats");
  for (const f of kept) row(`  ${f.format}`, f.documents);
  row("  total kept", sumDocuments(kept));
  console.log("Skipped formats");
  for (const f of skipped) row(`  ${f.format}`, f.documents);
  row("  total skipped", sumDocuments(skipped));

  const listed = await listPages(getJson);
  console.log(`\nFetching ${listed.length.toLocaleString("en-GB")} pages`);
  const summary = await fetchPages(listed, getJson, (stage, done, total) => {
    // A full run takes minutes, so show that it is still moving.
    if (done % 200 === 0 || done === total) {
      console.log(`  ${stage} ${done} of ${total}`);
    }
  });

  const seconds = (Date.now() - started) / 1000;
  // The totals describe the whole cache. A run that adds to an existing cache adds to them,
  // and a run that fetched nothing leaves them alone. `--refresh` starts again from zero.
  const earlier = refresh ? null : readManifest(RAW_DIR);
  const fetchedSomething = stats.requests > 0;
  const manifest: Manifest = {
    snapshot_date: snapshotDate,
    total_documents: counts.total,
    formats: counts.formats,
    requests: (earlier?.requests ?? 0) + stats.requests,
    fetch_seconds: round1((earlier?.fetch_seconds ?? 0) + (fetchedSomething ? seconds : 0)),
    ...summary,
  };
  writeManifest(RAW_DIR, manifest);

  console.log("");
  row("Pages fetched", summary.pages.length - summary.html_attachments);
  row("HTML attachments fetched", summary.html_attachments);
  console.log("Files skipped, because version 1 reads HTML only");
  for (const [type, count] of Object.entries(summary.skipped_files)) row(`  ${type}`, count);
  row("Failures", summary.failures.length);
  for (const failure of summary.failures) console.log(`  ${failure.link}  ${failure.reason}`);
  row("Requests made by this run", stats.requests);
  row("Answered from the cache", stats.cache_hits);
  row("Time taken by this run", formatDuration(seconds));
  row("Requests to build the cache", manifest.requests);
  row("Time to build the cache", formatDuration(manifest.fetch_seconds));
  console.log(`Manifest      ${manifestPath(RAW_DIR)}`);
  const example = summary.pages[0];
  if (example) {
    console.log(`One raw file  ${join(RAW_DIR, "content", contentFileName(example.link))}`);
  }
}

async function runLoad(): Promise<void> {
  const started = Date.now();
  const manifest = readManifest(RAW_DIR);
  if (!manifest) {
    throw new Error(`No ${manifestPath(RAW_DIR)} yet. Run "npm run ingest:fetch" first.`);
  }

  console.log(`Chunking the snapshot of ${manifest.snapshot_date} from ${RAW_DIR}`);
  const corpus = buildCorpus(RAW_DIR, manifest);

  loadEnv();
  try {
    const db = await getDb();
    await loadPassages(db, corpus.pages, corpus.passages);
    const summary = summariseCorpus(manifest, corpus, round1((Date.now() - started) / 1000));

    mkdirSync(dirname(CORPUS_FILE), { recursive: true });
    writeFileSync(CORPUS_FILE, JSON.stringify(summary, null, 2) + "\n");

    row("Pages loaded", summary.documents);
    for (const [format, count] of Object.entries(summary.documents_by_format)) {
      row(`  ${format}`, count);
    }
    row("Pages skipped", corpus.skipped.length);
    for (const [reason, count] of Object.entries(summary.pages_skipped)) {
      row(`  ${reason}`, count);
    }
    row("Passages", summary.passages);
    row("Total words", summary.total_words);
    row("Shortest passage, in words", summary.passage_words.min);
    row("Median passage, in words", summary.passage_words.median);
    row("Longest passage, in words", summary.passage_words.max);
    row("Passages now in MongoDB", await passagesCollection(db).countDocuments());
    row("Time taken", formatDuration(summary.load_seconds));
    console.log(`Database      ${db.databaseName}`);
    console.log(`Summary       ${CORPUS_FILE}`);
  } finally {
    await closeDb();
  }
}

const { values, positionals } = parseArgs({
  options: { refresh: { type: "boolean", default: false } },
  allowPositionals: true,
});
const command = positionals[0];

try {
  if (command === "fetch") {
    await runFetch(values.refresh);
  } else if (command === "load") {
    await runLoad();
  } else {
    console.error("Usage: tsx src/ingest/cli.ts fetch [--refresh]");
    console.error("       tsx src/ingest/cli.ts load");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
