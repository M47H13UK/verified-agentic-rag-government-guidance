import type { Db } from "mongodb";
import { passagesCollection } from "../db";

export const DEFAULT_K = 8;
const MAX_K = 20;
const SNIPPET_WORDS = 80;

/** One search result. A snippet, not the full text, so eight results stay small. */
export type SearchHit = {
  passage_id: string;
  title: string;
  heading_path: string;
  url: string;
  updated: string;
  snippet: string;
};

/**
 * Keyword search over the passages, best match first.
 * MongoDB's text index does the matching. It stems words, drops stop words such as "how",
 * and scores title and heading matches higher than body matches (the weights are set in the index).
 */
export async function searchGuidance(db: Db, query: string, k = DEFAULT_K): Promise<SearchHit[]> {
  const cleaned = query.trim();
  if (cleaned === "") return [];
  const limit = Math.min(Math.max(1, Math.floor(k)), MAX_K);

  const passages = await passagesCollection(db)
    .find({ $text: { $search: cleaned } })
    .project<{
      _id: string;
      title: string;
      heading_path: string;
      url: string;
      updated: string;
      text: string;
    }>({
      title: 1,
      heading_path: 1,
      url: 1,
      updated: 1,
      text: 1,
      score: { $meta: "textScore" },
    })
    // The _id tie-break keeps the order stable when two passages score the same.
    .sort({ score: { $meta: "textScore" }, _id: 1 })
    .limit(limit)
    .toArray();

  return passages.map((p) => ({
    passage_id: p._id,
    title: p.title,
    heading_path: p.heading_path,
    url: p.url,
    updated: p.updated,
    snippet: makeSnippet(p.text, cleaned, p.title),
  }));
}

/**
 * Returns the 80 word window of the passage that contains the most query words.
 * The agent reads the snippet to decide which passage to open in full, so it should show the part
 * of the passage that made it match.
 */
export function makeSnippet(
  text: string,
  query: string,
  title = "",
  maxWords = SNIPPET_WORDS,
): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");

  // Words from the page title appear all over the page, so they say nothing about where to look.
  // Short words such as "a" and "to" are skipped for the same reason.
  const titleWords = new Set(lowerCaseWords(title));
  const terms = [...new Set(lowerCaseWords(query))]
    .filter((term) => term.length > 3 && !titleWords.has(term))
    // The first five letters act as a rough stem, so "employment" also finds "employed".
    .map((term) => term.slice(0, 5));

  // Slide a window over the text ten words at a time and keep the one with the most distinct terms.
  let bestStart = 0;
  let bestScore = -1;
  for (let start = 0; start + maxWords <= words.length; start += 10) {
    const window = words
      .slice(start, start + maxWords)
      .join(" ")
      .toLowerCase();
    const score = terms.filter((term) => window.includes(term)).length;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  const end = bestStart + maxWords;
  return (
    (bestStart > 0 ? "… " : "") +
    words.slice(bestStart, end).join(" ") +
    (end < words.length ? " …" : "")
  );
}

function lowerCaseWords(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter(Boolean);
}
