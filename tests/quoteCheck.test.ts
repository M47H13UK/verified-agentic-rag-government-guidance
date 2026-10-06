import { describe, expect, it } from "vitest";
import { MAX_QUOTE_WORDS } from "../src/agent/schema";
import type { Claim, Passage, StructuredAnswer } from "../src/types";
import { checkCitation, checkClaim, normaliseForQuote, quoteCheck } from "../src/verify/quoteCheck";
import { samplePassages, sampleQuotes } from "./helpers/fixtures";

const passages = new Map<string, Passage>(samplePassages().map((p) => [p._id, p]));

const STAY = "/graduate-visa#overview#2";
const COSTS = "/graduate-visa#how-much-it-costs#1";

/** A real quote from the "how long you can stay" passage. */
const realQuote = "If you have a PhD or other doctoral qualification, it will last for 3 years.";

describe("quotes that join list items", () => {
  const id = "/graduate-visa#overview#2";

  it("passes when the model added a comma and a full stop where the line breaks were", () => {
    const quote =
      "2 years if you apply on or before 31 December 2026, 18 months if you apply on or after 1 January 2027. If you have a PhD";
    expect(checkCitation({ passage_id: id, quote }, passages)).toEqual({ ok: true });
  });

  it("still fails when a number in the quote is changed", () => {
    const quote = "3 years if you apply on or before 31 December 2026";
    expect(checkCitation({ passage_id: id, quote }, passages)).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
  });
});

describe("normaliseForQuote", () => {
  it("collapses line breaks and repeated spaces to one space", () => {
    expect(normaliseForQuote("  A Graduate visa lasts\n2 years \t if you apply  ")).toBe(
      "A Graduate visa lasts 2 years if you apply",
    );
  });

  it("drops punctuation at the end of a word and keeps it inside a number", () => {
    expect(normaliseForQuote("lasts for:\n2 years, or 18 months. It costs £1,035.")).toBe(
      "lasts for 2 years or 18 months It costs £1,035",
    );
    expect(normaliseForQuote("1.5 times the rate")).toBe("1.5 times the rate");
  });

  it("maps curly quotes, long dashes and non-breaking spaces to plain ones", () => {
    expect(normaliseForQuote("you’ll ‘see’ “this”")).toBe("you'll 'see' \"this\"");
    expect(normaliseForQuote("2020–2022 — 8 weeks")).toBe("2020-2022 - 8 weeks");
  });

  it("keeps upper and lower case", () => {
    expect(normaliseForQuote("Student visa")).not.toBe(normaliseForQuote("student visa"));
  });
});

describe("checkCitation", () => {
  it("passes the 5 real quotes against the sample passages", () => {
    for (const q of sampleQuotes()) {
      expect(checkCitation({ passage_id: q.passage_id, quote: q.quote }, passages)).toEqual({
        ok: true,
      });
    }
  });

  it("only matches a quote that spans list items after whitespace is collapsed", () => {
    const q = sampleQuotes()[0]!;
    // The passage has a line break after "lasts for:". The quote has a space there.
    expect(passages.get(q.passage_id)!.text.includes(q.quote)).toBe(false);
    expect(checkCitation({ passage_id: q.passage_id, quote: q.quote }, passages).ok).toBe(true);
  });

  it("fails a quote with one word changed", () => {
    const changed = realQuote.replace("3 years", "4 years");
    expect(checkCitation({ passage_id: STAY, quote: changed }, passages)).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
  });

  it("fails a real quote that cites the wrong passage", () => {
    expect(checkCitation({ passage_id: COSTS, quote: realQuote }, passages)).toEqual({
      ok: false,
      reason: "quote_not_found",
    });
  });

  it("fails an unknown passage ID", () => {
    expect(
      checkCitation({ passage_id: "/graduate-visa#overview#99", quote: realQuote }, passages),
    ).toEqual({ ok: false, reason: "passage_not_found" });
  });

  it("fails a quote of fewer than 3 words, even when the words are in the passage", () => {
    expect(checkCitation({ passage_id: STAY, quote: "Graduate visa" }, passages)).toEqual({
      ok: false,
      reason: "quote_too_short",
    });
  });

  it("matches a straight apostrophe in the quote to a curly one in the passage", () => {
    expect(passages.get(COSTS)!.text).toContain("you’ll need to");
    const retyped =
      "When you apply for a Graduate visa, you'll need to: pay the £937 application fee";
    expect(checkCitation({ passage_id: COSTS, quote: retyped }, passages)).toEqual({ ok: true });
  });

  it("does not fail a quote for being longer than MAX_QUOTE_WORDS", () => {
    const long = normaliseForQuote(passages.get(STAY)!.text).split(" ").slice(0, 60).join(" ");
    expect(long.split(" ").length).toBeGreaterThan(MAX_QUOTE_WORDS);
    expect(checkCitation({ passage_id: STAY, quote: long }, passages)).toEqual({ ok: true });
  });
});

describe("checkClaim", () => {
  it("fails a claim with no citations", () => {
    const claim: Claim = { text: "A Graduate visa lasts for 3 years.", citations: [] };
    expect(checkClaim(claim, passages)).toEqual({ ok: false, reason: "no_citations" });
  });

  it("fails a claim with one good and one bad citation", () => {
    const claim: Claim = {
      text: "With a PhD the visa lasts 3 years and costs £937.",
      citations: [
        { passage_id: STAY, quote: realQuote },
        { passage_id: COSTS, quote: "pay the £1,937 application fee" },
      ],
    };
    expect(checkClaim(claim, passages)).toEqual({
      ok: false,
      reason: "quote_not_found",
      passage_id: COSTS,
    });
  });
});

describe("quoteCheck", () => {
  it("returns one verdict per claim, in order, and names the passage that failed", () => {
    const answer: StructuredAnswer = {
      status: "answered",
      summary: "A Graduate visa lasts 3 years if you have a PhD.",
      claims: [
        {
          text: "With a PhD the visa lasts 3 years.",
          citations: [{ passage_id: STAY, quote: realQuote }],
        },
        {
          text: "The visa lasts 5 years for everyone else.",
          citations: [{ passage_id: STAY, quote: "it will last for 5 years" }],
        },
      ],
    };

    expect(quoteCheck(answer, passages)).toEqual([
      {
        claim_index: 0,
        verdict: "supported",
        reason: "Every quote appears in its cited passage.",
        checked_by: "quote_check",
      },
      {
        claim_index: 1,
        verdict: "not_supported",
        reason: "Quote not found in passage /graduate-visa#overview#2.",
        checked_by: "quote_check",
      },
    ]);
  });
});
