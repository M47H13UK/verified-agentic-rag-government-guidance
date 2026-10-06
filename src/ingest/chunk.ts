import type { Passage } from "../types";
import { BODY_SLUG, type Block, type ParsedPage } from "./parse";

/** A passage shorter than this is merged with what follows it. */
export const MIN_WORDS = 150;
/** A passage is never merged past this size, and a longer section is split. */
export const MAX_WORDS = 400;

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** One block, with the two things the chunker needs to know about it. */
type Line = {
  block: Block;
  words: number;
  /** The headings this line sits under, outermost first. A heading is the last entry of its own path. */
  path: string[];
};

function sumWords(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.words, 0);
}

/** Works out the heading path of every block by walking the part from top to bottom. */
function toLines(blocks: Block[]): Line[] {
  const open: { level: number; text: string }[] = [];
  return blocks.map((block) => {
    if (block.type === "heading") {
      // A new heading closes every open heading of the same level or deeper.
      while (open.length > 0 && open[open.length - 1]!.level >= block.level) {
        open.pop();
      }
      open.push({ level: block.level, text: block.text });
    }
    return { block, words: countWords(block.text), path: open.map((heading) => heading.text) };
  });
}

/** Cuts the lines into groups. A new group starts at every heading of `level` or above. */
function splitAtHeadings(lines: Line[], level: number): Line[][] {
  const groups: Line[][] = [];
  for (const line of lines) {
    const startsGroup = line.block.type === "heading" && line.block.level <= level;
    if (startsGroup || groups.length === 0) {
      groups.push([]);
    }
    groups[groups.length - 1]!.push(line);
  }
  return groups;
}

/**
 * Cuts a long run of lines into pieces of at most MAX_WORDS.
 * Used when a section is too long and has no more headings to split at.
 */
function splitAtParagraphs(lines: Line[]): Line[][] {
  // Aim for pieces of equal size. Filling each one to the limit would leave a scrap at the end.
  const total = sumWords(lines);
  const target = total / Math.ceil(total / MAX_WORDS);

  const pieces: Line[][] = [];
  let piece: Line[] = [];
  let words = 0;
  const closePiece = () => {
    pieces.push(piece);
    piece = [];
    words = 0;
  };

  lines.forEach((line, i) => {
    if (piece.length > 0 && words + line.words > MAX_WORDS) {
      closePiece(); // The hard limit. This can cut a long list or table between two rows.
    }
    piece.push(line);
    words += line.words;
    // Stop where a new paragraph starts, at the start nearest to the target. Stopping before
    // a list item or a table row would separate a list from the sentence that introduces it.
    const next = lines[i + 1];
    if (next?.block.type === "paragraph" && words + next.words / 2 >= target) {
      closePiece();
    }
  });
  if (piece.length > 0) {
    closePiece();
  }
  return pieces;
}

/**
 * Cuts a part into sections at its h2 headings. An h2 section keeps its h3 sub-sections.
 * A section over MAX_WORDS is cut again at the next heading level down, and at paragraphs
 * once it has no headings left to cut at.
 */
function toSections(lines: Line[], level = 2): Line[][] {
  return splitAtHeadings(lines, level)
    .flatMap((section) => {
      if (sumWords(section) <= MAX_WORDS) {
        return [section];
      }
      return level < 6 ? toSections(section, level + 1) : splitAtParagraphs(section);
    })
    .filter(hasText);
}

/**
 * False for a section that is only headings. That happens when a long section is cut at its
 * sub-headings and has no text of its own. It is dropped, and nothing is lost, because its
 * heading is in the heading path of every section under it.
 */
function hasText(section: Line[]): boolean {
  return section.some((line) => line.block.type !== "heading");
}

function isShort(section: Line[]): boolean {
  return sumWords(section) < MIN_WORDS;
}

function fitTogether(a: Line[], b: Line[]): boolean {
  return sumWords(a) + sumWords(b) <= MAX_WORDS;
}

/** Merges short sections with their neighbours, so that few passages are under MIN_WORDS. */
function mergeShortSections(sections: Line[][]): Line[][] {
  // Forward. A short passage takes in the section after it, until it is long enough.
  const merged: Line[][] = [];
  for (const section of sections) {
    const current = merged[merged.length - 1];
    if (current && isShort(current) && fitTogether(current, section)) {
      current.push(...section);
    } else {
      merged.push([...section]);
    }
  }

  // Backward. A passage that is still short found nothing after it that fitted.
  // It joins the one before, when that fits.
  const result: Line[][] = [];
  for (const section of merged) {
    const before = result[result.length - 1];
    if (before && isShort(section) && fitTogether(before, section)) {
      before.push(...section);
    } else {
      result.push(section);
    }
  }
  return result;
}

/** Turns one parsed page into its passages. Each part of a guide is chunked on its own. */
export function chunkPage(page: ParsedPage): Passage[] {
  const passages: Passage[] = [];
  const pageUrl = `https://www.gov.uk${page.base_path}`;

  page.parts.forEach((part, partIndex) => {
    // GOV.UK serves the first part of a guide at the guide's own address.
    const url = partIndex === 0 || part.slug === BODY_SLUG ? pageUrl : `${pageUrl}/${part.slug}`;
    let n = 0;

    for (const lines of mergeShortSections(toSections(toLines(part.blocks)))) {
      const first = lines[0]!;
      // The heading a passage starts at is in its heading path, so it is not repeated in the text.
      const textLines = first.block.type === "heading" ? lines.slice(1) : lines;
      n += 1;
      const text = textLines.map((line) => line.block.text).join("\n");
      const partTitle = part.title ? [part.title] : [];

      passages.push({
        _id: `${page.base_path}#${part.slug}#${n}`,
        base_path: page.base_path,
        part_slug: part.slug,
        n,
        title: page.title,
        heading_path: [page.title, ...partTitle, ...first.path].join(" > "),
        headings: textLines
          .filter((line) => line.block.type === "heading")
          .map((line) => line.block.text),
        url,
        format: page.format,
        updated: page.updated,
        word_count: countWords(text),
        text,
      });
    }
  });
  return passages;
}
