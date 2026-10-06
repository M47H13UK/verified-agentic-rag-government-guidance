import type { AnswerResult, Passage, Run, Usage, VerificationRecord } from "./types";

// Plain text output for the command line.

const DISCLAIMER =
  "Unofficial. General information, not legal advice. Check the linked GOV.UK pages.\n" +
  "Contains public sector information licensed under the Open Government Licence v3.0.";

/** Prints the answer the user would see, with each claim's quotes, page and last updated date. */
export function printAnswer(run: Run, passages: Map<string, Passage>): void {
  const answer = run.final_answer;
  if (!answer) {
    console.log(`No answer. ${run.draft.error ?? "The model did not return a valid answer."}`);
    return;
  }

  console.log(`Status: ${answer.status}`);
  console.log(`\n${answer.summary}`);
  if (answer.declined_reason) console.log(`\nReason: ${answer.declined_reason}`);
  if (answer.clarifying_question) console.log(`\nQuestion for you: ${answer.clarifying_question}`);

  answer.claims.forEach((claim, index) => {
    const verdict = run.final_verdicts[index]?.verdict ?? "not checked";
    console.log(`\n${index + 1}. ${claim.text}  [${verdict}]`);
    for (const citation of claim.citations) {
      const passage = passages.get(citation.passage_id);
      console.log(`   "${citation.quote.replace(/\s+/g, " ")}"`);
      if (passage) {
        console.log(`   ${passage.heading_path}, updated ${passage.updated.slice(0, 10)}`);
        console.log(`   ${passage.url}`);
      } else {
        console.log(`   Unknown passage ${citation.passage_id}`);
      }
    }
  });

  console.log(`\n${DISCLAIMER}`);
}

/** Prints what the two checks and the repair attempt did to the draft. */
export function printVerification(record: VerificationRecord): void {
  console.log("\nVerification");
  console.log(`  Claims in the draft: ${record.claims_before}`);
  console.log(`  Dropped by the quote check: ${record.dropped_by_quote_check}`);
  console.log(`  Dropped by the verifier: ${record.dropped_by_verifier}`);
  const repair = record.repair_ran
    ? `yes, the repaired answer had ${record.claims_after_repair} claims`
    : "no";
  console.log(`  Repair attempt: ${repair}`);
  console.log(`  Claims shown: ${record.claims_final}`);
  if (record.summary_replaced) {
    console.log("  The summary was rebuilt from the confirmed claims.");
  }
  for (const claim of record.unconfirmed) {
    console.log(`  Could not be confirmed: ${claim}`);
  }
  printUsage("  Checking added", record.extra_usage);
}

/** Prints every tool call of one agent run, in order. */
export function printTrace(result: AnswerResult): void {
  console.log("\nTrace");
  result.trace.forEach((call, index) => {
    const duration = call.duration_ms === null ? "no duration" : `${call.duration_ms} ms`;
    const outcome = call.ok
      ? `${call.passage_ids.length} passages, ${call.result_chars} chars`
      : `failed: ${call.error ?? "unknown error"}`;
    console.log(
      `  ${index + 1}. ${call.tool} ${JSON.stringify(call.input)}  ->  ${outcome}, ${duration}`,
    );
  });
  console.log(`  Turns: ${result.numTurns}. Time: ${(result.latencyMs / 1000).toFixed(1)} s.`);
}

export function printUsage(label: string, usage: Usage): void {
  console.log(
    `${label}: ${usage.inputTokens} input, ${usage.outputTokens} output, ` +
      `${usage.cacheReadTokens} cache read, ${usage.cacheCreationTokens} cache write tokens. ` +
      `Estimated cost at list prices $${usage.costUsd.toFixed(4)}.`,
  );
}
