// Mock data for `npm run api:mock` and for the API tests. No model is called.
// The passages and the quotes are real, from data/sample/.
// Every number here (tokens, costs, latencies, eval scores) is MADE UP. None of it is a result.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { paretoFrontier, pickHeadlineSetups } from "../eval/frontier";
import { JUDGE_MODEL, SETUPS, VERIFIER_MODEL } from "../eval/setups";
import type { Category, EvalSummary, SetupSummary } from "../eval/types";
import type {
  ClaimVerdict,
  Passage,
  Run,
  Setup,
  StructuredAnswer,
  ToolCallTrace,
  Usage,
  VerificationRecord,
} from "../types";
import type { ServerDeps } from "./types";

/**
 * Builds the mock dependencies for `createApp`.
 * `delayMs` makes each answer wait, so the loading state of the page can be seen.
 */
export function createMockDeps(options: { delayMs?: number } = {}): ServerDeps {
  const passages = loadSamplePassages();
  // Runs are kept in memory. They are gone when the server stops.
  const runs = new Map<string, Run>();

  return {
    mock: true,
    // The same list as the real server, so the dropdown and the results table match it.
    setups: SETUPS,
    answer: async (question, setup) => {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      return mockRun(question, setup);
    },
    saveRun: async (run) => {
      runs.set(run._id, run);
    },
    getRun: async (id) => runs.get(id) ?? null,
    getPassages: async (ids) => {
      const found = new Map<string, Passage>();
      for (const id of ids) {
        const passage = passages.get(id);
        if (passage) found.set(id, passage);
      }
      return found;
    },
    readSummary: async () => mockSummary(),
  };
}

/** The 13 real passages of the Graduate visa guide, keyed by passage ID. */
function loadSamplePassages(): Map<string, Passage> {
  const file = new URL("../../data/sample/passages.json", import.meta.url);
  const list = JSON.parse(readFileSync(file, "utf8")) as Passage[];
  return new Map(list.map((p) => [p._id, p]));
}

// ---------- The canned answers ----------

const HOW_LONG = "/graduate-visa#overview#2";
const COSTS = "/graduate-visa#how-much-it-costs#1";

/**
 * What the agent wrote before any checking. The quotes are word for word from the sample passages.
 * The last claim adds up two numbers. The total is not on the page, so the verifier removes it.
 */
const DRAFT_ANSWER: StructuredAnswer = {
  status: "answered",
  summary:
    "A Graduate visa lasts 2 years if you apply on or before 31 December 2026, or 3 years if you have a PhD. You pay an application fee and the healthcare surcharge.",
  claims: [
    {
      text: "A Graduate visa lasts 2 years if you apply on or before 31 December 2026, and 18 months if you apply on or after 1 January 2027.",
      citations: [
        {
          passage_id: HOW_LONG,
          quote:
            "A Graduate visa lasts for: 2 years if you apply on or before 31 December 2026 18 months if you apply on or after 1 January 2027",
        },
      ],
    },
    {
      text: "If you have a PhD or other doctoral qualification, the visa lasts 3 years.",
      citations: [
        {
          passage_id: HOW_LONG,
          quote: "If you have a PhD or other doctoral qualification, it will last for 3 years.",
        },
      ],
    },
    {
      text: "The application fee is £937 and the healthcare surcharge is £1,035 for each year you will be in the UK.",
      citations: [
        { passage_id: COSTS, quote: "pay the £937 application fee" },
        {
          passage_id: COSTS,
          quote:
            "pay the healthcare surcharge - this is usually £1,035 for each year you’ll be in the UK",
        },
      ],
    },
    {
      text: "A 2 year Graduate visa costs £3,007 in total.",
      citations: [{ passage_id: COSTS, quote: "2 years - it will cost £2,070" }],
    },
  ],
};

