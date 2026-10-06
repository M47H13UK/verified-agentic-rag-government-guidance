import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "mongodb";
import { errorFromResult, observeSdkMessage, sdkEnv, usageFromResult } from "../llm/sdk";
import type { AnswerBackend, AnswerResult, RunOptions, StructuredAnswer } from "../types";
import { ZERO_USAGE } from "../usage";
import { buildPrompt, MAX_TOOL_TURNS, SYSTEM_PROMPT } from "./prompt";
import { answerJsonSchema, answerSchema } from "./schema";
import { ALLOWED_TOOLS, createGuidanceServer, SERVER_NAME } from "./tools";
import { createTraceRecorder } from "./trace";

/**
 * Extra turns on top of the tool turns. The spike showed that returning the structured answer
 * uses one turn of its own. The second one leaves room for the SDK to ask again when the first
 * answer does not match the schema.
 */
const ANSWER_TURNS = 2;

/** The one backend in version 1. It answers with the Claude Agent SDK and the two guidance tools. */
export function createAgentBackend(db: Db): AnswerBackend {
  return {
    name: "agent-sdk",
    answer: (question, opts) => answerWithAgent(db, question, opts),
  };
}

async function answerWithAgent(db: Db, question: string, opts: RunOptions): Promise<AnswerResult> {
  const startedAt = Date.now();
  const recorder = createTraceRecorder();

  const options: Options = {
    model: opts.model,
    systemPrompt: SYSTEM_PROMPT,
    // No built-in tools. No files, no shell, no web. The corpus is the only source.
    tools: [],
    mcpServers: { [SERVER_NAME]: createGuidanceServer(db) },
    // `allowedTools` pre-approves the two tools. It does not restrict anything by itself.
    allowedTools: ALLOWED_TOOLS,
    // Never prompt. Anything not pre-approved is denied.
    permissionMode: "dontAsk",
    // Do not load this machine's Claude Code settings, CLAUDE.md, skills or hooks into the agent.
    settingSources: [],
    // Use only the MCP server passed above.
    strictMcpConfig: true,
    // One question is one run. There is nothing to resume, so no session file is written.
    persistSession: false,
    maxTurns: (opts.maxTurns ?? MAX_TOOL_TURNS) + ANSWER_TURNS,
    outputFormat: { type: "json_schema", schema: answerJsonSchema },
    hooks: recorder.hooks,
    env: sdkEnv(),
    // Left out, the model uses its own default effort.
    ...(opts.effort ? { effort: opts.effort } : {}),
  };

  let answer: StructuredAnswer | null = null;
  let usage = ZERO_USAGE;
  let numTurns = 0;
  let error: string | undefined;

  try {
    for await (const message of query({ prompt: buildPrompt(question, opts.feedback), options })) {
      observeSdkMessage(message);
      recorder.observeMessage(message);
      if (message.type !== "result") continue;

      // The result message is the last one that matters. It has usage and cost even when the run failed.
      usage = usageFromResult(message);
      numTurns = message.num_turns;
      error = errorFromResult(message);
      if (message.subtype === "success") {
        // `structured_output` is typed unknown, and a success can still arrive without it. Parse, do not trust.
        const parsed = answerSchema.safeParse(message.structured_output);
        if (parsed.success) answer = parsed.data;
        else error = "The run succeeded but returned no answer matching the schema.";
      }
    }
  } catch (thrown) {
    // query() throws after it has yielded an error result, for example at the turn cap.
    // The result message above already set `error` in that case, so keep the more specific text.
    error ??= thrown instanceof Error ? thrown.message : String(thrown);
  }

  return {
    answer,
    trace: recorder.trace(),
    usage,
    latencyMs: Date.now() - startedAt,
    numTurns,
    ...(error ? { error } : {}),
  };
}
