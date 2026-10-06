// The data pipeline, run from the command line.
// `npm run ingest:fetch` downloads the pages into data/raw. Add `-- --refresh` to ignore the cache.
import { join } from "node:path";
import { parseArgs } from "node:util";
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

const RAW_DIR = "data/raw";

/** Prints a label and a right-aligned value, so the numbers line up in a column. */
function row(label: string, value: number | string): void {
  const text = typeof value === "number" ? value.toLocaleString("en-GB") : value;
  console.log(`${label.padEnd(30)}${text.padStart(8)}`);
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

const { values, positionals } = parseArgs({
  options: { refresh: { type: "boolean", default: false } },
  allowPositionals: true,
});
const command = positionals[0];

try {
  if (command === "fetch") {
    await runFetch(values.refresh);
  } else {
    console.error("Usage: tsx src/ingest/cli.ts fetch [--refresh]");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