/** The verifier's verdicts on the four draft claims. The last one is the claim that gets removed. */
const FIRST_PASS: ClaimVerdict[] = [
  {
    claim_index: 0,
    verdict: "supported",
    reason: "The passage gives both lengths and both dates.",
    checked_by: "verifier",
  },
  {
    claim_index: 1,
    verdict: "supported",
    reason: "The passage says a doctoral qualification gives 3 years.",
    checked_by: "verifier",
  },
  {
    claim_index: 2,
    verdict: "partially_supported",
    reason:
      "The passage says the surcharge is usually £1,035 a year. The claim states it as a fixed amount.",
    fix: "The application fee is £937 and the healthcare surcharge is usually £1,035 for each year you will be in the UK.",
    checked_by: "verifier",
  },
  {
    claim_index: 3,
    verdict: "not_supported",
    reason: "The passage gives the fee and the surcharge separately. It does not state a total.",
    checked_by: "verifier",
  },
];

const DECLINED_ANSWER: StructuredAnswer = {
  status: "declined",
  summary: "This assistant cannot answer that question.",
  claims: [],
  declined_reason:
    "The question asks for a judgement about one person's application. This assistant only reports what GOV.UK pages say.",
};

const CLARIFY_ANSWER: StructuredAnswer = {
  status: "needs_clarification",
  summary: "The question could mean more than one visa.",
  claims: [],
  clarifying_question: "Which visa do you mean? For example the Student visa or the Graduate visa.",
};

/** Four tool calls, as the tracing hooks would record them. The times and sizes are made up. */
function mockTrace(startedAtMs: number): ToolCallTrace[] {
  const at = (offsetMs: number) => new Date(startedAtMs + offsetMs).toISOString();
  return [
    {
      tool_use_id: "mock_tool_1",
      tool: "search_guidance",
      input: { query: "Graduate visa how long can you stay" },
      ok: true,
      result_chars: 2140,
      passage_ids: [HOW_LONG, "/graduate-visa#overview#1", "/graduate-visa#course-you-studied#2"],
      duration_ms: 41,
      started_at: at(1800),
    },
    {
      tool_use_id: "mock_tool_2",
      tool: "read_passage",
      input: { passage_id: HOW_LONG },
      ok: true,
      result_chars: 1620,
      passage_ids: [HOW_LONG],
      duration_ms: 6,
      started_at: at(4300),
    },
    {
      tool_use_id: "mock_tool_3",
      tool: "search_guidance",
      input: { query: "Graduate visa application fee healthcare surcharge" },
      ok: true,
      result_chars: 1385,
      passage_ids: [COSTS, "/graduate-visa#overview#3"],
      duration_ms: 37,
      started_at: at(6100),
    },
    {
      tool_use_id: "mock_tool_4",
      tool: "read_passage",
      input: { passage_id: COSTS },
      ok: true,
      result_chars: 655,
      passage_ids: [COSTS],
      duration_ms: 5,
      started_at: at(8200),
    },
  ];
}

// Made-up usage. DRAFT is the answering model, VERIFY is the verifier call plus the repair attempt.
const DRAFT_USAGE: Usage = {
  inputTokens: 9840,
  outputTokens: 612,
  cacheReadTokens: 14200,
  cacheCreationTokens: 3100,
  costUsd: 0.0112,
};
const VERIFY_USAGE: Usage = {
  inputTokens: 6230,
  outputTokens: 540,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.0131,
};
const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
};
const DRAFT_LATENCY_MS = 11_400;
const VERIFY_LATENCY_MS = 9_800;

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

/**
 * Picks the canned answer for a question, so all three answer shapes can be seen in the page.
 * A question with the word "approved" is declined. A question of fewer than four words gets a
 * clarifying question. Every other question gets the Graduate visa answer.
 */
function pickDraft(question: string): StructuredAnswer {
  if (question.toLowerCase().includes("approved")) return DECLINED_ANSWER;
  if (question.trim().split(/\s+/).length < 4) return CLARIFY_ANSWER;
  return DRAFT_ANSWER;
}

/** The record for an answer with no claims. Nothing was checked, so everything is zero. */
const EMPTY_VERIFICATION: VerificationRecord = {
  claims_before: 0,
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
  extra_usage: NO_USAGE,
  extra_latency_ms: 0,
};

