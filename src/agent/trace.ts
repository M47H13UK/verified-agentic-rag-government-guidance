import type { HookCallback, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolCallTrace } from "../types";
import { TOOL_PREFIX } from "./tools";

/**
 * Records every call to the two guidance tools during one run.
 *
 * Hooks are the main source. They run in this process at fixed points in the agent loop.
 * The SDK docs warn that hooks may not fire when the turn cap is hit, so the message stream is a
 * second source. `observeMessage` only fills in calls the hooks missed.
 */
export function createTraceRecorder() {
  // A Map keeps insertion order, so the trace comes out in the order the calls started.
  const calls = new Map<string, ToolCallTrace>();
  const finished = new Set<string>();

  function start(id: string, toolName: string, input: unknown): void {
    if (calls.has(id)) return;
    calls.set(id, {
      tool_use_id: id,
      tool: toolName.slice(TOOL_PREFIX.length),
      input,
      ok: false,
      result_chars: 0,
      passage_ids: [],
      duration_ms: null,
      started_at: new Date().toISOString(),
    });
  }

  function finish(id: string, result: unknown, ok: boolean, durationMs: number | null): void {
    const call = calls.get(id);
    if (!call || finished.has(id)) return;
    finished.add(id);
    const text = textOf(result);
    call.ok = ok;
    call.result_chars = text.length;
    call.passage_ids = ok ? passageIdsIn(call.tool, text) : [];
    call.duration_ms = durationMs;
    if (!ok) call.error = text.slice(0, 300);
  }

  // Registered with no matcher, so it runs for every tool call. That includes the SDK's own
  // StructuredOutput call, which carries the final answer and is not one of our tools.
  const hook: HookCallback = async (input, toolUseId) => {
    if (!toolUseId || !("tool_name" in input) || !input.tool_name.startsWith(TOOL_PREFIX))
      return {};

    if (input.hook_event_name === "PreToolUse") {
      start(toolUseId, input.tool_name, input.tool_input);
    } else if (input.hook_event_name === "PostToolUse") {
      start(toolUseId, input.tool_name, input.tool_input);
      // A tool can return normally and still report a failure with `isError`, as read_passage does for an unknown ID.
      finish(
        toolUseId,
        input.tool_response,
        !isErrorResult(input.tool_response),
        input.duration_ms ?? null,
      );
    } else if (input.hook_event_name === "PostToolUseFailure") {
      start(toolUseId, input.tool_name, input.tool_input);
      finish(toolUseId, input.error, false, input.duration_ms ?? null);
    }
    // An empty object means "carry on, change nothing".
    return {};
  };

  const hooks: Options["hooks"] = {
    PreToolUse: [{ hooks: [hook] }],
    PostToolUse: [{ hooks: [hook] }],
    PostToolUseFailure: [{ hooks: [hook] }],
  };

  /** Second source. Assistant messages carry tool calls and user messages carry tool results. */
  function observeMessage(message: SDKMessage): void {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.name.startsWith(TOOL_PREFIX)) {
          start(block.id, block.name, block.input);
        }
      }
    } else if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result") {
          finish(block.tool_use_id, block.content, block.is_error !== true, null);
        }
      }
    }
  }

  return { hooks, observeMessage, trace: (): ToolCallTrace[] => [...calls.values()] };
}

/** A tool result is a string, a list of content blocks, or an object holding such a list. */
function textOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((block) => (isTextBlock(block) ? block.text : JSON.stringify(block)))
      .join("\n");
  }
  if (isRecord(result) && Array.isArray(result.content)) return textOf(result.content);
  return JSON.stringify(result ?? "");
}

function isErrorResult(result: unknown): boolean {
  return isRecord(result) && (result.isError === true || result.is_error === true);
}

/**
 * Both tools return JSON. Search returns a list of hits and read returns one passage.
 * The passage IDs are pulled out here so the eval can tell whether the agent ever saw the right page.
 */
function passageIdsIn(tool: string, text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    const items = tool === "search_guidance" && Array.isArray(parsed) ? parsed : [parsed];
    return items.flatMap((item) =>
      isRecord(item) && typeof item.passage_id === "string" ? [item.passage_id] : [],
    );
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}
