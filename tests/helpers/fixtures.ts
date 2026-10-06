import { readFileSync } from "node:fs";
import type { Passage } from "../../src/types";

/** Reads a JSON file from `data/sample/`. */
export function readSample<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../../data/sample/${name}`, import.meta.url), "utf8"),
  ) as T;
}

/** The 13 passages of the Graduate visa guide, as fetched on 5 October 2026. */
export function samplePassages(): Passage[] {
  return readSample<Passage[]>("passages.json");
}

export type SampleQuote = {
  question: string;
  quote: string;
  passage_id: string;
};

/** Five quotes known to appear word for word in the sample passages. */
export function sampleQuotes(): SampleQuote[] {
  return readSample<{ quotes: SampleQuote[] }>("quotes.json").quotes;
}