/** The record for the Graduate visa answer. One of four claims is dropped and the repair attempt runs. */
const GRADUATE_VERIFICATION: VerificationRecord = {
  claims_before: 4,
  dropped_by_quote_check: 0,
  dropped_by_verifier: 1,
  repair_ran: true,
  // The mock keeps the counts and leaves out the repair run itself.
  repair: null,
  claims_after_repair: 3,
  claims_final: 3,
  first_pass: FIRST_PASS,
  // The repaired answer is the first three claims again, with the same verdicts.
  second_pass: FIRST_PASS.slice(0, 3),
  unconfirmed: ["A 2 year Graduate visa costs £3,007 in total."],
  summary_replaced: true,
  extra_usage: VERIFY_USAGE,
  extra_latency_ms: VERIFY_LATENCY_MS,
};

/** Builds one canned Run for a question and a setup. */
export function mockRun(question: string, setup: Setup): Run {
  const draftAnswer = pickDraft(question);
  const answered = draftAnswer.status === "answered";
  // The run pretends to have started one draft latency ago, so the tool call times are in the past.
  const startedAtMs = Date.now() - DRAFT_LATENCY_MS;
  const trace = mockTrace(startedAtMs);

  // With the verifier off, the user sees the draft as it is.
  const run: Run = {
    _id: `mock-${randomUUID()}`,
    question,
    setup,
    created_at: new Date(startedAtMs).toISOString(),
    draft: {
      answer: draftAnswer,
      // The declined and clarifying answers show one search instead of four calls.
      trace: answered ? trace : trace.slice(0, 1),
      usage: DRAFT_USAGE,
      latencyMs: DRAFT_LATENCY_MS,
      numTurns: answered ? 5 : 2,
    },
    verification: null,
    final_answer: draftAnswer,
    final_verdicts: [],
    total_usage: DRAFT_USAGE,
    total_latency_ms: DRAFT_LATENCY_MS,
  };
  if (!setup.verifier) return run;

  if (!answered) {
    return { ...run, verification: EMPTY_VERIFICATION };
  }

  // With the verifier on, the fourth draft claim is removed and the other three keep their verdicts.
  return {
    ...run,
    verification: GRADUATE_VERIFICATION,
    final_answer: { ...DRAFT_ANSWER, claims: DRAFT_ANSWER.claims.slice(0, 3) },
    final_verdicts: FIRST_PASS.slice(0, 3),
    total_usage: addUsage(DRAFT_USAGE, VERIFY_USAGE),
    total_latency_ms: DRAFT_LATENCY_MS + VERIFY_LATENCY_MS,
  };
}

// ---------- The mock eval summary ----------

const MOCK_QUESTIONS = 60;

/**
 * The real eval runs every setup once and then repeats only a few of them.
 * The mock does the same, so the page shows rows with a range and rows without one.
 */
const MOCK_REPEATED = ["OM0", "OM1", "OX0", "OX1"];
const MOCK_REPEATS = 3;

/**
 * Made-up headline numbers for each setup. The columns are correctness, unsupported-claim rate,
 * behaviour accuracy, retrieval hit rate, cost per answer in US dollars, p50 seconds, p95 seconds.
 * The costs run from under one cent to about 30 cents, which is the spread the chart has to handle.
 */
const MOCK_SCORES: Record<string, number[]> = {
  H0: [0.72, 0.14, 0.8, 0.84, 0.034, 9, 21],
  H1: [0.71, 0.04, 0.82, 0.84, 0.05, 17, 38],
  "H5-0": [0.78, 0.08, 0.86, 0.9, 0.006, 8, 18],
  "H5-1": [0.79, 0.02, 0.87, 0.9, 0.027, 15, 33],
  S0: [0.8, 0.09, 0.88, 0.9, 0.041, 14, 31],
  S1: [0.86, 0.03, 0.9, 0.9, 0.058, 24, 49],
  OM0: [0.84, 0.06, 0.92, 0.93, 0.11, 19, 40],
  OM1: [0.9, 0.02, 0.93, 0.93, 0.13, 29, 58],
  OX0: [0.87, 0.05, 0.93, 0.95, 0.27, 41, 88],
  OX1: [0.91, 0.02, 0.95, 0.95, 0.29, 52, 104],
};

