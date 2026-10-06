import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Db } from "mongodb";
import { z } from "zod";
import { readPassage } from "../tools/readPassage";
import { DEFAULT_K, searchGuidance } from "../tools/searchGuidance";

/**
 * The key used in `mcpServers`. It becomes part of each tool's full name,
 * `mcp__<server>__<tool>`, so it is defined once here.
 */
export const SERVER_NAME = "guidance";
export const TOOL_PREFIX = `mcp__${SERVER_NAME}__`;

/** Both tools must be listed in `allowedTools`, because MCP tools need explicit permission. */
export const ALLOWED_TOOLS = [`${TOOL_PREFIX}search_guidance`, `${TOOL_PREFIX}read_passage`];

/**
 * Wraps the two plain functions in `src/tools/` as tools on an MCP server that runs inside this process.
 * The functions know nothing about the SDK, so another backend could wrap them a different way.
 * A new server is made for each run, so runs that happen at the same time do not share one.
 */
export function createGuidanceServer(db: Db) {
  const searchTool = tool(
    "search_guidance",
    "Keyword search over the stored GOV.UK visa guidance. Returns the best matching passages, each with its passage ID, page title, heading path, link, last updated date and a snippet of about 80 words. Snippets are for choosing what to read. Read a passage in full before quoting it.",
    {
      query: z.string().describe("A few key words, for example: graduate visa how long"),
      k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`How many passages, default ${DEFAULT_K}.`),
    },
    async ({ query, k }) => {
      const hits = await searchGuidance(db, query, k);
      return { content: [{ type: "text", text: JSON.stringify(hits) }] };
    },
    // Both tools only read, so the SDK may run several calls at once.
    { annotations: { readOnlyHint: true } },
  );

  const readTool = tool(
    "read_passage",
    "Returns the full text of one passage, plus the IDs of the passages before and after it in the same part of the page.",
    { passage_id: z.string().describe("For example: /graduate-visa#overview#2") },
    async ({ passage_id }) => {
      const passage = await readPassage(db, passage_id);
      if (!passage) {
        // isError lets the model read the message and try again with a real ID. It does not stop the run.
        return {
          content: [
            {
              type: "text",
              text: `No passage with ID "${passage_id}". Use an ID from search_guidance.`,
            },
          ],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(passage, null, 2) }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({ name: SERVER_NAME, version: "1.0.0", tools: [searchTool, readTool] });
}
