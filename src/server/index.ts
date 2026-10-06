// Starts the API. `npm run api` uses the real agent. `npm run api:mock` uses canned data.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { createAnswerFn } from "../answer";
import { getDb } from "../db";
import { loadEnv } from "../env";
import { SETUPS } from "../eval/setups";
import type { EvalSummary } from "../eval/types";
import { getRun, saveRun } from "../runs";
import { getPassagesById } from "../tools/readPassage";
import { createApp } from "./app";
import { createMockDeps } from "./mock";
import type { ServerDeps } from "./types";

/**
 * Connects the API to the real parts: the agent and verifier, MongoDB, and the eval summary on disk.
 * `createAnswerFn` is the same function the command line and the eval use.
 */
async function createRealDeps(): Promise<ServerDeps> {
  const db = await getDb();
  return {
    answer: createAnswerFn(db),
    getRun: (id) => getRun(db, id),
    saveRun: (run) => saveRun(db, run),
    getPassages: (ids) => getPassagesById(db, ids),
    readSummary: async () => {
      // The eval report writes this file. Until it exists the page shows "no results yet".
      if (!existsSync(SUMMARY_PATH)) return null;
      return JSON.parse(await readFile(SUMMARY_PATH, "utf8")) as EvalSummary;
    },
    setups: SETUPS,
    mock: false,
  };
}

const SUMMARY_PATH = "results/summary.json";

const mock = process.argv.includes("--mock");
let deps: ServerDeps;
if (mock) {
  // Mock mode never loads .env, so it cannot reach a credential or spend money.
  // The delay makes the loading state of the page visible.
  deps = createMockDeps({ delayMs: 1500 });
} else {
  loadEnv();
  deps = await createRealDeps();
}

const app = createApp(deps);
const port = Number(process.env.API_PORT ?? 8787);

// Only this computer can reach the API. Each call to /api/ask can cost money, so it is not opened to the network.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(
    `API on http://127.0.0.1:${info.port}${mock ? " (mock data, all numbers made up)" : ""}`,
  );
});
