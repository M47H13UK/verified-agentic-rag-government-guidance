import { load } from "cheerio";
import type { AnyNode } from "domhandler";

/** One line of a page. A heading keeps its level. Everything else is one line of plain text. */
export type Block =
  { type: "heading"; level: number; text: string } | { type: TextBlockType; text: string };

export type TextBlockType = "paragraph" | "list_item" | "table_row";

/** One part of a guide, or the whole body of a page that has no parts. */
export type ParsedPart = {
  slug: string;
  /** Null for pages without parts. */
  title: string | null;
  blocks: Block[];
};

export type ParsedPage = {
  base_path: string;
  title: string;
  format: string;
  updated: string;
  first_published: string | null;
  parts: ParsedPart[];
};

export type ParseResult = { ok: true; page: ParsedPage } | { ok: false; reason: string };

/** The part slug used for pages without parts. It is part of every passage ID on such a page. */
export const BODY_SLUG = "body";

/**
 * Markup that is not guidance text and is removed before reading.
 * Icons and images have no text. Footnote markers and the footnote list are references to sources.
 * An attachment box is a download link with a file size, and its title is marked up as a heading.
 */
const NOT_TEXT = "script, style, svg, img, sup:has(a.footnote), .footnotes, .gem-c-attachment";

/** Tags that start a new line. Every other tag is inline, so its text joins the current line. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "section",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "td",
  "th",
  "figure",
  "figcaption",
  "hr",
]);

/** Collapses every run of whitespace, line breaks included, into one space. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * All the text under a node, for a heading or a table cell, which must stay on one line.
 * Block tags and line breaks become spaces, so the words on each side do not run together.
 */
function textOnOneLine(node: AnyNode): string {
  if (node.type === "text") {
    return node.data;
  }
  if (node.type !== "tag") {
    return "";
  }
  const inner = node.children.map(textOnOneLine).join("");
  return BLOCK_TAGS.has(node.name) || node.name === "br" ? ` ${inner} ` : inner;
}

/**
 * Turns GOV.UK body HTML into an ordered list of blocks.
 * Link text is kept and all markup is dropped.
 */
export function htmlToBlocks(html: string): Block[] {
  const $ = load(html);
  $(NOT_TEXT).remove();

  const blocks: Block[] = [];
  // The text of the line being built. Inline tags add to it. A block tag ends it.
  let line = "";

  function endLine(type: TextBlockType): void {
    const text = cleanText(line);
    line = "";
    if (text !== "") {
      blocks.push({ type, text });
    }
  }

  /** Walks the tree in page order. `type` is what a finished line of text is saved as. */
  function visit(node: AnyNode, type: TextBlockType): void {
    if (node.type === "text") {
      line += node.data;
      return;
    }
    if (node.type !== "tag") {
      return; // Comments and the like.
    }

    const headingLevel = /^h([1-6])$/.exec(node.name)?.[1];
    if (headingLevel) {
      endLine(type);
      const text = cleanText(textOnOneLine(node));
      if (text !== "") {
        blocks.push({ type: "heading", level: Number(headingLevel), text });
      }
    } else if (node.name === "tr") {
      endLine(type);
      const cells = node.children.map((cell) => cleanText(textOnOneLine(cell)));
      const text = cells.filter((cell) => cell !== "").join(" | ");
      if (text !== "") {
        blocks.push({ type: "table_row", text });
      }
    } else if (node.name === "br") {
      // A line break inside a paragraph, for example between the lines of an address.
      endLine(type);
    } else if (BLOCK_TAGS.has(node.name)) {
      endLine(type);
      // Text anywhere inside a list item is a list item, also when it is wrapped in a <p>.
      const innerType = node.name === "li" ? "list_item" : type;
      for (const child of node.children) {
        visit(child, innerType);
      }
      endLine(innerType);
    } else {
      // An inline tag such as <a>, <strong> or <abbr>. Keep its text, drop the tag.
      for (const child of node.children) {
        visit(child, type);
      }
    }
  }

  for (const node of $("body").contents().toArray()) {
    visit(node, "paragraph");
  }
  endLine("paragraph");
  return blocks;
}

// The parts of a Content API document that this file reads.
type ContentDoc = {
  base_path?: string;
  title?: string;
  document_type?: string;
  locale?: string;
  public_updated_at?: string;
  first_published_at?: string;
  details?: {
    body?: string | { content_type: string; content: string }[];
    parts?: { slug: string; title: string; body: string }[];
    step_by_step_nav?: StepNav;
  };
};

type StepNav = {
  introduction?: string;
  steps: { title: string; contents: StepContent[] }[];
};

type StepContent =
  | { type: "paragraph"; text: string }
  | { type: "list"; contents: { text: string; context?: string }[] };

/**
 * A step by step page lists its steps as data, not as HTML.
 * Each step becomes an h2 heading, followed by its paragraphs and its links.
 */
function stepNavToBlocks(nav: StepNav): Block[] {
  const blocks = htmlToBlocks(nav.introduction ?? "");
  for (const step of nav.steps) {
    blocks.push({ type: "heading", level: 2, text: cleanText(step.title) });
    for (const content of step.contents) {
      if (content.type === "paragraph") {
        blocks.push({ type: "paragraph", text: cleanText(content.text) });
      } else if (content.type === "list") {
        for (const item of content.contents) {
          // `context` is a short note shown after the link, most often a fee such as "£558".
          const text = cleanText(`${item.text} ${item.context ?? ""}`);
          blocks.push({ type: "list_item", text });
        }
      }
    }
  }
  return blocks.filter((block) => block.text !== "");
}

/**
 * Reads one Content API document into parts and blocks.
 * Returns a reason instead when the document is not a page of English guidance text.
 */
export function parsePage(doc: unknown): ParseResult {
  const { base_path, document_type, details, ...rest } = doc as ContentDoc;

  if (!base_path || !document_type || !details) {
    return { ok: false, reason: "not a content document" };
  }
  if (document_type === "redirect" || document_type === "gone") {
    // The Search API still lists the page, but it has moved or been removed.
    return { ok: false, reason: document_type };
  }
  if (rest.locale && rest.locale !== "en") {
    return { ok: false, reason: "not in English" };
  }

  let parts: ParsedPart[];
  if (details.parts) {
    // A guide. Each part is a page of its own on GOV.UK.
    parts = details.parts.map((part) => ({
      slug: part.slug,
      title: cleanText(part.title),
      blocks: htmlToBlocks(part.body),
    }));
  } else if (details.step_by_step_nav) {
    parts = [{ slug: BODY_SLUG, title: null, blocks: stepNavToBlocks(details.step_by_step_nav) }];
  } else {
    // The body is a string of HTML in every format kept here. GOV.UK can also send it as a list
    // with one entry per content type, so take the HTML entry if that ever happens.
    const body = details.body;
    const html =
      typeof body === "string"
        ? body
        : (body?.find((entry) => entry.content_type === "text/html")?.content ?? "");
    parts = [{ slug: BODY_SLUG, title: null, blocks: htmlToBlocks(html) }];
  }

  if (parts.every((part) => part.blocks.length === 0)) {
    return { ok: false, reason: "no text" };
  }

  return {
    ok: true,
    page: {
      base_path,
      // Some real titles end with a space.
      title: cleanText(rest.title ?? ""),
      format: document_type,
      updated: rest.public_updated_at ?? "",
      first_published: rest.first_published_at ?? null,
      parts,
    },
  };
}
