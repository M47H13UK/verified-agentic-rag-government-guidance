// Shared types. Every part of the project builds against these shapes.
// MongoDB has no fixed schema, so these types are the schema.

// ---------- Corpus ----------

/** One GOV.UK page. Stored in the `pages` collection, keyed by its base path. */
export type Page = {
  /** The base path, for example "/graduate-visa". */
  _id: string;
  title: string;
  /** GOV.UK document type, for example "guide" or "guidance". */
  format: string;
  url: string;
  /** `public_updated_at` from the Content API, ISO 8601. */
  updated: string;
  first_published: string | null;
  passage_count: number;
  word_count: number;
  /** When this copy was fetched, ISO 8601. */
  fetched_at: string;
};

/** One chunk of a page. Stored in the `passages` collection. This is what the agent searches and quotes. */
export type Passage = {
  /** Passage ID, "<base_path>#<part-slug>#<n>", for example "/graduate-visa#overview#2". */
  _id: string;
  base_path: string;
  /** Slug of the guide part. Pages without parts use "body". */
  part_slug: string;
  /** Position of the passage inside its part, starting at 1. */
  n: number;
  /** Page title, trimmed. */
  title: string;
  /** The headings above the start of the passage, joined with " > ". */
  heading_path: string;
  /** Headings merged into the passage text after its first heading. */
  headings: string[];
  /** Link to the page, with the part path for guides. */
  url: string;
  format: string;
  /** `public_updated_at` of the page, ISO 8601. Shown with every citation. */
  updated: string;
  word_count: number;
  text: string;
};

// ---------- The answer ----------

export type AnswerStatus = "answered" | "declined" | "needs_clarification";

export type Citation = {
  passage_id: string;
  /** Words copied exactly from the passage. */
  quote: string;
};

export type Claim = {
  text: string;
  citations: Citation[];
};

/** The typed object the agent returns instead of free text. */
export type StructuredAnswer = {
  status: AnswerStatus;
  /** One or two plain sentences. */
  summary: string;
  claims: Claim[];
  declined_reason?: string;
  clarifying_question?: string;
};

// ---------- One agent run ----------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type RunOptions = {
  /** Model ID, for example "claude-haiku-4-5". */
  model: string;
  /** Thinking effort. Left out, the model uses its own default. */
  effort?: Effort;
  /** Cap on tool-use turns. */
  maxTurns?: number;
  /** Set on the repair attempt. Names the claims that failed verification and why. */
  feedback?: string;
};

/** One tool call, as recorded by the tracing hooks. */
export type ToolCallTrace = {
  tool_use_id: string;
  /** Tool name without the MCP prefix, for example "search_guidance". */
  tool: string;
  input: unknown;
  ok: boolean;
  /** Size of the tool result in characters. */
  result_chars: number;
  /** Passages the call returned. Used for the retrieval hit rate. */
  passage_ids: string[];
  /** Null when the SDK did not report a duration. */
  duration_ms: number | null;
  /** ISO 8601. */
  started_at: string;
  error?: string;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** The SDK's estimate at list prices. It is not a charge. */
  costUsd: number;
};

export type AnswerResult = {
  /** Null when the model failed to produce a valid answer. */
  answer: StructuredAnswer | null;
  trace: ToolCallTrace[];
  usage: Usage;
  latencyMs: number;
  numTurns: number;
  error?: string;
};

/**
 * Anything that can answer a question with the two tools.
 * Version 1 has one backend, the Claude Agent SDK. The verifier and the eval only see AnswerResult.
 */
export interface AnswerBackend {
  /** For example "agent-sdk/claude-haiku-4-5/default". */
  name: string;
  answer(question: string, opts: RunOptions): Promise<AnswerResult>;
}

// ---------- Verification ----------

export type Verdict = "supported" | "partially_supported" | "not_supported";

export type ClaimVerdict = {
  /** Index of the claim in the answer's `claims` array. */
  claim_index: number;
  verdict: Verdict;
  /** One sentence. */
  reason: string;
  /** What a supported version of the claim would say, if there is one. */
  fix?: string;
  /** Which check produced the verdict. */
  checked_by: "quote_check" | "verifier";
};

/** What verification did to one answer. The eval reports these numbers. */
export type VerificationRecord = {
  claims_before: number;
  dropped_by_quote_check: number;
  dropped_by_verifier: number;
  repair_ran: boolean;
  /** The repair attempt itself, with its answer and trace. Null when repair did not run. */
  repair: AnswerResult | null;
  /** Claims in the repaired answer, before it was checked again. Null when repair did not run. */
  claims_after_repair: number | null;
  /** Claims shown to the user. */
  claims_final: number;
  first_pass: ClaimVerdict[];
  /** Verdicts on the repaired answer. Null when repair did not run. */
  second_pass: ClaimVerdict[] | null;
  /** Text of the claims that were removed and never confirmed. */
  unconfirmed: string[];
  /** True when the model's summary was replaced by one built from the confirmed claims. */
  summary_replaced: boolean;
  /** Tokens and cost added by the verifier call and the repair attempt. */
  extra_usage: Usage;
  extra_latency_ms: number;
};

// ---------- Stored runs ----------

/** One model setup, for example Haiku with the verifier on. */
export type Setup = {
  /** Short ID used in file names and tables, for example "H1". */
  id: string;
  model: string;
  effort?: Effort;
  verifier: boolean;
};

/** One answered question, start to finish. Stored in the `runs` collection. */
export type Run = {
  _id: string;
  question: string;
  setup: Setup;
  /** ISO 8601. */
  created_at: string;
  /** What the agent produced before any checking. */
  draft: AnswerResult;
  /** Null when the setup has the verifier off. */
  verification: VerificationRecord | null;
  /** What the user sees. Equal to the draft answer when the verifier is off. */
  final_answer: StructuredAnswer | null;
  /** Verdict for each claim in `final_answer`, in order. Empty when the verifier is off. */
  final_verdicts: ClaimVerdict[];
  /** Draft plus verification. */
  total_usage: Usage;
  total_latency_ms: number;
};

// ---------- Answering a question ----------

/** Looks up passages by ID. Missing IDs are left out of the map. */
export type PassageLookup = (ids: string[]) => Promise<Map<string, Passage>>;

/**
 * Answers one question with one setup and returns the full Run.
 * The command line, the API and the eval all depend on this one function type.
 * `createAnswerFn` in `src/answer.ts` builds the real one.
 * When `existingDraft` is given, the agent is not called again and that draft is verified instead.
 */
export type AnswerFn = (
  question: string,
  setup: Setup,
  existingDraft?: AnswerResult,
) => Promise<Run>;
