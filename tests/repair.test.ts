import { describe, expect, it } from "vitest";
import type { ClaimVerdict, StructuredAnswer } from "../src/types";
import { buildRepairFeedback } from "../src/verify/repair";

const answer: StructuredAnswer = {
  status: "answered",
  summary: "You can work in any job for 3 years.",
  claims: [
    {
      text: "A Graduate visa lasts for 3 years if you have a PhD.",
      citations: [
        {
          passage_id: "/graduate-visa#overview#2",
          quote: "If you have a PhD or other doctoral qualification, it will last for 3 years.",
        },
      ],
    },
    {
      text: "With a Graduate visa you can work in any job.",
      citations: [
        {
          passage_id: "/graduate-visa#overview#3",
          quote: "With a Graduate visa you can: work in most jobs",
        },
      ],
    },
  ],
};

const failed: ClaimVerdict[] = [
  {
    claim_index: 1,
    verdict: "not_supported",
    reason: "The passage says most jobs, not any job.",
    fix: "Say that you can work in most jobs.",
    checked_by: "verifier",
  },
];

describe("buildRepairFeedback", () => {
  it("names the failed claim, the reason and the suggested fix", () => {
    const feedback = buildRepairFeedback(answer, failed);

    expect(feedback).toContain('- Claim: "With a Graduate visa you can work in any job."');
    expect(feedback).toContain("Problem: The passage says most jobs, not any job.");
    expect(feedback).toContain("Suggested fix: Say that you can work in most jobs.");
  });

  it("lists the claims that passed with their quotes and asks for the full answer again", () => {
    const feedback = buildRepairFeedback(answer, failed);
    const passedSection = feedback.slice(feedback.indexOf("Claims that passed"));

    expect(passedSection).toContain("A Graduate visa lasts for 3 years if you have a PhD.");
    expect(passedSection).toContain(
      'Quote from /graduate-visa#overview#2: "If you have a PhD or other doctoral qualification',
    );
    expect(passedSection).not.toContain("work in any job");
    expect(feedback).toContain("Write the full answer again. Use the same tools");
  });

  it("leaves out the suggested fix and the passed section when there is nothing to put in them", () => {
    const onlyClaim: StructuredAnswer = { ...answer, claims: [answer.claims[1]!] };
    const verdict: ClaimVerdict = {
      claim_index: 0,
      verdict: "not_supported",
      reason: "Quote not found in passage /graduate-visa#overview#3.",
      checked_by: "quote_check",
    };

    const feedback = buildRepairFeedback(onlyClaim, [verdict]);

    expect(feedback).toContain("Problem: Quote not found in passage /graduate-visa#overview#3.");
    expect(feedback).not.toContain("Suggested fix");
    expect(feedback).not.toContain("Claims that passed");
  });
});
