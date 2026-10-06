import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Run, Setup } from "../types";
import type { PassageLookup } from "../types";
import type { CitedPassage, RunResponse, ServerDeps, SetupsResponse } from "./types";

/**
 * The setup used when the request does not name one. Opus 5.5 at medium effort with the
 * verifier on, the same default as `npm run ask`.
 */
const DEFAULT_SETUP_ID = "OM1";
const MAX_QUESTION_CHARS = 500;
/** A question is at most 500 characters, so a larger body is never a valid request. */
const MAX_BODY_BYTES = 10_000;

/**
 * Builds the API. Everything it needs from the outside comes in through `deps`,
 * so the real server, the mock server and the tests all use this same function.
 */
export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // Any error a route does not handle ends up here.
  // The details go to the server log. The browser only gets a short message, never a stack trace.
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "Something went wrong on the server." }, 500);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.get("/api/setups", (c) => {
    const body: SetupsResponse = { setups: deps.setups, mock: deps.mock };
    return c.json(body);
  });

  app.post(
    "/api/ask",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "The request is too large." }, 413),
    }),
    async (c) => {
      // A body that is not JSON becomes null, and parseAskInput rejects it.
      const body: unknown = await c.req.json().catch(() => null);
      const input = parseAskInput(body, deps.setups);
      if ("error" in input) {
        return c.json({ error: input.error }, 400);
      }

      const run = await deps.answer(input.question, input.setup);
      try {
        await deps.saveRun(run);
      } catch (error) {
        // The answer has already been paid for, so it is still returned when the save fails.
        console.error("Could not save the run.", error);
      }
      return c.json(await withPassages(run, deps.getPassages));
    },
  );

  app.get("/api/runs/:id", async (c) => {
    const run = await deps.getRun(c.req.param("id"));
    if (!run) {
      return c.json({ error: "No run with that ID." }, 404);
    }
    return c.json(await withPassages(run, deps.getPassages));
  });

  app.get("/api/results", async (c) => {
    const summary = await deps.readSummary();
    if (!summary) {
      return c.json({ error: "No eval results yet. The eval has not been run." }, 404);
    }
    return c.json(summary);
  });

  return app;
}

/** Checks the body of POST /api/ask. Returns the cleaned input, or a message that says what is wrong. */
function parseAskInput(
  body: unknown,
  setups: Setup[],
): { question: string; setup: Setup } | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "The request body must be a JSON object." };
  }
  const { question, setup_id } = body as { question?: unknown; setup_id?: unknown };

  if (typeof question !== "string" || question.trim() === "") {
    return { error: "Type a question first." };
  }
  if (question.trim().length > MAX_QUESTION_CHARS) {
    return { error: `The question is too long. The limit is ${MAX_QUESTION_CHARS} characters.` };
  }

  const setupId = setup_id === undefined ? DEFAULT_SETUP_ID : setup_id;
  const setup = setups.find((s) => s.id === setupId);
  if (!setup) {
    return { error: "Unknown setup. Pick one from the list." };
  }
  return { question: question.trim(), setup };
}

/**
 * Adds the passages that the final answer cites.
 * The page needs them to show a page title, a link and a last-updated date next to each quote.
 */
async function withPassages(run: Run, getPassages: PassageLookup): Promise<RunResponse> {
  const claims = run.final_answer?.claims ?? [];
  const citedIds = claims.flatMap((claim) =>
    claim.citations.map((citation) => citation.passage_id),
  );
  // A Set removes the duplicates when two claims cite the same passage.
  const found = await getPassages([...new Set(citedIds)]);

  const passages: CitedPassage[] = [...found.values()].map((p) => ({
    id: p._id,
    title: p.title,
    heading_path: p.heading_path,
    url: p.url,
    updated: p.updated,
  }));
  return { run, passages };
}
