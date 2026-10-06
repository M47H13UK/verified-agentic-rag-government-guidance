// The local page for checking the gold set by hand. Run with `npm run gold:check`.
//   npm run gold:check -- --port 4180 --name "Your Name" --no-open
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { Db } from "mongodb";
import { z } from "zod";
import { closeDb, getDb } from "../src/db";
import { loadEnv } from "../src/env";
import { findPassagesForSource, lintWithDb } from "../src/eval/lint";
import {
  describeIssues,
  loadQuestions,
  questionSchema,
  saveQuestions,
} from "../src/eval/questions";
import { getPassagesById } from "../src/tools/readPassage";
import { searchGuidance } from "../src/tools/searchGuidance";
import { AUDIO_DIR, audioFileName } from "./lib/goldAudio";

loadEnv();

/** A question is a few kilobytes of JSON. A body anywhere near this size is a mistake. */
const MAX_BODY_BYTES = 100 * 1024;
const HTML_FILE = new URL("./gold-check.html", import.meta.url);
const QUESTION_PREFIX = "/api/questions/";
const REVIEW_LOG_NAME = "review-log.json";

const { values: flags } = parseArgs({
  options: {
    port: { type: "string", default: "4174" },
    name: { type: "string" },
    file: { type: "string", default: "eval/questions.jsonl" },
    "no-open": { type: "boolean", default: false },
  },
});

const port = Number(flags.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`"${flags.port}" is not a port number.`);
  process.exit(1);
}
const origin = `http://127.0.0.1:${port}`;

// The name is written to `verified_by` when a question is marked verified.
const verifier = (flags.name ?? gitUserName()).trim();
if (verifier === "") {
  console.error('No name to verify with. Pass --name "Your Name" or set git config user.name.');
  process.exit(1);
}

let db: Db;
try {
  // Fail now with a clear message when the file has a bad line or MongoDB is not running.
  loadQuestions(flags.file);
  db = await getDb();
} catch (error) {
  console.error(String(error));
  await closeDb();
  process.exit(1);
}

const server = createServer((request, response) => {
  void handle(request, response);
});

server.on("error", (error) => {
  console.error(`Could not start the server on port ${port}. Try another one with --port.`);
  console.error(String(error));
  process.exit(1);
});

// The page can change a file on this machine, so the server binds to localhost only.
// No other machine on the network can reach it.
server.listen(port, "127.0.0.1", () => {
  console.log(`Gold set check page at ${origin}`);
  console.log(
    `Questions file ${flags.file}, database "${db.databaseName}", verifying as "${verifier}".`,
  );
  console.log("Press Ctrl+C to stop.");
  if (!flags["no-open"]) {
    // `open` is the macOS command. On another system, open the address by hand.
    execFile("open", [origin], (error) => {
      if (error) console.log("Could not open the browser. Open the address above by hand.");
    });
  }
});

// Ctrl+C sends SIGINT. The database connection is closed before the process ends.
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function stop(): Promise<void> {
  await closeDb();
  process.exit(0);
}

