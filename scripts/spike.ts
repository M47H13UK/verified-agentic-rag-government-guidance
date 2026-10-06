// Agent SDK spike. The smallest `query()` that has everything the real agent needs:
// one custom tool on an in-process MCP server, built-in tools off, a structured answer and tracing hooks.
// It exists to answer the points the SDK docs leave open, before anything is built on them.
// The findings are in docs/how-it-works.md, step 4.
//
//   npm run spike
//   npm run spike -- --model claude-opus-5-5 --effort xhigh
//   npm run spike -- --max-turns 1
//   npm run spike -- --always-load --raw
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadEnv } from "../src/env";
import type { Passage } from "../src/types";

loadEnv();

const { values: flags } = parseArgs({
  options: {
    model: { type: "string", default: "claude-haiku-4-5" },
    effort: { type: "string" },
    "max-turns": { type: "string", default: "4" },
    "always-load": { type: "boolean", default: false },
    // Print every message in full instead of one line each.
    raw: { type: "boolean", default: false },
  },
});

// ---------- One custom tool, reading the sample passages (no database needed) ----------

const passages: Passage[] = JSON.parse(readFileSync("data/sample/passages.json", "utf8"));

const readPassage = tool(
  "read_passage",
  "Returns the full text of one guidance passage.",
  { passage_id: z.string().describe("For example /graduate-visa#overview#2") },
  async ({ passage_id }) => {
    const passage = passages.find((p) => p._id === passage_id);
    if (!passage) {
      return {
        content: [{ type: "text", text: `No passage with ID ${passage_id}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: passage.text }] };
  },
  { annotations: { readOnlyHint: true } },
);

// The key in `mcpServers` and this name are kept identical. The key becomes part of the tool name.
const guidance = createSdkMcpServer({
  name: "guidance",
  version: "1.0.0",
  tools: [readPassage],
  ...(flags["always-load"] ? { alwaysLoad: true } : {}),
});

// ---------- The structured answer ----------

const answerSchema = z.object({
  answer: z.string().describe("One sentence."),
  quote: z.string().describe("Words copied exactly from the passage."),
});

// ---------- Hooks with no matcher, so they see every tool call the SDK lets them see ----------

const hookEvents: string[] = [];
const traceHook: HookCallback = async (input) => {
  const toolName = "tool_name" in input ? input.tool_name : "";
  hookEvents.push(`${input.hook_event_name} ${toolName}`);
  return {};
};

// ---------- The run ----------

const options: Options = {
  model: flags.model,
  systemPrompt: "Answer only from the passage the tool returns. Quote it exactly.",
  tools: [], // removes every built-in tool
  mcpServers: { guidance },
  allowedTools: ["mcp__guidance__read_passage"],
  permissionMode: "dontAsk", // never prompts, denies anything not pre-approved
  settingSources: [], // do not load personal or project Claude Code settings
  strictMcpConfig: true, // only the MCP server passed here
  persistSession: false, // one question, nothing to resume
  maxTurns: Number(flags["max-turns"]),
  outputFormat: {
    type: "json_schema",
    schema: z.toJSONSchema(answerSchema, { target: "draft-7" }) as Record<string, unknown>,
  },
  hooks: {
    PreToolUse: [{ hooks: [traceHook] }],
    PostToolUse: [{ hooks: [traceHook] }],
    PostToolUseFailure: [{ hooks: [traceHook] }],
  },
  // Passing `env` replaces the child's environment, so spread process.env to keep PATH and the credential.
  env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  ...(flags.effort ? { effort: flags.effort as Options["effort"] } : {}),
};

const prompt =
  "Read passage /graduate-visa#overview#2 with the tool. How long does a Graduate visa last for someone who applies in 2027?";

console.log(
  `model=${flags.model} effort=${flags.effort ?? "(not set)"} maxTurns=${flags["max-turns"]}`,
);
console.log(`alwaysLoad=${flags["always-load"]}\n`);

try {
  for await (const message of query({ prompt, options })) {
    if (flags.raw) {
      console.log(JSON.stringify(message));
      continue;
    }
    if (message.type === "system" && message.subtype === "init") {
      console.log(`init     apiKeySource=${message.apiKeySource} model=${message.model}`);
      console.log(`         permissionMode=${message.permissionMode}`);
      console.log(`         tools=${JSON.stringify(message.tools)}`);
      console.log(`         mcp_servers=${JSON.stringify(message.mcp_servers)}`);
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          console.log(`assistant tool_use ${block.name} ${JSON.stringify(block.input)}`);
        } else if (block.type === "text") {
          console.log(`assistant text ${JSON.stringify(block.text.slice(0, 120))}`);
        } else {
          console.log(`assistant ${block.type}`);
        }
      }
    } else if (message.type === "user") {
      const content = message.message.content;
      const kinds = Array.isArray(content) ? content.map((block) => block.type).join(",") : "text";
      console.log(`user     ${kinds}`);
    } else if (message.type === "result") {
      console.log(`result   subtype=${message.subtype} num_turns=${message.num_turns}`);
      console.log(
        `         duration_ms=${message.duration_ms} total_cost_usd=${message.total_cost_usd}`,
      );
      console.log(`         usage=${JSON.stringify(message.usage)}`);
      console.log(`         modelUsage=${JSON.stringify(message.modelUsage)}`);
      if (message.subtype === "success") {
        console.log(`         structured_output=${JSON.stringify(message.structured_output)}`);
        console.log(`         parses=${answerSchema.safeParse(message.structured_output).success}`);
      } else {
        console.log(`         errors=${JSON.stringify(message.errors)}`);
      }
    } else {
      const subtype = "subtype" in message ? ` ${String(message.subtype)}` : "";
      console.log(`${message.type}${subtype}`);
    }
  }
} catch (error) {
  // query() throws after it has yielded an error result, for example when the turn cap is hit.
  console.log(`query() threw: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`\nhook events:\n  ${hookEvents.join("\n  ") || "(none)"}`);
