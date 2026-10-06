// Command line entry point.
//   npm run search -- "graduate visa how long"
//   npm run read -- "/graduate-visa#overview#2"
//   npm run ask -- "How long does a Graduate visa last?" --model claude-sonnet-5-5
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createAgentBackend } from "./agent/backend";
import { closeDb, getDb } from "./db";
import { loadEnv } from "./env";
import { printAnswer, printTrace, printUsage } from "./print";
import { saveRun } from "./runs";
import { getPassagesById, readPassage } from "./tools/readPassage";
import { searchGuidance } from "./tools/searchGuidance";
import type { Effort, Run, Setup } from "./types";

loadEnv();

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "claude-haiku-4-5" },
    effort: { type: "string" },
  },
});
const [command, ...rest] = positionals;
const text = rest.join(" ").trim();

try {
  switch (command) {
    case "search":
      await search(text);
      break;
    case "read":
      await read(text);
      break;
    case "ask":
      await ask(text);
      break;
    default:
      console.error(
        'Usage: npm run search -- "<query>"\n       npm run read -- "<passage id>"\n       npm run ask -- "<question>" [--model <id>] [--effort <level>]',
      );
      process.exitCode = 1;
  }
} finally {
  await closeDb();
}

async function search(query: string): Promise<void> {
  const hits = await searchGuidance(await getDb(), query);
  if (hits.length === 0) {
    console.log("No passages matched. Has the corpus been loaded? Run `npm run ingest`.");
    return;
  }
  hits.forEach((hit, index) => {
    console.log(`${index + 1}. ${hit.passage_id}`);
    console.log(`   ${hit.heading_path}`);
    console.log(`   ${hit.url}  (updated ${hit.updated.slice(0, 10)})`);
    console.log(`   ${hit.snippet}\n`);
  });
}

async function read(passageId: string): Promise<void> {
  const passage = await readPassage(await getDb(), passageId);
  if (!passage) {
    console.log(`No passage with ID ${passageId}`);
    return;
  }
  console.log(
    `${passage.heading_path}\n${passage.url}  (updated ${passage.updated.slice(0, 10)})\n`,
  );
  console.log(passage.text);
  console.log(`\nprevious: ${passage.previous_passage_id ?? "none"}`);
  console.log(`next:     ${passage.next_passage_id ?? "none"}`);
}

async function ask(question: string): Promise<void> {
  if (question === "") {
    console.error(
      'Give a question, for example: npm run ask -- "How long does a Graduate visa last?"',
    );
    process.exitCode = 1;
    return;
  }
  const db = await getDb();
  const setup: Setup = {
    id: "cli",
    model: flags.model,
    ...(flags.effort ? { effort: flags.effort as Effort } : {}),
    verifier: false,
  };

  console.log(`Asking ${setup.model}. This takes about 10 to 30 seconds.\n`);
  const draft = await createAgentBackend(db).answer(question, {
    model: setup.model,
    effort: setup.effort,
  });

  // With no verifier yet, the draft is the final answer.
  const run: Run = {
    _id: randomUUID(),
    question,
    setup,
    created_at: new Date().toISOString(),
    draft,
    verification: null,
    final_answer: draft.answer,
    final_verdicts: [],
    total_usage: draft.usage,
    total_latency_ms: draft.latencyMs,
  };
  await saveRun(db, run);

  const cited = draft.answer?.claims.flatMap((c) => c.citations.map((x) => x.passage_id)) ?? [];
  printAnswer(run, await getPassagesById(db, cited));
  printTrace(draft);
  printUsage("Tokens", run.total_usage);
  console.log(`Stored as run ${run._id}`);
}
