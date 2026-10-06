// The four calls the page makes to the API.
// Each one returns the parsed JSON, or throws an Error with a message a person can read.
import type { EvalSummary } from "../../src/eval/types";
import type { RunResponse, SetupsResponse } from "../../src/server/types";

/** Sends one request. `fetch` only throws when the network fails, so that case gets its own message. */
async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new Error("Could not reach the API. Check that it is running.");
  }
}

/** Reads the JSON body. On an error status it throws with the message the API sent as `{ error }`. */
async function readJson<T>(response: Response): Promise<T> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const fromApi =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : null;
    // No JSON body usually means the Vite proxy answered because the API is not running.
    throw new Error(
      fromApi ?? `Could not reach the API (status ${response.status}). Check that it is running.`,
    );
  }
  return body as T;
}

export async function getSetups(): Promise<SetupsResponse> {
  return readJson<SetupsResponse>(await send("/api/setups"));
}

export async function ask(question: string, setupId: string): Promise<RunResponse> {
  const response = await send("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, setup_id: setupId }),
  });
  return readJson<RunResponse>(response);
}

export async function getRun(id: string): Promise<RunResponse> {
  return readJson<RunResponse>(await send(`/api/runs/${encodeURIComponent(id)}`));
}

/** Returns null when the eval has not been run yet. The API answers 404 in that case. */
export async function getResults(): Promise<EvalSummary | null> {
  const response = await send("/api/results");
  if (response.status === 404) {
    return null;
  }
  return readJson<EvalSummary>(response);
}
