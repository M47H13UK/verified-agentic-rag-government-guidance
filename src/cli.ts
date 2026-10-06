// Command line entry point.
//   npm run search -- "graduate visa how long"
//   npm run read -- "/graduate-visa#overview#2"
import { closeDb, getDb } from "./db";
import { loadEnv } from "./env";
import { readPassage } from "./tools/readPassage";
import { searchGuidance } from "./tools/searchGuidance";

loadEnv();

const [command, ...rest] = process.argv.slice(2);
const text = rest.join(" ").trim();

try {
  switch (command) {
    case "search":
      await search(text);
      break;
    case "read":
      await read(text);
      break;
    default:
      console.error('Usage: npm run search -- "<query>"  or  npm run read -- "<passage id>"');
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
