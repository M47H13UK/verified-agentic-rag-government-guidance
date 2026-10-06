import { describe, expect, it } from "vitest";
import { htmlToBlocks, parsePage } from "../src/ingest/parse";
import { readSample } from "./helpers/fixtures";

describe("htmlToBlocks", () => {
  it("turns headings, paragraphs, list items and table rows into one block each", () => {
    const html = `
      <p>You must <a href="/graduate-visa/apply">apply online</a> for a visa.</p>
      <h2 id="costs">How much it costs</h2>
      <ul>
        <li>pay the £937 fee</li>
        <li>pay the <strong>healthcare</strong> surcharge</li>
      </ul>
      <h3>If your licence is suspended</h3>
      <table>
        <thead><tr><th>Your circumstances</th><th>What will happen</th></tr></thead>
        <tbody><tr><td>Already working</td><td>You can keep working</td></tr></tbody>
      </table>`;

    expect(htmlToBlocks(html)).toEqual([
      { type: "paragraph", text: "You must apply online for a visa." },
      { type: "heading", level: 2, text: "How much it costs" },
      { type: "list_item", text: "pay the £937 fee" },
      { type: "list_item", text: "pay the healthcare surcharge" },
      { type: "heading", level: 3, text: "If your licence is suspended" },
      { type: "table_row", text: "Your circumstances | What will happen" },
      { type: "table_row", text: "Already working | You can keep working" },
    ]);
  });

  it("starts a new line at a line break, but keeps a table row on one line", () => {
    const address = "<p>UK Visas and Immigration<br>Lunar House<br>Croydon</p>";
    expect(htmlToBlocks(address).map((block) => block.text)).toEqual([
      "UK Visas and Immigration",
      "Lunar House",
      "Croydon",
    ]);

    const table =
      "<table><tr><td>Chairpersons<br>Chief executives</td><td>Eligible</td></tr></table>";
    expect(htmlToBlocks(table)).toEqual([
      { type: "table_row", text: "Chairpersons Chief executives | Eligible" },
    ]);
  });

  it("keeps the text of a list item together with its nested list as separate items", () => {
    const html = "<ul><li><p>your partner</p><ul><li>if they apply with you</li></ul></li></ul>";
    expect(htmlToBlocks(html)).toEqual([
      { type: "list_item", text: "your partner" },
      { type: "list_item", text: "if they apply with you" },
    ]);
  });

  it("drops icons, footnotes and attachment boxes", () => {
    const html = `
      <p><a class="govuk-button" href="https://example.org"><span> Start now </span><svg><path d="M0 0h13"></path></svg></a></p>
      <p>The clinic is in Kabul<sup id="fnref:1"><a href="#fn:1" class="footnote">[footnote 1]</a></sup>.</p>
      <section class="gem-c-attachment"><h2 class="gem-c-attachment__title">Form A</h2><p>PDF, 2 MB</p></section>
      <div class="footnotes"><ol><li id="fn:1"><p>A source <a class="reversefootnote">↩</a></p></li></ol></div>`;

    expect(htmlToBlocks(html)).toEqual([
      { type: "paragraph", text: "Start now" },
      { type: "paragraph", text: "The clinic is in Kabul." },
    ]);
  });
});

describe("parsePage", () => {
  it("reads the 14 parts of the Skilled Worker guide", () => {
    const result = parsePage(readSample("content-skilled-worker-visa.json"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.base_path).toBe("/skilled-worker-visa");
    expect(result.page.format).toBe("guide");
    // `updated` is public_updated_at. The document's updated_at is a later, technical date.
    expect(result.page.updated).toBe("2024-10-31T17:00:39+00:00");
    expect(result.page.parts).toHaveLength(14);
    // A slug is not always the title in lower case.
    const lastPart = result.page.parts[13]!;
    expect(lastPart.slug).toBe("second-job");
    expect(lastPart.title).toBe("Taking on additional work");
    expect(result.page.parts.every((part) => part.blocks.length > 0)).toBe(true);
  });

  it("gives a page without parts one part called body", () => {
    const result = parsePage(readSample("content-employee-lose-sponsor-licence.json"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.parts).toHaveLength(1);
    expect(result.page.parts[0]!.slug).toBe("body");
    expect(result.page.parts[0]!.title).toBeNull();
    expect(result.page.parts[0]!.blocks).toContainEqual({
      type: "table_row",
      text: "Applied for a visa | It will be refused",
    });
  });

  it("turns the steps of a step by step page into headings, paragraphs and list items", () => {
    const result = parsePage({
      base_path: "/study-uk-student-visa",
      title: "Study in the UK on a Student visa ",
      document_type: "step_by_step_nav",
      public_updated_at: "2026-03-23T17:17:10+00:00",
      details: {
        step_by_step_nav: {
          introduction: "<p>Check what you need to do.</p>",
          steps: [
            {
              title: "Apply from outside the UK",
              contents: [
                {
                  type: "list",
                  contents: [{ text: "Apply from outside the UK", context: "£558" }],
                },
                { type: "paragraph", text: "You'll usually get a decision within 3 weeks." },
              ],
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The real title ends with a space.
    expect(result.page.title).toBe("Study in the UK on a Student visa");
    expect(result.page.parts[0]!.blocks).toEqual([
      { type: "paragraph", text: "Check what you need to do." },
      { type: "heading", level: 2, text: "Apply from outside the UK" },
      { type: "list_item", text: "Apply from outside the UK £558" },
      { type: "paragraph", text: "You'll usually get a decision within 3 weeks." },
    ]);
  });

  it("skips what is not a page of English text, and says why", () => {
    const page = { base_path: "/x", title: "X", details: { body: "<p>Some text.</p>" } };

    expect(parsePage({ ...page, document_type: "redirect" })).toEqual({
      ok: false,
      reason: "redirect",
    });
    expect(parsePage({ ...page, document_type: "html_publication", locale: "cy" })).toEqual({
      ok: false,
      reason: "not in English",
    });
    expect(parsePage({ ...page, document_type: "guidance", details: { body: "" } })).toEqual({
      ok: false,
      reason: "no text",
    });
  });
});
