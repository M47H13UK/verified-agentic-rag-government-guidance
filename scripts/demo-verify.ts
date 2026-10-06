// Shows the verifier at work on a draft that is wrong on purpose. Run with `npm run demo:verify`.
//
// The draft has three claims about the Graduate visa:
//   1. true, with a real quote
//   2. a real quote, but the claim says "any job" where the page says "most jobs"
//   3. a made-up fee with a made-up quote
// The quote check should catch claim 3 and the verifier model should catch claim 2.
// Then the agent gets one repair attempt. This makes real model calls.
import { createAnswerFn } from "../src/answer";
import { closeDb, getDb } from "../src/db";
import { loadEnv } from "../src/env";
import { printAnswer, printVerification } from "../src/print";
import { getPassagesById } from "../src/tools/readPassage";
import type { AnswerResult, Setup } from "../src/types";
import { ZERO_USAGE } from "../src/usage";

loadEnv();

const question = "How long does a Graduate visa last if I apply in 2027, and can I work on it?";

const draft: AnswerResult = {
  answer: {
    status: "answered",
    summary: "A Graduate visa lasts 18 months if you apply in 2027. You can work in any job.",
    claims: [
      {
        text: "A Graduate visa lasts 18 months if you apply on or after 1 January 2027.",
        citations: [
          {
            passage_id: "/graduate-visa#overview#2",
            quote: "18 months if you apply on or after 1 January 2027",
          },
        ],
      },
      {
        text: "With a Graduate visa you can work in any job.",
        citations: [{ passage_id: "/graduate-visa#overview#3", quote: "work in most jobs" }],
      },
      {
        text: "The application fee for a Graduate visa is £500.",
        citations: [
          {
            passage_id: "/graduate-visa#how-much-it-costs#1",
            quote: "pay the £500 application fee",
          },
        ],
      },
    ],
  },
  trace: [],
  usage: ZERO_USAGE,
  latencyMs: 0,
  numTurns: 0,
};

const setup: Setup = { id: "demo", model: "claude-haiku-4-5", verifier: true };

try {
  const db = await getDb();

  console.log("BEFORE. The draft, wrong on purpose.\n");
  console.log(draft.answer!.summary);
  draft.answer!.claims.forEach((claim, index) => console.log(`${index + 1}. ${claim.text}`));

  console.log("\nChecking. This takes about 30 seconds.\n");
  // Passing the draft in means the agent is not asked for a first answer. Only the checks and the repair run.
  const run = await createAnswerFn(db)(question, setup, draft);

  console.log("FIRST PASS. One verdict per draft claim.\n");
  for (const verdict of run.verification?.first_pass ?? []) {
    console.log(`${verdict.claim_index + 1}. ${verdict.verdict}, by the ${verdict.checked_by}`);
    console.log(`   ${verdict.reason}`);
  }

  console.log("\nAFTER. What the user sees.\n");
  const cited = run.final_answer?.claims.flatMap((c) => c.citations.map((x) => x.passage_id)) ?? [];
  printAnswer(run, await getPassagesById(db, cited));
  if (run.verification) printVerification(run.verification);
} finally {
  await closeDb();
}
