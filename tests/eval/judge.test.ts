import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HEADLINE_RULE } from "../../src/eval/frontier";
import {
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  judgeSchema,
  makeJudge,
  type JudgeOutput,
} from "../../src/eval/judge";
import type { StructuredCall } from "../../src/llm/types";
import type { Passage } from "../../src/types";
import { samplePassages, sampleQuotes } from "../helpers/fixtures";
import { allGoodJudgeOutput, H0, makeAnswer, makeQuestion, makeRun, usage } from "./builders";

const passages = new Map<string, Passage>(samplePassages().map((p) => [p._id, p]));
const quote = sampleQuotes()[0]!;

const question = makeQuestion({
  question: "How long does a Graduate visa last?",
  expected_points: ["It lasts 2 years if you apply by 31 December 2026.", "A PhD gives 3 years."],
  must_not_say: ["You can extend a Graduate visa."],
});
const answer = makeAnswer([], {
  summary: "A Graduate visa usually lasts 2 years.",
  claims: [
    {
      text: "A Graduate visa lasts 2 years if you apply on or before 31 December 2026.",
      citations: [{ passage_id: quote.passage_id, quote: quote.quote }],
    },
    {
      text: "You can stay for 5 years with a PhD.",
      citations: [{ passage_id: "/made-up-page#body#1", quote: "5 years" }],
    },
  ],
});
const run = makeRun(H0, question.question, answer);

/** A fake model call. It records what it was asked and returns the given data. */
function fakeCall(data: JudgeOutput | null, error?: string) {
  const seen: { model: string; system: string; prompt: string }[] = [];
  const call: StructuredCall = async (args) => {
    seen.push({ model: args.model, system: args.system, prompt: args.prompt });
    // The fake hands back the judge's shape whatever schema it was given, hence the cast.
    return { data: data as never, usage: usage(0.05), latencyMs: 10, error };
  };
  return { call, seen };
}

describe("buildJudgePrompt", () => {
  const prompt = buildJudgePrompt(question, run, passages);

  it("holds the question, the numbered gold fields and the numbered claims with their quotes", () => {
    expect(prompt).toContain("How long does a Graduate visa last?");
    expect(prompt).toContain("[0] It lasts 2 years if you apply by 31 December 2026.");
    expect(prompt).toContain("[1] A PhD gives 3 years.");
    expect(prompt).toContain("[0] You can extend a Graduate visa.");
    expect(prompt).toContain("Status: answered");
    expect(prompt).toContain("[1] Claim: You can stay for 5 years with a PhD.");
    expect(prompt).toContain(`with the quote "${quote.quote}"`);
  });

  it("holds the full text of a cited passage and flags one that is missing", () => {
    expect(prompt).toContain(passages.get(quote.passage_id)!.text);
    expect(prompt).toContain('<passage id="/made-up-page#body#1">\nThis passage is missing.');
  });

  it("never names the setup or the model, so the judge cannot favour one", () => {
    expect(prompt).not.toContain(H0.model);
    expect(prompt).not.toContain("H0");
  });
});

describe("makeJudge", () => {
  it("makes one call with the judge model and returns the output", async () => {
    const output = allGoodJudgeOutput(question, answer);
    const { call, seen } = fakeCall(output);

    const result = await makeJudge(call, "judge-model")(question, run, passages);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.model).toBe("judge-model");
    expect(seen[0]!.system).toBe(JUDGE_SYSTEM_PROMPT);
    expect(result.output).toEqual(output);
    expect(result.usage.costUsd).toBe(0.05);
    expect(result.error).toBeUndefined();
  });

  it("skips the call when the run has no final answer", async () => {
    const { call, seen } = fakeCall(null);
    const noAnswer = makeRun(H0, question.question, null);

    const result = await makeJudge(call, "judge-model")(question, noAnswer, passages);

    expect(seen).toHaveLength(0);
    expect(result.usage.costUsd).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("skips the call for an answer with no claims to a question with no expected points", async () => {
    const { call, seen } = fakeCall(null);
    const decline = makeQuestion({ expected_behaviour: "decline", expected_points: [] });
    const declined = makeRun(H0, decline.question, makeAnswer([], { status: "declined" }));

    await makeJudge(call, "judge-model")(decline, declined, passages);
    expect(seen).toHaveLength(0);
  });

  it("returns an error when the call fails", async () => {
    const { call } = fakeCall(null, "overloaded");
    const result = await makeJudge(call, "judge-model")(question, run, passages);
    expect(result.output).toBeNull();
    expect(result.error).toBe("overloaded");
  });

  it("returns an error when the judge leaves out a claim", async () => {
    const output = allGoodJudgeOutput(question, answer);
    output.claims.pop();
    const { call } = fakeCall(output);

    const result = await makeJudge(call, "judge-model")(question, run, passages);
    expect(result.output).toBeNull();
    expect(result.error).toMatch(/each of the 2 claims once/);
  });

  it("returns an error instead of throwing when the call throws", async () => {
    const call: StructuredCall = async () => {
      throw new Error("network down");
    };
    const result = await makeJudge(call, "judge-model")(question, run, passages);
    expect(result.output).toBeNull();
    expect(result.error).toBe("network down");
  });
});

describe("judgeSchema", () => {
  it("has no number limits, which structured output does not accept", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(judgeSchema));
    expect(jsonSchema).not.toContain("minimum");
    expect(jsonSchema).not.toContain("maximum");
  });
});

describe("eval/rubric.md", () => {
  const rubric = readFileSync(new URL("../../eval/rubric.md", import.meta.url), "utf8");

  it("holds the judge's instructions word for word", () => {
    expect(rubric).toContain(JUDGE_SYSTEM_PROMPT);
  });

  it("holds the rule for the headline setups word for word", () => {
    for (const line of HEADLINE_RULE) expect(rubric).toContain(line);
  });

  it("says it was fixed before any results existed", () => {
    expect(rubric).toContain("before any results existed");
  });
});
