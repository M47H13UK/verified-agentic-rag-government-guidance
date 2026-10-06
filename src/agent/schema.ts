import { z } from "zod";
import type { StructuredAnswer } from "../types";

/** The prompt asks for quotes no longer than this. A short quote is easy to check by eye. */
export const MAX_QUOTE_WORDS = 40;

/**
 * The shape of the agent's final answer.
 * `satisfies` makes the compiler check that this schema and the StructuredAnswer type stay the same.
 * The descriptions are sent to the model as part of the JSON Schema.
 */
export const answerSchema = z.object({
  status: z.enum(["answered", "declined", "needs_clarification"]),
  summary: z.string().describe("One or two plain sentences."),
  claims: z.array(
    z.object({
      text: z.string().describe("One factual statement."),
      citations: z.array(
        z.object({
          passage_id: z.string().describe("The ID of a passage a tool returned, copied exactly."),
          quote: z
            .string()
            .describe(`At most ${MAX_QUOTE_WORDS} words copied exactly from that passage.`),
        }),
      ),
    }),
  ),
  declined_reason: z.string().optional().describe('Only when status is "declined".'),
  clarifying_question: z.string().optional().describe('Only when status is "needs_clarification".'),
}) satisfies z.ZodType<StructuredAnswer>;

/**
 * The same schema as JSON Schema, which is what the SDK's `outputFormat` takes.
 * The SDK validates with draft-07. Zod writes draft 2020-12 unless told otherwise.
 */
export const answerJsonSchema = z.toJSONSchema(answerSchema, { target: "draft-7" }) as Record<
  string,
  unknown
>;
