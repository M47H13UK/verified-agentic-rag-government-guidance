import { randomUUID } from "node:crypto";
import type {
  AnswerBackend,
  AnswerResult,
  Claim,
  ClaimVerdict,
  Passage,
  PassageLookup,
  Run,
  RunOptions,
  Setup,
  StructuredAnswer,
  Usage,
  VerificationRecord,
} from "./types";
import { addUsage, ZERO_USAGE } from "./usage";
import { quoteCheck } from "./verify/quoteCheck";
import { buildRepairFeedback } from "./verify/repair";
import { missingVerdict, type VerifierFn } from "./verify/verifier";

// The pipeline. It turns one question into one Run. The steps are the draft, the two checks,
// one repair attempt and the final answer.
// A confident answer is not proof, so with the verifier on no claim is shown until both checks
// have passed it.

export type PipelineDeps = {
  backend: AnswerBackend;
  verify: VerifierFn;
  getPassages: PassageLookup;
  maxTurns?: number;
};

/** Shown when no claim is left. */
export const NOT_CONFIRMED = "The draft answer could not be confirmed against the guidance.";

function countDropped(verdicts: ClaimVerdict[], checkedBy: ClaimVerdict["checked_by"]): number {
  return verdicts.filter((v) => v.verdict === "not_supported" && v.checked_by === checkedBy).length;
}

/**
 * Runs both checks on one answer and returns one verdict per claim, in claim order.
 * The quote check runs first because it is free and exact. The verifier model only sees claims
 * whose quotes are real, so no tokens are spent on a claim that has already failed.
 * The same model call also says whether the summary stays within the supported claims.
 */
