import type { Citation, Claim, ClaimVerdict, Passage, StructuredAnswer } from "../types";

// The quote check. Plain code, no model and no database.
// It proves one thing only, that the quoted words really are in the cited passage.
// Whether those words support the claim is the verifier's job.

/** A quote of one or two words proves nothing. Words such as "the UK" are in almost every passage. */
export const MIN_QUOTE_WORDS = 3;

export type CitationFailure = "passage_not_found" | "quote_too_short" | "quote_not_found";
export type ClaimFailure = CitationFailure | "no_citations";

export type CitationCheck = { ok: true } | { ok: false; reason: CitationFailure };

/** `passage_id` names the citation that failed. It is left out when the claim has no citations. */
export type ClaimCheck = { ok: true } | { ok: false; reason: ClaimFailure; passage_id?: string };

/**
 * Makes a quote and a passage comparable, by removing differences that do not change the words.
 * The words themselves, their order and every digit must still match.
 * Case is kept. Copying a quote never changes its case, so a difference in case means the words
 * were not copied.
 */
export function normaliseForQuote(text: string): string {
  return (
    text
      // GOV.UK writes "you’ll" with a curly apostrophe. Models often retype it as a straight one.
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      // Models also retype an en dash or an em dash as a hyphen.
      .replace(/[–—]/g, "-")
      // Punctuation at the end of a word is dropped. A passage keeps list items on separate lines
      // with no punctuation between them, and a model that quotes across two items adds a comma
      // or a full stop where the line break was. Punctuation inside a number is kept, because
      // "£1,035" and "1.5" must still match exactly.
      .replace(/[.,;:!?]+(?=\s|$)/g, "")
      // List items in a passage are separate lines. A quote that runs across several items
      // comes back from the model with spaces between them, so every run of whitespace becomes
      // one space. `\s` also matches the non-breaking space, which looks like a space on screen.
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Checks that one quote appears word for word in the passage it cites. */
export function checkCitation(citation: Citation, passages: Map<string, Passage>): CitationCheck {
  const passage = passages.get(citation.passage_id);
  if (!passage) {
    return { ok: false, reason: "passage_not_found" };
  }

  const quote = normaliseForQuote(citation.quote);
  const wordCount = quote === "" ? 0 : quote.split(" ").length;
  if (wordCount < MIN_QUOTE_WORDS) {
    return { ok: false, reason: "quote_too_short" };
  }

  if (!normaliseForQuote(passage.text).includes(quote)) {
    return { ok: false, reason: "quote_not_found" };
  }
  return { ok: true };
}

/**
 * A claim passes only when it has at least one citation and every citation passes.
 * One bad quote fails the whole claim, because the claim was written on top of it.
 */
export function checkClaim(claim: Claim, passages: Map<string, Passage>): ClaimCheck {
  if (claim.citations.length === 0) {
    return { ok: false, reason: "no_citations" };
  }
  for (const citation of claim.citations) {
    const result = checkCitation(citation, passages);
    if (!result.ok) {
      return { ok: false, reason: result.reason, passage_id: citation.passage_id };
    }
  }
  return { ok: true };
}

/** The sentence stored with a failed claim. The repair attempt shows it to the model. */
function failureSentence(reason: ClaimFailure, passageId?: string): string {
  switch (reason) {
    case "no_citations":
      return "The claim has no citations.";
    case "passage_not_found":
      return `Passage ${passageId} was not found.`;
    case "quote_too_short":
      return `Quote from passage ${passageId} is shorter than ${MIN_QUOTE_WORDS} words.`;
    case "quote_not_found":
      return `Quote not found in passage ${passageId}.`;
  }
}

/**
 * Runs the quote check on every claim of an answer and returns one verdict per claim, in order.
 * Here "supported" only means the quotes are real. It does not mean the quotes support the claim.
 */
export function quoteCheck(
  answer: StructuredAnswer,
  passages: Map<string, Passage>,
): ClaimVerdict[] {
  return answer.claims.map((claim, claim_index) => {
    const result = checkClaim(claim, passages);
    if (result.ok) {
      return {
        claim_index,
        verdict: "supported",
        reason: "Every quote appears in its cited passage.",
        checked_by: "quote_check",
      };
    }
    return {
      claim_index,
      verdict: "not_supported",
      reason: failureSentence(result.reason, result.passage_id),
      checked_by: "quote_check",
    };
  });
}
