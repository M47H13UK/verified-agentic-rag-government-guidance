import type { GetJson } from "./http";

const SEARCH_API = "https://www.gov.uk/api/search.json";
export const ORGANISATION = "uk-visas-and-immigration";

/**
 * The formats that hold guidance written for the public.
 * News, statistics, forms, transparency data and the rest are left out.
 */
export const KEPT_FORMATS = ["guide", "answer", "detailed_guide", "guidance", "step_by_step_nav"];

/** How many results one search request asks for. */
export const PAGE_SIZE = 1000;

/** One search result. The four fields are the ones asked for in the `fields` parameter. */
export type ListedPage = {
  /** The page path, for example "/graduate-visa". */
  link: string;
  title: string;
  format: string;
  public_timestamp: string;
};

export type FormatCount = { format: string; documents: number; kept: boolean };

// The parts of the Search API responses that this file reads.
type SearchResponse = { results: ListedPage[]; total: number };
type FacetResponse = {
  total: number;
  facets: { format: { options: { value: { slug: string }; documents: number }[] } };
};

export function searchUrl(format: string, start: number, count = PAGE_SIZE): string {
  return (
    `${SEARCH_API}?filter_organisations=${ORGANISATION}&filter_format=${format}` +
    `&count=${count}&start=${start}&fields=link,title,format,public_timestamp`
  );
}

export function facetsUrl(): string {
  // facet_format is the number of formats to return. The organisation has about 41,
  // and a lower number silently cuts the list short.
  return `${SEARCH_API}?filter_organisations=${ORGANISATION}&count=0&facet_format=100`;
}

/** Lists every page of one format. Asks again with a higher `start` until it has them all. */
export async function listFormat(
  format: string,
  getJson: GetJson,
  pageSize = PAGE_SIZE,
): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];
  let total = 1; // Unknown until the first response. 1 gets the loop started.

  for (let start = 0; start < total; start += pageSize) {
    const result = await getJson(
      searchUrl(format, start, pageSize),
      `search/${format}-${start}.json`,
    );
    if (!result.ok) {
      // Without the list there is nothing to fetch, so this is the one error that stops the run.
      throw new Error(`Search API failed for format "${format}". ${result.reason}`);
    }
    const body = result.data as SearchResponse;
    total = body.total;
    for (const r of body.results) {
      // Copy the four fields only. The API adds others, such as its search score.
      pages.push({
        link: r.link,
        title: r.title,
        format: r.format,
        public_timestamp: r.public_timestamp,
      });
    }
    if (body.results.length === 0) {
      break; // Guards against looping forever if `total` is ever wrong.
    }
  }
  return pages;
}

/** Lists the pages of every kept format, one format after the other. */
export async function listPages(getJson: GetJson, pageSize = PAGE_SIZE): Promise<ListedPage[]> {
  const pages: ListedPage[] = [];
  for (const format of KEPT_FORMATS) {
    pages.push(...(await listFormat(format, getJson, pageSize)));
  }
  return pages;
}

/** Counts the organisation's documents by format, so the CLI can show what is kept and skipped. */
export async function countFormats(
  getJson: GetJson,
): Promise<{ total: number; formats: FormatCount[]; fetched_at: string }> {
  const result = await getJson(facetsUrl(), "search/facets.json");
  if (!result.ok) {
    throw new Error(`Search API failed for the format counts. ${result.reason}`);
  }
  const body = result.data as FacetResponse;
  const formats = body.facets.format.options.map((option) => ({
    format: option.value.slug,
    documents: option.documents,
    kept: KEPT_FORMATS.includes(option.value.slug),
  }));
  return { total: body.total, formats, fetched_at: result.fetched_at };
}
