import { describe, expect, it } from "vitest";
import { appendJsonl, gradesPath, runsPath } from "../../src/eval/files";
import { loadDetailInput, renderDetailMd } from "../../src/eval/detail";
import type { VerificationRecord } from "../../src/types";
import {
  H0,
  H1,
  makeAnswer,
  makeDraft,
  makeGrade,
  makeQuestion,
  makeRecord,
  makeRun,
  tempDir,
  usage,
} from "./builders";

const POINT = "It lasts 2 years if you apply on or before 31 December 2026.";

// q01 asks for an answer. Its one expected point comes from passage #1 of the page.
const q01 = makeQuestion({
  id: "q01",
  expected_points: [POINT],
  evidence: [{ point: POINT, passage_id: "/graduate-visa#overview#1", quote: "2 years" }],
});
const q02 = makeQuestion({
  id: "q02",
  question: "Will my application be approved?",
  category: "personal_judgement",
  expected_behaviour: "decline",
  expected_points: [],
  gold_sources: [],
});
const questions = [q01, q02];

function verification(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    claims_before: 2,
    dropped_by_quote_check: 0,
    dropped_by_verifier: 0,
    repair_ran: false,
    repair: null,
    claims_after_repair: null,
    claims_final: 2,
    first_pass: [],
    second_pass: null,
    unconfirmed: [],
    summary_replaced: false,
    extra_usage: usage(0),
    extra_latency_ms: 0,
    ...overrides,
  };
}

/** Writes one run and its grade for each setup and question, then renders the file. */
function render(): string {
  const dir = tempDir();
  const draft = makeAnswer(["A Graduate visa lasts 2 years.", "It costs nothing."]);
  const kept = makeAnswer(["A Graduate visa lasts 2 years."]);
  const decline = makeAnswer([], { status: "declined" });

  // H0 answered q01 but missed the point. The search returned passage #2, not the evidence passage #1.
  appendJsonl(runsPath(dir, "H0", 1), makeRecord(H0, q01, draft));
  appendJsonl(
    gradesPath(dir, "H0", 1),
    makeGrade({ points: [{ point: POINT, present: false }], correctness: 0 }),
  );
  appendJsonl(runsPath(dir, "H0", 1), makeRecord(H0, q02, decline));
  appendJsonl(
    gradesPath(dir, "H0", 1),
    makeGrade({ question_id: "q02", behaviour: "declined", retrieval_hit: null }),
  );

  // H1 checked the same drafts. On q01 the quote check removed one claim, so the answer changed.
  const checked = makeRun(H1, q01.question, kept, {
    draft: makeDraft(draft, ["/graduate-visa#overview#2"]),
    verification: verification({
      dropped_by_quote_check: 1,
      repair_ran: true,
      claims_final: 1,
      unconfirmed: ["It costs nothing."],
      summary_replaced: true,
      first_pass: [
        { claim_index: 0, verdict: "partially_supported", reason: "r", checked_by: "verifier" },
        { claim_index: 1, verdict: "not_supported", reason: "r", checked_by: "quote_check" },
      ],
    }),
  });
  appendJsonl(runsPath(dir, "H1", 1), makeRecord(H1, q01, kept, { run: checked }));
  appendJsonl(
    gradesPath(dir, "H1", 1),
    makeGrade({ setup_id: "H1", points: [{ point: POINT, present: true }], correctness: 1 }),
  );
  // On q02 the verifier changed nothing, and the judge scored the same text differently.
  const unchanged = makeRun(H1, q02.question, decline, { verification: verification() });
  appendJsonl(runsPath(dir, "H1", 1), makeRecord(H1, q02, decline, { run: unchanged }));
  appendJsonl(
    gradesPath(dir, "H1", 1),
    makeGrade({
      setup_id: "H1",
      question_id: "q02",
      behaviour: "declined",
      retrieval_hit: null,
      correctness: 0,
    }),
  );

  return renderDetailMd(loadDetailInput(dir, questions), questions);
}

describe("renderDetailMd", () => {
  it("counts what the two checks did for a verifier-on setup", () => {
    // Claims 4, failed quote check 1, not supported by the model 0, partial 1, repairs 1,
    // removed after the repair 1, summaries rebuilt 1.
    expect(render()).toContain("| H1 | 4 | 1 | 0 | 1 | 1 | 1 | 1 |");
  });

  it("separates pairs with the same final answer from pairs the verifier changed", () => {
    // q02 is the same text and was scored differently. q01 changed and gained 100 points.
    expect(render()).toContain("| H0 and H1 | 1 | 1 | 1 | 100.0 points |");
  });

  it("says how far the evidence passage of a missing point got", () => {
    // One expected point, missing, and its evidence passage was never returned.
    // Passage #2 of the same page was returned, so the page was found and the passage was not.
    expect(render()).toContain("| H0 | 1 | 1 | 0 | 1 | 1 | 0 | 0 |");
  });

  it("gives correctness by category and behaviour counts", () => {
    const text = render();
    expect(text).toContain("| Setup | single_page (1) |");
    expect(text).toContain("| H0 | 0% |  |  |  |  | 100% |  |");
    expect(text).toContain("| H0 | 1 of 1 | 1 of 1 | 0 of 0 |");
  });

  it("lists a run with no answer and its reason", () => {
    const dir = tempDir();
    const failed = makeRun(H0, q01.question, null, {
      draft: { ...makeDraft(null), error: "error_max_turns: Reached maximum number of turns (10)" },
    });
    appendJsonl(runsPath(dir, "H0", 1), makeRecord(H0, q01, null, { run: failed }));
    appendJsonl(
      gradesPath(dir, "H0", 1),
      makeGrade({ behaviour: "error", behaviour_correct: false, correctness: 0 }),
    );
    const text = renderDetailMd(loadDetailInput(dir, [q01]), [q01]);
    expect(text).toContain("| H0 | 1 | q01 | error_max_turns |");
    // The missing point is counted under runs with no answer, not under retrieval.
    expect(text).toContain("| H0 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |");
  });

  it("adds the second opinions on the judge only when there are some", () => {
    expect(render()).not.toContain("Second opinions on the judge");

    const dir = tempDir();
    appendJsonl(runsPath(dir, "H0", 1), makeRecord(H0, q01, makeAnswer(["A claim."])));
    appendJsonl(gradesPath(dir, "H0", 1), makeGrade({}));
    const text = renderDetailMd(loadDetailInput(dir, [q01]), [q01], {
      items: 3,
      reviewers: [
        {
          id: "one",
          model: "model-one",
          agreed: 2,
          claims: { items: 2, agreed: 1 },
          answers: { items: 1, agreed: 1 },
        },
      ],
      reviewers_agree: 3,
      all_agree: 2,
      split: [
        {
          id: "c02",
          kind: "claim",
          question_id: "q01",
          setup_id: "H0",
          repeat: 1,
          claim_index: 0,
          judge_label: "supported",
          labels: { one: "not_supported" },
        },
      ],
    });
    expect(text).toContain("| one | model-one | 2 of 3 | 1 of 2 | 1 of 1 |");
    expect(text).toContain("The judge and every reviewer gave the same label on 2 of 3.");
    expect(text).toContain("| c02 | claim | q01 | H0 | supported | not_supported |");
  });
});