async function verifyAnswer(
  question: string,
  answer: StructuredAnswer,
  deps: PipelineDeps,
): Promise<{
  verdicts: ClaimVerdict[];
  summarySupported: boolean;
  usage: Usage;
  latencyMs: number;
}> {
  const citedIds = [
    ...new Set(answer.claims.flatMap((claim) => claim.citations.map((c) => c.passage_id))),
  ];
  const passages =
    citedIds.length > 0 ? await deps.getPassages(citedIds) : new Map<string, Passage>();

  const quoteVerdicts = quoteCheck(answer, passages);

  const toVerify = answer.claims
    .map((claim, claim_index) => ({ claim_index, claim }))
    .filter(({ claim_index }) => quoteVerdicts[claim_index]?.verdict === "supported");
  if (toVerify.length === 0) {
    // Nothing reached the verifier. Either there are no claims, or every claim failed the quote
    // check and will be removed, which replaces the summary anyway.
    return { verdicts: quoteVerdicts, summarySupported: true, usage: ZERO_USAGE, latencyMs: 0 };
  }

  const result = await deps.verify({
    question,
    summary: answer.summary,
    claims: toVerify,
    passages,
  });

  // The verifier's verdict replaces the quote check's "supported" for every claim it was sent.
  // A claim it was sent and did not answer counts as not supported.
  const verdicts = quoteVerdicts.map((quoteVerdict) => {
    if (quoteVerdict.verdict === "not_supported") {
      return quoteVerdict;
    }
    const fromVerifier = result.verdicts.find((v) => v.claim_index === quoteVerdict.claim_index);
    return fromVerifier ?? missingVerdict(quoteVerdict.claim_index);
  });
  return {
    verdicts,
    summarySupported: result.summarySupported,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

/**
 * Builds the answer that will be shown. It removes every claim that is not supported and returns
 * the verdicts of the claims that are left and the text of the claims that were removed.
 *
 * The model wrote its summary before the checks. When a claim was removed, or the verifier found
 * that the summary says more than the claims do, the summary cannot be trusted. It is then rebuilt
 * by code from the confirmed claims, so everything shown has passed both checks.
 */
function buildShownAnswer(
  answer: StructuredAnswer,
  verdicts: ClaimVerdict[],
  summarySupported: boolean,
): {
  answer: StructuredAnswer;
  verdicts: ClaimVerdict[];
  removed: string[];
  summaryReplaced: boolean;
} {
  const kept: Claim[] = [];
  const keptVerdicts: ClaimVerdict[] = [];
  const removed: string[] = [];

  answer.claims.forEach((claim, index) => {
    const verdict = verdicts[index];
    if (!verdict || verdict.verdict === "not_supported") {
      removed.push(claim.text);
      return;
    }
    // The index is rewritten so that it points at the claim's place in the shown answer.
    keptVerdicts.push({ ...verdict, claim_index: kept.length });
    kept.push(claim);
  });

  const shown: StructuredAnswer = { ...answer, claims: kept };
  // An answer with no confirmed claim is not an answer, so it becomes a decline.
  const nothingConfirmed = answer.status === "answered" && kept.length === 0;
  // The summary of a declined answer, or of one that asks a question, explains the refusal or
  // asks the question. It is not a summary of the claims, so it is left alone.
  const summaryReplaced =
    answer.status === "answered" && (removed.length > 0 || !summarySupported || nothingConfirmed);
  if (summaryReplaced) {
    shown.summary = kept.length > 0 ? kept.map((claim) => claim.text).join(" ") : NOT_CONFIRMED;
  }
  if (nothingConfirmed) {
    shown.status = "declined";
    shown.declined_reason = NOT_CONFIRMED;
  }
  return { answer: shown, verdicts: keptVerdicts, removed, summaryReplaced };
}

function buildRun(
  question: string,
  setup: Setup,
  draft: AnswerResult,
  verification: VerificationRecord | null,
  final_answer: StructuredAnswer | null,
  final_verdicts: ClaimVerdict[],
): Run {
  const extraUsage = verification?.extra_usage ?? ZERO_USAGE;
  const extraLatencyMs = verification?.extra_latency_ms ?? 0;
  return {
    _id: randomUUID(),
    question,
    setup,
    created_at: new Date().toISOString(),
    draft,
    verification,
    final_answer,
    final_verdicts,
    total_usage: addUsage(draft.usage, extraUsage),
    total_latency_ms: draft.latencyMs + extraLatencyMs,
  };
}

/**
 * Answers one question with one setup and returns the full Run.
 * When `existingDraft` is given, the agent is not called again and that draft is verified instead.
 */
export async function runPipeline(
  question: string,
  setup: Setup,
  deps: PipelineDeps,
  existingDraft?: AnswerResult,
): Promise<Run> {
  // Optional settings are only set when they have a value. A key that is present and undefined
  // could overwrite a default when the backend spreads these options.
  const options: RunOptions = { model: setup.model };
  if (setup.effort !== undefined) {
    options.effort = setup.effort;
  }
  if (deps.maxTurns !== undefined) {
    options.maxTurns = deps.maxTurns;
  }

  // 1. The draft. A caller that already has one passes it in, so that the same draft can be
  // compared with the verifier off and on without paying for the agent twice.
  const draft = existingDraft ?? (await deps.backend.answer(question, options));

  // 2. Verifier off. The draft is shown as it is.
  if (!setup.verifier) {
    return buildRun(question, setup, draft, null, draft.answer, []);
  }

  // The record starts as "nothing happened" and is filled in as each check runs.
  const record: VerificationRecord = {
    claims_before: draft.answer?.claims.length ?? 0,
    dropped_by_quote_check: 0,
    dropped_by_verifier: 0,
    repair_ran: false,
    repair: null,
    claims_after_repair: null,
    claims_final: 0,
    first_pass: [],
    second_pass: null,
    unconfirmed: [],
    summary_replaced: false,
    extra_usage: ZERO_USAGE,
    extra_latency_ms: 0,
  };

  // The agent produced no valid answer, so there is nothing to check.
  if (draft.answer === null) {
    return buildRun(question, setup, draft, record, null, []);
  }

  // 3. First pass over the draft.
  const first = await verifyAnswer(question, draft.answer, deps);
  record.first_pass = first.verdicts;
  record.dropped_by_quote_check = countDropped(first.verdicts, "quote_check");
  record.dropped_by_verifier = countDropped(first.verdicts, "verifier");
  record.extra_usage = first.usage;
  record.extra_latency_ms = first.latencyMs;

  // The answer that will be shown, and its verdicts. It is the draft unless a repair replaces it.
  let candidate = draft.answer;
  let verdicts = first.verdicts;
  let summarySupported = first.summarySupported;

  // 4. One repair attempt, only when a claim failed. Partially supported claims do not count.
  // There is no second attempt. Each one costs a full agent run, and a claim that failed twice
  // is more likely to be wrong than badly worded.
  const failed = first.verdicts.filter((v) => v.verdict === "not_supported");
  if (failed.length > 0) {
    const feedback = buildRepairFeedback(draft.answer, failed);
    const repair = await deps.backend.answer(question, { ...options, feedback });
    record.repair_ran = true;
    record.repair = repair;
    record.claims_after_repair = repair.answer?.claims.length ?? 0;
    record.second_pass = [];
    record.extra_usage = addUsage(record.extra_usage, repair.usage);
    record.extra_latency_ms += repair.latencyMs;

    // When the repair produced no valid answer, the draft stays the candidate.
    if (repair.answer !== null) {
      const second = await verifyAnswer(question, repair.answer, deps);
      record.second_pass = second.verdicts;
      record.extra_usage = addUsage(record.extra_usage, second.usage);
      record.extra_latency_ms += second.latencyMs;
      candidate = repair.answer;
      verdicts = second.verdicts;
      summarySupported = second.summarySupported;
    }
  }

  // 5. Whatever is still not supported is removed, not shown with a warning.
  const shown = buildShownAnswer(candidate, verdicts, summarySupported);
  record.claims_final = shown.answer.claims.length;
  record.unconfirmed = shown.removed;
  record.summary_replaced = shown.summaryReplaced;

  return buildRun(question, setup, draft, record, shown.answer, shown.verdicts);
}
