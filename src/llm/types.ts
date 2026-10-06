import type { z } from "zod";
import type { Effort, Usage } from "../types";

/** One model call that returns an object matching a Zod schema. The real one uses the Agent SDK. Tests pass a fake. */
export type StructuredCall = <T>(args: {
  model: string;
  effort?: Effort;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}) => Promise<StructuredCallResult<T>>;

export type StructuredCallResult<T> = {
  /** Null when the call failed or the output did not match the schema. */
  data: T | null;
  usage: Usage;
  latencyMs: number;
  error?: string;
};