/** The name from `git config user.name`, or an empty string when git has none. */
function gitUserName(): string {
  try {
    return execFileSync("git", ["config", "user.name"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

// ---------- HTTP ----------

/** What a route returns. Every API reply is JSON, except a clip from `/api/audio`. An error is `{ error: "..." }`. */
type Reply = { status: number; body: unknown };

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function fail(status: number, message: string): Reply {
  return { status, body: { error: message } };
}

function sendJson(response: ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    "Content-Type": "application/json; charset=utf-8",
    // The file can change between two requests, so the browser must not reuse an old reply.
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(reply.body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    // Binding to localhost stops other machines. It does not stop a website open in this browser,
    // which can point its own domain name at 127.0.0.1 and then call this API.
    // Such a request names that domain in its Host header, so anything but this server's address is refused.
    const host = request.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      sendJson(response, fail(403, "This server only answers requests made to localhost."));
      return;
    }

    const url = new URL(request.url ?? "/", origin);
    if (request.method === "GET" && url.pathname === "/") {
      // Read from disk on every request, so an edit to the HTML shows after a reload.
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(readFileSync(HTML_FILE));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/audio") {
      // The one route that does not answer with JSON when it succeeds.
      const clip = readClip((url.searchParams.get("id") ?? "").trim());
      if (Buffer.isBuffer(clip)) sendClip(request, response, clip);
      else sendJson(response, clip);
      return;
    }
    sendJson(response, await route(request, url));
  } catch (error) {
    // For example a bad line in the questions file. The page shows the message.
    sendJson(response, fail(500, String(error)));
  }
}

async function route(request: IncomingMessage, url: URL): Promise<Reply> {
  const { method } = request;
  const path = url.pathname;
  const param = (name: string) => (url.searchParams.get(name) ?? "").trim();

  if (method === "GET" && path === "/api/questions") {
    // The file is read again on every request. It is the only copy of the questions,
    // so an edit made in an editor or by git is picked up.
    const questions = loadQuestions(flags.file);
    const problems = await lintWithDb(db, questions);
    const reviews = loadReviews();
    // The key is left out when there is no review log. The page then sorts its queue by the notes alone.
    return ok({ file: flags.file, verifier, questions, problems, ...(reviews && { reviews }) });
  }

  if (method === "GET" && path === "/api/passages") {
    const source = param("source");
    if (source === "")
      return fail(400, 'Give a gold source, for example "?source=/graduate-visa".');
    return ok(await findPassagesForSource(db, source));
  }

  if (method === "GET" && path === "/api/passage") {
    const id = param("id");
    if (id === "") return fail(400, "Give a passage ID in the id parameter.");
    const passage = (await getPassagesById(db, [id])).get(id);
    return passage ? ok(passage) : fail(404, `No passage with ID "${id}".`);
  }

  if (method === "GET" && path === "/api/search") {
    return ok(await searchGuidance(db, param("q")));
  }

  if (method === "PUT" && path.startsWith(QUESTION_PREFIX)) {
    return putQuestion(path.slice(QUESTION_PREFIX.length), request);
  }

  return fail(404, `No route for ${method} ${path}.`);
}

/** What the model reviews said about one question before the hand check. One entry of the review log. */
const reviewSchema = z.object({
  id: z.string(),
  bundle_review: z.string(),
  corpus_review: z.string(),
  decision: z.string(),
  summary: z.string(),
});
const reviewLogSchema = z.object({ reviews: z.array(reviewSchema) });
type Review = Omit<z.infer<typeof reviewSchema>, "id">;

/**
 * Reads the review log from the folder of the questions file and returns its entries by question ID.
 * The log is extra help for the person checking, so the page must work without it.
 * A missing or unreadable file gives null and is not an error.
 */
function loadReviews(): Record<string, Review> | null {
  try {
    const path = join(dirname(flags.file), REVIEW_LOG_NAME);
    const log = reviewLogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return Object.fromEntries(log.reviews.map(({ id, ...review }) => [id, review]));
  } catch {
    return null;
  }
}

/** A save sends the question as edited, and the question as the page loaded it. */
const saveRequestSchema = z.object({ question: questionSchema, loaded: questionSchema });

/** Replaces one question in the file. `encodedId` is the ID as it appears in the address. */
async function putQuestion(encodedId: string, request: IncomingMessage): Promise<Reply> {
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return fail(400, "The question ID in the address is not valid.");
  }

  const text = await readBody(request);
  if (text === null) return fail(413, "The request body is over 100 KB.");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(400, "The request body is not valid JSON.");
  }
  const parsed = saveRequestSchema.safeParse(value);
  if (!parsed.success) return fail(400, describeIssues(parsed.error));
  const { question: edited, loaded } = parsed.data;

  // There is no `await` between loading and saving, so two requests cannot interleave here.
  const questions = loadQuestions(flags.file);
  const index = questions.findIndex((question) => question.id === id);
  if (index === -1) return fail(404, `No question with ID "${id}".`);

  // The page works on the copy it loaded. If the file has changed since then, for example by an
  // edit in an editor, saving that copy would quietly undo the change. So the save is refused.
  if (JSON.stringify(loaded) !== JSON.stringify(questions[index])) {
    return fail(
      412,
      `Question ${id} changed in the file after this page loaded it. The new version is now shown. Check it again.`,
    );
  }

  // The ID can be edited too. The new one must not belong to another question.
  if (questions.some((question, i) => i !== index && question.id === edited.id)) {
    return fail(409, `Another question already has the ID "${edited.id}".`);
  }

  questions[index] = edited;
  saveQuestions(flags.file, questions);
  return ok(edited);
}

/** Reads a request body as text. Returns null when it is larger than the limit. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    // Past the limit the rest is read and thrown away. Memory stays small,
    // and the client still gets a JSON error instead of a dropped connection.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  return size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8");
}

// ---------- Audio ----------

/**
 * The recorded clip of a question, or the 404 to send when there is none.
 * The path is built from a hash of the question text and from nothing in the request,
 * so no request can name a file outside the audio folder.
 */
function readClip(id: string): Buffer | Reply {
  const question = loadQuestions(flags.file).find((q) => q.id === id);
  if (!question) return fail(404, `No question with ID "${id}".`);
  try {
    return readFileSync(join(AUDIO_DIR, audioFileName(question.question)));
  } catch {
    return fail(
      404,
      `Question ${id} has no recorded clip. \`npm run gold:audio\` records the missing ones.`,
    );
  }
}

/**
 * Sends a clip as WAV audio. Safari only plays audio from a server that answers range requests,
 * so a request for a range of bytes gets that part with status 206.
 */
function sendClip(request: IncomingMessage, response: ServerResponse, clip: Buffer): void {
  const headers = {
    "Content-Type": "audio/wav",
    // The clip of a question changes when its text does, so the browser must not keep an old one.
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range) {
    response.writeHead(200, { ...headers, "Content-Length": clip.length });
    response.end(clip);
    return;
  }

  const [, first = "", last = ""] = range;
  const start = Number(first);
  // "bytes=100-" asks for everything from byte 100 to the end.
  const end = last === "" ? clip.length - 1 : Math.min(Number(last), clip.length - 1);
  if (start > end) {
    response.writeHead(416, { "Content-Range": `bytes */${clip.length}` });
    response.end();
    return;
  }
  response.writeHead(206, {
    ...headers,
    "Content-Range": `bytes ${start}-${end}/${clip.length}`,
    "Content-Length": end - start + 1,
  });
  response.end(clip.subarray(start, end + 1));
}
