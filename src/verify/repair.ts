import type { ClaimVerdict, StructuredAnswer } from "../types";

/**
 * Builds the text passed as `RunOptions.feedback` on the one repair attempt.
 * The backend only receives the question and this text. It does not receive the draft, so the
 * text repeats the claims that passed, with their quotes, next to the claims that failed.
 */
export function buildRepairFeedback(
  answer: StructuredAnswer,
  failedVerdicts: ClaimVerdict[],
): string {
  const failedIndexes = new Set(failedVerdicts.map((v) => v.claim_index));

  const failed = failedVerdicts.map((v) => {
    const lines = [`- Claim: "${answer.claims[v.claim_index]?.text}"`, `  Problem: ${v.reason}`];
    if (v.fix) {
      lines.push(`  Suggested fix: ${v.fix}`);
    }
    return lines.join("\n");
  });

  const passed = answer.claims
    .filter((_, index) => !failedIndexes.has(index))
    .map((claim) =>
      [
        `- Claim: "${claim.text}"`,
        ...claim.citations.map((c) => `  Quote from ${c.passage_id}: "${c.quote}"`),
      ].join("\n"),
    );

  const sections = [
    "Your draft answer to this question was checked against the guidance. Some claims could not be confirmed.",
    `Claims that failed:\n${failed.join("\n")}`,
  ];
  if (passed.length > 0) {
    const heading = "Claims that passed. Keep them, with the same passage IDs and quotes:";
    sections.push(`${heading}\n${passed.join("\n")}`);
  }
  sections.push(
    "Write the full answer again. Use the same tools to search and read the guidance. " +
      "For each failed claim, either correct it so that a passage states it and quote that passage word for word, or leave it out. " +
      "Do not add a claim that you cannot quote.",
  );
  return sections.join("\n\n");
}
