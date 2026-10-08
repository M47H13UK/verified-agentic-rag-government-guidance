// The local page for labelling the judge audit sheet by hand. Run with `npm run judge:check`.
//   npm run judge:check -- --port 4180 --file eval/judge-audit.csv --no-open
//
// The judge's own labels are in the key file next to the sheet. This server never opens that
// file, because the person labelling must not see what the judge decided.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AUDIT_CSV_PATH } from "../src/eval/judgeAudit";
import { cleanLabel, readSheet, setLabel, sheetItems, writeSheet } from "./lib/auditSheet";

/** A label is a few bytes of JSON. A body anywhere near this size is a mistake. */
const MAX_BODY_BYTES = 10 * 1024;
const HTML_FILE = new URL("./judge-audit.html", import.meta.url);
const ITEM_PREFIX = "/api/items/";

const { values: flags } = parseArgs({
  options: {
    port: { type: "string", default: "4175" },
    file: { type: "string", default: AUDIT_CSV_PATH },
    "no-open": { type: "boolean", default: false },
  },
});

const port = Number(flags.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`"${flags.port}" is not a port number.`);
  process.exit(1);
}
const origin = `http://127.0.0.1:${port}`;

// The key file ends in .json. Taking only a .csv file means --file can never point at it.
if (!flags.file.endsWith(".csv")) {
  console.error(`"${flags.file}" is not a .csv file. Pass the sheet that audit-sample wrote.`);
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
  console.log(`Judge audit page at ${origin}`);
  console.log(
    existsSync(flags.file)
      ? `Sheet ${flags.file}.`
      : `${flags.file} does not exist yet. Run \`npm run eval -- audit-sample\` first.`,
  );
  console.log("Press Ctrl+C to stop.");
  if (!flags["no-open"]) {
    // `open` is the macOS command. On another system, open the address by hand.
    execFile("open", [origin], (error) => {
      if (error) console.log("Could not open the browser. Open the address above by hand.");
    });
  }
});

// ---------- HTTP ----------

/** What a route returns. Every API reply is JSON. An error is `{ error: "..." }`. */
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
    sendJson(response, await route(request, url));
  } catch (error) {
    // For example a row that is not in the format audit-sample writes. The page shows the message.
    sendJson(response, fail(500, error instanceof Error ? error.message : String(error)));
  }
}

async function route(request: IncomingMessage, url: URL): Promise<Reply> {
  const { method } = request;
  const path = url.pathname;

  if (method === "GET" && path === "/api/items") {
    // The file is read again on every request. It is the only copy of the labels.
    // A sheet that does not exist yet is not an error. The page then says how to make one.
    const items = existsSync(flags.file) ? sheetItems(readSheet(flags.file)) : [];
    return ok({ file: flags.file, items });
  }

  if (method === "PUT" && path.startsWith(ITEM_PREFIX)) {
    return putLabel(path.slice(ITEM_PREFIX.length), request);
  }

  return fail(404, `No route for ${method} ${path}.`);
}

/**
 * A save sends the label of one row, and the fingerprint of that row as the page loaded it.
 * An empty label clears the cell.
 */
const saveRequestSchema = z.object({ human_label: z.string(), row_hash: z.string() });

/** Writes the label of one row to the sheet. `encodedId` is the row ID as it appears in the address. */
async function putLabel(encodedId: string, request: IncomingMessage): Promise<Reply> {
  let id: string;
  try {
    id = decodeURIComponent(encodedId);
  } catch {
    return fail(400, "The row ID in the address is not valid.");
  }

  const text = await readBody(request);
  if (text === null) return fail(413, "The request body is over 10 KB.");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(400, "The request body is not valid JSON.");
  }
  const parsed = saveRequestSchema.safeParse(value);
  if (!parsed.success) {
    return fail(
      400,
      'The request body must look like { "human_label": "supported", "row_hash": "..." }.',
    );
  }

  // There is no `await` between reading the sheet and writing it, so two requests cannot interleave here.
  const rows = existsSync(flags.file) ? readSheet(flags.file) : [];
  const item = sheetItems(rows).find((candidate) => candidate.id === id);

  // The page labels the row it loaded. If a new sample has replaced the sheet since then, the row
  // with this ID is another claim or answer, and the label would land on the wrong one.
  // So the save is refused when the row is gone or its content is not what the page loaded.
  if (!item || item.row_hash !== parsed.data.row_hash) {
    return fail(
      412,
      `Row ${id} changed in the sheet after this page loaded it. Nothing was saved. The sheet as it is now is shown.`,
    );
  }

  let label: string;
  try {
    label = cleanLabel(item.kind, parsed.data.human_label);
  } catch (error) {
    return fail(400, error instanceof Error ? error.message : String(error));
  }

  writeSheet(flags.file, setLabel(rows, id, label));
  return ok({ id, human_label: label });
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
