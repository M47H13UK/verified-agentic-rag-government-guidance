import type { Db } from "mongodb";
import { createAgentBackend } from "./agent/backend";
import { sdkStructuredCall } from "./llm/structuredCall";
import { runPipeline, type PipelineDeps } from "./pipeline";
import type { AnswerFn } from "./types";
import { getPassagesById } from "./tools/readPassage";
import { makeVerifier, VERIFIER_MODEL } from "./verify/verifier";

/**
 * Wires the real parts together: the agent, the verifier model and the passage lookup.
 * The command line, the API and the eval all answer questions through the function this returns,
 * so they cannot drift apart. Tests build the pipeline with fakes instead.
 */
export function createAnswerFn(db: Db): AnswerFn {
  const deps: PipelineDeps = {
    backend: createAgentBackend(db),
    verify: makeVerifier(sdkStructuredCall, VERIFIER_MODEL),
    getPassages: (ids) => getPassagesById(db, ids),
  };
  return (question, setup, existingDraft) => runPipeline(question, setup, deps, existingDraft);
}
