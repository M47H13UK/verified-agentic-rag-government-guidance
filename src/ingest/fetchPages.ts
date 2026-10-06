import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GetJson } from "./http";
import type { FormatCount, ListedPage } from "./listPages";

const CONTENT_API = "https://www.gov.uk/api/content";

/** How many pages are being fetched at the same moment. The rate limit in http.ts still applies. */
const CONCURRENCY = 4;

export type FetchedPage = ListedPage & {
  /** Set on HTML attachments. The path of the publication page the attachment belongs to. */
  parent?: string;
};

export type FetchFailure = { link: string; reason: string };

export type FetchSummary = {
  /** Every page that was fetched. Listed pages first, then HTML attachments. */
  pages: FetchedPage[];
  failures: FetchFailure[];
  html_attachments: number;
  /** Attachments that are not HTML, counted by file type, for example { pdf: 812 }. */
  skipped_files: Record<string, number>;
};

/** `data/raw/_manifest.json`. It records what one fetch run found, and the load step reads it. */
export type Manifest = FetchSummary & {
  /** The day the page list was taken, for example "2026-10-06". */
  snapshot_date: string;
  /** Every document of the organisation, in all formats. */
  total_documents: number;
  formats: FormatCount[];
  /**
   * Network requests made to build this cache, retries included, and the time they took.
   * Both are totals over every run that added to the cache, so a rerun that is answered
   * from the cache leaves them as they were.
   */
  requests: number;
  fetch_seconds: number;
};

export function contentUrl(path: string): string {
  return `${CONTENT_API}${path}`;
}

/**
 * Turns a page path into a file name that is safe on any file system.
 * "/graduate-visa" becomes "graduate-visa.json".
 * "/guidance/immigration-rules" becomes "guidance__immigration-rules.json".
 */
export function contentFileName(path: string): string {
  const name = path
    .replace(/^\//, "")
    .replaceAll("/", "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_");
  // File names are capped at 255 bytes. A long name is cut, and a short hash of the full path
  // keeps two long paths with the same start apart.
  if (name.length > 180) {
    const hash = createHash("sha1").update(path).digest("hex").slice(0, 8);
    return `${name.slice(0, 180)}-${hash}.json`;
  }
  return `${name}.json`;
}

// The parts of a Content API attachment that this file reads.
type Attachment = { attachment_type?: string; url?: string; filename?: string };

/**
 * Reads `details.attachments` of a Content API document.
 * Returns the paths of the HTML attachments, and the file type of every other attachment.
 */
export function findAttachments(doc: unknown): { htmlPaths: string[]; skippedTypes: string[] } {
  const details = (doc as { details?: { attachments?: Attachment[] } }).details;
  const htmlPaths: string[] = [];
  const skippedTypes: string[] = [];

  for (const attachment of details?.attachments ?? []) {
    if (attachment.attachment_type === "html" && attachment.url?.startsWith("/")) {
      htmlPaths.push(attachment.url);
    } else if (attachment.attachment_type === "external") {
      skippedTypes.push("external link");
    } else {
      // "Guide_to_checks.PDF" gives "pdf".
      const extension = /\.([a-z0-9]+)$/i.exec(attachment.filename ?? "")?.[1];
      skippedTypes.push(extension?.toLowerCase() ?? "unknown");
    }
  }
  return { htmlPaths, skippedTypes };
}

/** Runs `work` on every item, with at most `limit` running at once. */
async function forEachLimit<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  // Each runner takes the next item until none are left. `limit` runners share the one counter.
  async function runner(): Promise<void> {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  }
  await Promise.all(Array.from({ length: limit }, runner));
}

/**
 * Fetches the Content API document of every listed page, then of every HTML attachment found.
 * A page that cannot be fetched goes into `failures` and the run carries on.
 */
export async function fetchPages(
  listed: ListedPage[],
  getJson: GetJson,
  onProgress: (stage: "pages" | "attachments", done: number, total: number) => void = () => {},
): Promise<FetchSummary> {
  const failures: FetchFailure[] = [];
  const skipped_files: Record<string, number> = {};
  const fetched = new Set<string>();
  const parentOf = new Map<string, string>();
  let done = 0;

  await forEachLimit(listed, CONCURRENCY, async (page) => {
    const result = await getJson(contentUrl(page.link), `content/${contentFileName(page.link)}`);
    done += 1;
    onProgress("pages", done, listed.length);
    if (!result.ok) {
      failures.push({ link: page.link, reason: result.reason });
      return;
    }
    fetched.add(page.link);

    const { htmlPaths, skippedTypes } = findAttachments(result.data);
    for (const type of skippedTypes) {
      skipped_files[type] = (skipped_files[type] ?? 0) + 1;
    }
    for (const path of htmlPaths) {
      // The first page that names an attachment is recorded as its parent.
      if (!parentOf.has(path)) {
        parentOf.set(path, page.link);
      }
    }
  });

  // Pages finish in a different order on every run. Listing order keeps the manifest stable.
  const pages: FetchedPage[] = listed.filter((page) => fetched.has(page.link));

  // An attachment that is also a listed page has been fetched already.
  const listedLinks = new Set(listed.map((page) => page.link));
  const attachmentPaths = [...parentOf.keys()].filter((path) => !listedLinks.has(path)).sort();
  const attachmentPages = new Map<string, FetchedPage>();
  done = 0;

  await forEachLimit(attachmentPaths, CONCURRENCY, async (path) => {
    const result = await getJson(contentUrl(path), `content/${contentFileName(path)}`);
    done += 1;
    onProgress("attachments", done, attachmentPaths.length);
    if (!result.ok) {
      failures.push({ link: path, reason: result.reason });
      return;
    }
    // Attachments are not in the search results, so their details come from their own document.
    const doc = result.data as { title?: string; public_updated_at?: string };
    attachmentPages.set(path, {
      link: path,
      title: doc.title ?? "",
      format: "html_publication",
      public_timestamp: doc.public_updated_at ?? "",
      parent: parentOf.get(path),
    });
  });

  for (const path of attachmentPaths) {
    const page = attachmentPages.get(path);
    if (page) {
      pages.push(page);
    }
  }

  // Sorted, so two runs over the same pages write the same manifest.
  failures.sort((a, b) => a.link.localeCompare(b.link));
  const mostCommonFirst = Object.entries(skipped_files).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return {
    pages,
    failures,
    html_attachments: attachmentPages.size,
    skipped_files: Object.fromEntries(mostCommonFirst),
  };
}

export function manifestPath(cacheDir: string): string {
  return join(cacheDir, "_manifest.json");
}

export function writeManifest(cacheDir: string, manifest: Manifest): void {
  writeFileSync(manifestPath(cacheDir), JSON.stringify(manifest, null, 2) + "\n");
}

/** Returns null when no fetch has finished yet. */
export function readManifest(cacheDir: string): Manifest | null {
  if (!existsSync(manifestPath(cacheDir))) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath(cacheDir), "utf8")) as Manifest;
}
