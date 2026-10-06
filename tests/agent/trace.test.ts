import type { HookInput, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { createTraceRecorder } from "../../src/agent/trace";

// The hooks and the message stream are driven by hand here, so no model is called.

const SEARCH = "mcp__guidance__search_guidance";
const READ = "mcp__guidance__read_passage";
const signal = new AbortController().signal;

/** Builds a hook input with only the fields the recorder reads. */
function hookInput(fields: Record<string, unknown>): HookInput {
  return { session_id: "s", cwd: "/", transcript_path: "", ...fields } as unknown as HookInput;
}

async function fire(
  recorder: ReturnType<typeof createTraceRecorder>,
  id: string,
  fields: Record<string, unknown>,
) {
  const event = fields.hook_event_name as "PreToolUse" | "PostToolUse" | "PostToolUseFailure";
  const hook = recorder.hooks![event]![0]!.hooks[0]!;
  return hook(hookInput(fields), id, { signal });
}

const searchResult = [
  {
    type: "text",
    text: JSON.stringify([
      { passage_id: "/graduate-visa#overview#2", snippet: "A Graduate visa lasts for" },
      { passage_id: "/graduate-visa#overview#3", snippet: "work in most jobs" },
    ]),
  },
];

describe("trace recorder", () => {
  it("records a tool call from the pre and post hooks", async () => {
    const recorder = createTraceRecorder();
    const input = { query: "graduate visa how long" };
    await fire(recorder, "t1", {
      hook_event_name: "PreToolUse",
      tool_name: SEARCH,
      tool_input: input,
    });
    await fire(recorder, "t1", {
      hook_event_name: "PostToolUse",
      tool_name: SEARCH,
      tool_input: input,
      tool_response: searchResult,
      duration_ms: 36,
    });

    expect(recorder.trace()).toEqual([
      expect.objectContaining({
        tool_use_id: "t1",
        tool: "search_guidance",
        input,
        ok: true,
        duration_ms: 36,
        passage_ids: ["/graduate-visa#overview#2", "/graduate-visa#overview#3"],
      }),
    ]);
  });

  it("returns an empty object from the hook, which lets the call go ahead", async () => {
    const recorder = createTraceRecorder();
    const output = await fire(recorder, "t1", {
      hook_event_name: "PreToolUse",
      tool_name: SEARCH,
      tool_input: {},
    });
    expect(output).toEqual({});
  });

  it("ignores the SDK's own StructuredOutput call", async () => {
    const recorder = createTraceRecorder();
    await fire(recorder, "t9", {
      hook_event_name: "PreToolUse",
      tool_name: "StructuredOutput",
      tool_input: { status: "answered" },
    });
    expect(recorder.trace()).toEqual([]);
  });

  it("marks a failed call and keeps the error text", async () => {
    const recorder = createTraceRecorder();
    await fire(recorder, "t2", {
      hook_event_name: "PreToolUse",
      tool_name: READ,
      tool_input: { passage_id: "/nope#body#1" },
    });
    await fire(recorder, "t2", {
      hook_event_name: "PostToolUseFailure",
      tool_name: READ,
      tool_input: { passage_id: "/nope#body#1" },
      error: 'No passage with ID "/nope#body#1".',
    });

    const [call] = recorder.trace();
    expect(call).toMatchObject({ tool: "read_passage", ok: false, passage_ids: [] });
    expect(call!.error).toContain("No passage");
  });

  it("fills in a call from the message stream when no hook fired", () => {
    const recorder = createTraceRecorder();
    const passage = { passage_id: "/graduate-visa#overview#2", text: "A Graduate visa lasts for" };

    recorder.observeMessage({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "t3", name: READ, input: { passage_id: passage.passage_id } },
        ],
      },
    } as unknown as SDKMessage);
    recorder.observeMessage({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t3",
            content: [{ type: "text", text: JSON.stringify(passage) }],
          },
        ],
      },
    } as unknown as SDKMessage);

    expect(recorder.trace()).toEqual([
      expect.objectContaining({
        tool_use_id: "t3",
        tool: "read_passage",
        ok: true,
        // The stream has no timing, so the duration is unknown.
        duration_ms: null,
        passage_ids: ["/graduate-visa#overview#2"],
      }),
    ]);
  });

  it("does not record a call twice when both the hooks and the stream report it", async () => {
    const recorder = createTraceRecorder();
    await fire(recorder, "t4", {
      hook_event_name: "PreToolUse",
      tool_name: SEARCH,
      tool_input: { query: "fees" },
    });
    await fire(recorder, "t4", {
      hook_event_name: "PostToolUse",
      tool_name: SEARCH,
      tool_input: { query: "fees" },
      tool_response: searchResult,
      duration_ms: 12,
    });
    recorder.observeMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "ignored" }] },
    } as unknown as SDKMessage);

    expect(recorder.trace()).toHaveLength(1);
    expect(recorder.trace()[0]!.duration_ms).toBe(12);
  });
});