/** One made-up row of the results table, built from one line of MOCK_SCORES. */
function mockSetupSummary(setup: Setup, scores: number[]): SetupSummary {
  const [
    correctness = 0,
    unsupported = 0,
    behaviour = 0,
    retrieval = 0,
    cost = 0,
    p50 = 0,
    p95 = 0,
  ] = scores;
  // Rounding hides floating point noise such as 0.7100000000000001.
  const round = (value: number) => Math.round(value * 1000) / 1000;
  // With one repeat the lowest and the highest are the value itself, as in the real summary.
  const repeated = MOCK_REPEATED.includes(setup.id);
  const spread = repeated ? 0.02 : 0;
  const rateSpread = repeated ? 0.01 : 0;
  return {
    setup,
    repeats: repeated ? MOCK_REPEATS : 1,
    questions: MOCK_QUESTIONS,
    correctness,
    correctness_min: round(correctness - spread),
    correctness_max: round(correctness + spread),
    unsupported_claim_rate: unsupported,
    unsupported_claim_rate_min: round(Math.max(0, unsupported - rateSpread)),
    unsupported_claim_rate_max: round(unsupported + rateSpread),
    behaviour_accuracy: behaviour,
    retrieval_hit_rate: retrieval,
    cost_per_answer_usd: cost,
    latency_p50_s: p50,
    latency_p95_s: p95,
    claims_shown: 540,
    errors: 0,
    dropped_by_quote_check: setup.verifier ? 9 : 0,
    dropped_by_verifier: setup.verifier ? 21 : 0,
    repairs_ran: setup.verifier ? 26 : 0,
  };
}

const CATEGORIES: Category[] = [
  "single_page",
  "multi_page",
  "numbers",
  "not_covered",
  "personal_judgement",
  "false_premise",
  "ambiguous",
];

/** Made-up scores that repeat, so the drill-down table has a mix of good and bad rows. */
const SCORE_PATTERN = [1, 1, 0.75, 1, 0.5, 1, 1, 0, 1, 0.75];

/** A made-up EvalSummary with every setup of the eval. The shape is real, the numbers are not. */
export function mockSummary(): EvalSummary {
  const setups = SETUPS.map((setup) => mockSetupSummary(setup, MOCK_SCORES[setup.id] ?? []));
  // The frontier and the two headline setups come from the same code the real report uses.
  const headline = pickHeadlineSetups(setups);

  // 60 made-up question IDs. The categories take turns.
  const questions = Array.from({ length: MOCK_QUESTIONS }, (_, i) => ({
    id: `mock-q${String(i + 1).padStart(2, "0")}`,
    category: CATEGORIES[i % CATEGORIES.length] ?? "single_page",
  }));
  const byCategory: Record<string, number> = {};
  for (const q of questions) {
    byCategory[q.category] = (byCategory[q.category] ?? 0) + 1;
  }

  // One row for each question and setup. These rows do not add up to the setup numbers above.
  const perQuestion = questions.flatMap((q, qIndex) =>
    SETUPS.map((setup, setupIndex) => {
      const correctness = SCORE_PATTERN[(qIndex + setupIndex) % SCORE_PATTERN.length] ?? 1;
      return {
        question_id: q.id,
        category: q.category,
        setup_id: setup.id,
        correctness,
        behaviour_correct: correctness > 0,
        unsupported_claims: correctness < 0.75 && !setup.verifier ? 1 : 0,
        total_claims: 3,
      };
    }),
  );

  return {
    generated_at: "2026-10-06T12:00:00.000Z",
    gold_set: { questions: MOCK_QUESTIONS, verified: MOCK_QUESTIONS, by_category: byCategory },
    judge_model: JUDGE_MODEL,
    verifier_model: VERIFIER_MODEL,
    setups,
    frontier: {
      pareto: paretoFrontier(setups),
      most_accurate: headline.most_accurate,
      cheapest_accurate: headline.cheapest_accurate,
      cost_ratio: headline.cost_ratio,
    },
    per_question: perQuestion,
    total_cost_usd: 214.5,
    // A made-up audit of the same size as the real sample, which is 30 claims and 15 answers.
    judge_audit: {
      labelled: 45,
      agreed: 41,
      agreement_rate: 41 / 45,
      claims: { labelled: 30, agreed: 28 },
      answers: { labelled: 15, agreed: 13 },
    },
  };
}
