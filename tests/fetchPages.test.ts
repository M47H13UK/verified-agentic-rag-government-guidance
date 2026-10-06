import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contentFileName, fetchPages, findAttachments } from "../src/ingest/fetchPages";
import { createHttp } from "../src/ingest/http";
import type { ListedPage } from "../src/ingest/listPages";
import { fakeFetch, tempDir } from "./helpers/fakeFetch";
import { readSample } from "./helpers/fixtures";

const API = "https://www.gov.uk/api/content";

// A publication page shaped like the real ones. Its text sits in the attachments.
const publication = {
  base_path: "/government/publications/example",
  document_type: "guidance",
  details: {
    body: "<p>A short summary.</p>",
    attachments: [
      { attachment_type: "html", url: "/government/publications/example/the-guide" },
      { attachment_type: "file", filename: "The_guide.PDF", content_type: "application/pdf" },
      { attachment_type: "file", filename: "register.csv", content_type: "text/csv" },
      { attachment_type: "external", url: "https://example.org/form" },
    ],
  },
};

const htmlAttachment = {
  base_path: "/government/publications/example/the-guide",
  document_type: "html_publication",
  title: "The guide",
  public_updated_at: "2026-01-02T09:00:00+00:00",
  details: { body: "<p>The real text.</p>" },
};

describe("contentFileName", () => {
  it("maps a page path to a flat, safe file name", () => {
    expect(contentFileName("/graduate-visa")).toBe("graduate-visa.json");
    expect(contentFileName("/skilled-worker-visa/your-job")).toBe(
      "skilled-worker-visa__your-job.json",
    );
    expect(contentFileName("/guidance/a page?x=1")).toBe("guidance__a_page_x_1.json");
  });

  it("cuts a very long path and adds a hash, so two long paths stay apart", () => {
    const a = contentFileName(`/government/publications/${"x".repeat(300)}/one`);
    const b = contentFileName(`/government/publications/${"x".repeat(300)}/two`);
    expect(a.length).toBeLessThan(200);
    expect(a).not.toBe(b);
  });
});

describe("findAttachments", () => {
  it("returns HTML attachment paths and the type of every other attachment", () => {
    expect(findAttachments(publication)).toEqual({
      htmlPaths: ["/government/publications/example/the-guide"],
      skippedTypes: ["pdf", "csv", "external link"],
    });
  });

  it("finds nothing on a guide, which has no attachments", () => {
    expect(findAttachments(readSample("content-graduate-visa.json"))).toEqual({
      htmlPaths: [],
      skippedTypes: [],
    });
  });
});

describe("fetchPages", () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });

  afterEach(() => {
    remove();
  });

  const listed: ListedPage[] = [
    { link: "/graduate-visa", title: "Graduate visa", format: "guide", public_timestamp: "" },
    {
      link: "/government/publications/example",
      title: "Example",
      format: "guidance",
      public_timestamp: "",
    },
    { link: "/gone-page", title: "Gone", format: "answer", public_timestamp: "" },
  ];

  const replies: Record<string, unknown> = {
    [`${API}/graduate-visa`]: readSample("content-graduate-visa.json"),
    [`${API}/government/publications/example`]: publication,
    [`${API}/government/publications/example/the-guide`]: htmlAttachment,
  };

  it("fetches listed pages and their HTML attachments, and records what it could not get", async () => {
    const { fetchFn } = fakeFetch((url) =>
      url in replies ? { body: replies[url] } : { status: 404, body: {} },
    );
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 });

    const summary = await fetchPages(listed, getJson);

    expect(summary.pages.map((p) => p.link)).toEqual([
      "/graduate-visa",
      "/government/publications/example",
      "/government/publications/example/the-guide",
    ]);
    expect(summary.pages[2]).toEqual({
      link: "/government/publications/example/the-guide",
      title: "The guide",
      format: "html_publication",
      public_timestamp: "2026-01-02T09:00:00+00:00",
      parent: "/government/publications/example",
    });
    expect(summary.html_attachments).toBe(1);
    expect(summary.skipped_files).toEqual({ pdf: 1, csv: 1, "external link": 1 });
    expect(summary.failures).toEqual([{ link: "/gone-page", reason: "HTTP 404" }]);
    expect(existsSync(join(dir, "content", "graduate-visa.json"))).toBe(true);
  });

  it("makes no requests on a second run, because every page is cached", async () => {
    const { fetchFn, calls } = fakeFetch((url) => ({ body: replies[url] ?? {} }));
    await fetchPages(
      listed.slice(0, 2),
      createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 }).getJson,
    );
    const requestsFirstRun = calls.length;

    const second = createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 });
    const summary = await fetchPages(listed.slice(0, 2), second.getJson);

    expect(requestsFirstRun).toBe(3);
    expect(calls).toHaveLength(3);
    expect(second.stats).toEqual({ requests: 0, cache_hits: 3 });
    expect(summary.pages).toHaveLength(3);
  });
});
