import type { Db } from "mongodb";
import { passagesCollection } from "../db";
import type { Passage } from "../types";

/** The full passage, plus the IDs of the passages before and after it in the same part. */
export type PassageWithNeighbours = {
  passage_id: string;
  title: string;
  heading_path: string;
  url: string;
  updated: string;
  text: string;
  previous_passage_id: string | null;
  next_passage_id: string | null;
};

/**
 * Returns one passage in full, or null when the ID does not exist.
 * Search finds candidates. This gives the exact words to quote.
 */
export async function readPassage(
  db: Db,
  passageId: string,
): Promise<PassageWithNeighbours | null> {
  const passages = passagesCollection(db);
  const passage = await passages.findOne({ _id: passageId.trim() });
  if (!passage) return null;

  // Neighbours are the passages numbered one lower and one higher in the same part of the same page.
  // A long section is split over several passages, so the answer sometimes continues in the next one.
  const [previous, next] = await Promise.all([
    passages.findOne(neighbourFilter(passage, passage.n - 1), { projection: { _id: 1 } }),
    passages.findOne(neighbourFilter(passage, passage.n + 1), { projection: { _id: 1 } }),
  ]);

  return {
    passage_id: passage._id,
    title: passage.title,
    heading_path: passage.heading_path,
    url: passage.url,
    updated: passage.updated,
    text: passage.text,
    previous_passage_id: previous?._id ?? null,
    next_passage_id: next?._id ?? null,
  };
}

function neighbourFilter(passage: Passage, n: number) {
  return { base_path: passage.base_path, part_slug: passage.part_slug, n };
}

/** Looks up several passages at once. Missing IDs are left out of the map. */
export async function getPassagesById(db: Db, ids: string[]): Promise<Map<string, Passage>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const found = await passagesCollection(db)
    .find({ _id: { $in: unique } })
    .toArray();
  return new Map(found.map((passage) => [passage._id, passage]));
}
