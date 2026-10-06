import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { ZERO_USAGE } from "../usage";
import { errorFromResult, observeSdkMessage, sdkEnv, usageFromResult } from "./sdk";
import type { StructuredCall } from "./types";

/**
 * One model call with no tools that returns an object matching a Zod schema.
 * The verifier and the eval judge both use it. It goes through the Agent SDK, like the agent,
 * so the same credential pays for it and the same result message reports its cost.
 */
export const sdkStructuredCall: StructuredCall = async ({
  model,
  effort,
  system,
  prompt,
  schema,
}) => {
  const startedAt = Date.now();

  const options: Options = {
    model,
    systemPrompt: system,
    // No tools at all. The model can only read the prompt and answer.
    tools: [],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    // Returning the structured answer uses one turn. The spare turns let the SDK ask again on a schema mismatch.
    maxTurns: 3,
    outputFormat: {
      type: "json_schema",
      schema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>,
    },
    env: sdkEnv(),
    ...(effort ? { effort } : {}),
  };

  let data: z.infer<typeof schema> | null = null;
  let usage = ZERO_USAGE;
  let error: string | undefined;

  try {
    for await (const message of query({ prompt, options })) {
      observeSdkMessage(message);
      if (message.type !== "result") continue;

      usage = usageFromResult(message);
      error = errorFromResult(message);
      if (message.subtype === "success") {
        const parsed = schema.safeParse(message.structured_output);
        if (parsed.success) data = parsed.data;
        else error = "The call succeeded but returned no output matching the schema.";
      }
    }
  } catch (thrown) {
    // query() throws after an error result. Keep the more specific text from the result message.
    error ??= thrown instanceof Error ? thrown.message : String(thrown);
  }

  return { data, usage, latencyMs: Date.now() - startedAt, ...(error ? { error } : {}) };
};
