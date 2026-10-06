import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { createMockDeps, mockRun } from "../src/server/mock";
import type { ErrorResponse, RunResponse, SetupsResponse } from "../src/server/types";
import { paretoFrontier } from "../src/eval/frontier";
import { SETUPS } from "../src/eval/setups";
import type { EvalSummary } from "../src/eval/types";
import { samplePassages } from "./helpers/fixtures";

/** Sends a question to POST /api/ask. `app.request` calls the app directly, with no network. */
function ask(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ask", () => {
  it("returns the run and the passages it cites", async () => {
    const app = createApp(createMockDeps());

    const response = await ask(app, { question: "How long does a Graduate visa last?" });
    expect(response.status).toBe(200);
    const { run, passages } = (await response.json()) as RunResponse;

    // No setup was named, so the default is used.
    expect(run.setup.id).toBe("OM1");
    expect(run.final_answer?.status).toBe("answered");
    expect(run.final_verdicts.map((v) => v.verdict)).toEqual([
      "supported",
      "supported",
      "partially_supported",
    ]);
    expect(run.draft.trace).toHaveLength(4);
    expect(run.verification?.dropped_by_verifier).toBe(1);
    expect(run.verification?.repair_ran).toBe(true);

    // Every cited passage comes back once, with what the page shows next to a quote.
    const citedIds = run.final_answer?.claims.flatMap((c) => c.citations.map((x) => x.passage_id));
    expect(passages.map((p) => p.id).sort()).toEqual([...new Set(citedIds)].sort());
    expect(passages[0]).toMatchObject({
      title: "Graduate visa",
      url: expect.stringContaining("https://www.gov.uk/graduate-visa"),
      updated: "2024-10-31T17:01:07+00:00",
    });
  });

  it("stores the run so it can be fetched by ID", async () => {
    const app = createApp(createMockDeps());
    const asked = await ask(app, { question: "How long does a Graduate visa last?" });
    const { run } = (await asked.json()) as RunResponse;

    const response = await app.request(`/api/runs/${run._id}`);
    expect(response.status).toBe(200);
    const fetched = (await response.json()) as RunResponse;
    expect(fetched.run._id).toBe(run._id);
    expect(fetched.passages.length).toBeGreaterThan(0);
  });

  it("leaves the verdicts empty when the setup has the verifier off", async () => {
    const app = createApp(createMockDeps());
    const response = await ask(app, {
      question: "How long does a Graduate visa last?",
      setup_id: "H0",
    });
    const { run } = (await response.json()) as RunResponse;

    expect(run.verification).toBeNull();
    expect(run.final_verdicts).toEqual([]);
    expect(run.final_answer?.claims).toHaveLength(4);
  });

  it("accepts a setup whose ID has a hyphen", async () => {
    const app = createApp(createMockDeps());
    const response = await ask(app, {
      question: "How long does a Graduate visa last?",
      setup_id: "H5-1",
    });
    expect(response.status).toBe(200);
    const { run } = (await response.json()) as RunResponse;
    expect(run.setup).toEqual({ id: "H5-1", model: "claude-haiku-5-5", verifier: true });
  });

  it("rejects an empty question", async () => {
    const app = createApp(createMockDeps());
    for (const body of [{ question: "   " }, {}, "not an object"]) {
      const response = await ask(app, body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorResponse).error).toBeTruthy();
    }
  });

  it("rejects a question over 500 characters", async () => {
    const app = createApp(createMockDeps());
    expect((await ask(app, { question: "a".repeat(500) })).status).toBe(200);
    expect((await ask(app, { question: "a".repeat(501) })).status).toBe(400);
  });

  it("rejects an unknown setup", async () => {
    const app = createApp(createMockDeps());
    const response = await ask(app, { question: "How long does it last?", setup_id: "NOPE" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ErrorResponse).error).toContain("Unknown setup");
  });

  it("answers 500 with a short message and no stack trace when the agent throws", async () => {
    const deps = createMockDeps();
    const app = createApp({
      ...deps,
      answer: async () => {
        throw new Error("secret detail from deep inside");
      },
    });
    // The server logs the error. The log is silenced here to keep the test output clean.
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await ask(app, { question: "How long does a Graduate visa last?" });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Something went wrong on the server." });
    expect(text).not.toContain("secret detail");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("GET /api/runs/:id", () => {
  it("answers 404 for an unknown run", async () => {
    const app = createApp(createMockDeps());
    const response = await app.request("/api/runs/does-not-exist");
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error).toBe("No run with that ID.");
  });
});

describe("GET /api/results", () => {
  it("answers 404 with a clear message when there are no results yet", async () => {
    const app = createApp({ ...createMockDeps(), readSummary: async () => null });
    const response = await app.request("/api/results");
    expect(response.status).toBe(404);
    expect(((await response.json()) as ErrorResponse).error).toContain("No eval results yet");
  });

  it("returns the summary with every setup of the eval", async () => {
    const app = createApp(createMockDeps());
    const response = await app.request("/api/results");
    expect(response.status).toBe(200);
    const summary = (await response.json()) as EvalSummary;
    expect(summary.setups.map((s) => s.setup.id)).toEqual(SETUPS.map((s) => s.id));
    // A setup with no mock scores would show up as a row of zeros.
    for (const setup of summary.setups) {
      expect(setup.correctness).toBeGreaterThan(0);
      expect(setup.cost_per_answer_usd).toBeGreaterThan(0);
    }
    // The frontier and the headline pair follow the same rule as the real report.
    expect(summary.frontier.pareto).toEqual(paretoFrontier(summary.setups));
    expect(summary.frontier.pareto).toContain(summary.frontier.most_accurate);
    expect(summary.frontier.pareto).toContain(summary.frontier.cheapest_accurate);
  });

  it("gives the page both kinds of row and a judge audit to show", async () => {
    const app = createApp(createMockDeps());
    const summary = (await (await app.request("/api/results")).json()) as EvalSummary;

    // Some setups ran three times and the rest once, as in the real eval.
    const repeated = summary.setups.filter((s) => s.repeats > 1);
    const once = summary.setups.filter((s) => s.repeats === 1);
    expect(repeated).toHaveLength(4);
    expect(once).toHaveLength(6);
    for (const setup of repeated) {
      expect(setup.correctness_min).toBeLessThan(setup.correctness_max);
    }
    // With one repeat there is no range, so the lowest and the highest are the value itself.
    for (const setup of once) {
      expect(setup.correctness_min).toBe(setup.correctness);
      expect(setup.correctness_max).toBe(setup.correctness);
      expect(setup.unsupported_claim_rate_min).toBe(setup.unsupported_claim_rate);
      expect(setup.unsupported_claim_rate_max).toBe(setup.unsupported_claim_rate);
    }

    // The audit is there and its numbers add up, so the sentence on the page makes sense.
    const audit = summary.judge_audit;
    if (!audit) throw new Error("The mock summary has no judge audit.");
    expect(audit.labelled).toBe(audit.claims.labelled + audit.answers.labelled);
    expect(audit.agreed).toBe(audit.claims.agreed + audit.answers.agreed);
    expect(audit.agreement_rate).toBeCloseTo(audit.agreed / audit.labelled);
  });
});

describe("GET /api/setups", () => {
  it("lists the setups and says the data is mock", async () => {
    const app = createApp(createMockDeps());
    const response = await app.request("/api/setups");
    const body = (await response.json()) as SetupsResponse;
    expect(body.mock).toBe(true);
    // The hyphen in H5-0 and H5-1 is part of the ID.
    expect(body.setups.map((s) => s.id)).toEqual([
      "H0",
      "H1",
      "H5-0",
      "H5-1",
      "S0",
      "S1",
      "OM0",
      "OM1",
      "OX0",
      "OX1",
    ]);
  });
});

describe("mock run", () => {
  it("quotes the sample passages word for word", () => {
    // Line breaks in a passage become spaces, the same way a quote is written on one line.
    const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
    const passages = new Map(samplePassages().map((p) => [p._id, normalise(p.text)]));

    // With the verifier off, the run keeps all four draft claims.
    const run = mockRun("How long does a Graduate visa last?", {
      id: "H0",
      model: "claude-haiku-4-5",
      verifier: false,
    });
    const citations = run.final_answer?.claims.flatMap((claim) => claim.citations) ?? [];
    expect(citations.length).toBeGreaterThan(0);
    for (const citation of citations) {
      expect(passages.get(citation.passage_id)).toContain(normalise(citation.quote));
    }
  });
});
