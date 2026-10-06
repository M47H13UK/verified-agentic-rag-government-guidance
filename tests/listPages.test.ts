import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttp } from "../src/ingest/http";
import { countFormats, listFormat, searchUrl, type ListedPage } from "../src/ingest/listPages";
import { fakeFetch, tempDir } from "./helpers/fakeFetch";
import { readSample } from "./helpers/fixtures";

type SearchSample = { results: ListedPage[]; total: number };

describe("listing pages with the Search API", () => {
  let dir: string;
  let remove: () => void;

  beforeEach(() => {
    ({ dir, remove } = tempDir());
  });

  afterEach(() => {
    remove();
  });

  it("builds the search URL for one format and one start position", () => {
    expect(searchUrl("guide", 0)).toBe(
      "https://www.gov.uk/api/search.json?filter_organisations=uk-visas-and-immigration" +
        "&filter_format=guide&count=1000&start=0&fields=link,title,format,public_timestamp",
    );
  });

  it("asks page after page until it has every guide", async () => {
    const sample = readSample<SearchSample>("search-guides.json");
    // Answers like the real API. It returns `count` results from position `start`.
    const { fetchFn, calls } = fakeFetch((url) => {
      const params = new URL(url).searchParams;
      const start = Number(params.get("start"));
      const count = Number(params.get("count"));
      return { body: { results: sample.results.slice(start, start + count), total: sample.total } };
    });
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 });

    const pages = await listFormat("guide", getJson, 40);

    // 101 guides at 40 per request is three requests.
    expect(calls.map((url) => new URL(url).searchParams.get("start"))).toEqual(["0", "40", "80"]);
    expect(pages).toHaveLength(101);
    expect(new Set(pages.map((p) => p.link)).size).toBe(101);
    expect(pages[0]).toEqual({
      link: "/evisa",
      title: "eVisas: access and use your online immigration status",
      format: "guide",
      public_timestamp: "2025-07-15T09:07:02Z",
    });
    expect(pages.some((p) => p.link === "/graduate-visa")).toBe(true);
  });

  it("stops with a clear error when the Search API fails", async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 404, body: {} }));
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 });

    await expect(listFormat("guide", getJson)).rejects.toThrow('format "guide"');
  });

  it("counts documents by format and marks the kept ones", async () => {
    const { fetchFn } = fakeFetch(() => ({ body: readSample("search-facets.json") }));
    const { getJson } = createHttp({ cacheDir: dir, fetchFn, minGapMs: 0 });

    const counts = await countFormats(getJson);

    expect(counts.total).toBe(2596);
    expect(counts.formats).toHaveLength(41);
    const kept = counts.formats.filter((f) => f.kept);
    expect(kept.map((f) => f.format).sort()).toEqual([
      "answer",
      "detailed_guide",
      "guidance",
      "guide",
      "step_by_step_nav",
    ]);
    // 963 + 101 + 59 + 35 + 11 on 5 October 2026.
    expect(kept.reduce((sum, f) => sum + f.documents, 0)).toBe(1169);
  });
});
