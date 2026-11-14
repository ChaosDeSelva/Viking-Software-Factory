import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentTranscript, parseAgentStream } from "./transcript.js";

const j = (v: unknown) => JSON.stringify(v);

describe("parseAgentStream", () => {
  it("reads Codex exec --json: one entry per item, its latest state, in order", () => {
    const entries = parseAgentStream([
      j({ type: "thread.started", thread_id: "t" }),
      j({ type: "turn.started" }),
      j({
        type: "item.completed",
        item: { id: "i1", type: "reasoning", text: "**Planning** the search" },
      }),
      j({
        type: "item.started",
        item: {
          id: "i2",
          type: "command_execution",
          command: `/bin/zsh -lc "rg -n 'Config' src"`,
          status: "in_progress",
        },
      }),
      j({
        type: "item.completed",
        item: { id: "i3", type: "agent_message", text: "I found a gap in AC10." },
      }),
      j({
        type: "item.completed",
        item: {
          id: "i2",
          type: "command_execution",
          command: `/bin/zsh -lc "rg -n 'Config' src"`,
          aggregated_output: "src/a.ts:1:Config\n",
          exit_code: 0,
          status: "completed",
        },
      }),
      j({
        type: "item.completed",
        item: {
          id: "i4",
          type: "mcp_tool_call",
          server: "docs",
          tool: "lookup",
          arguments: { q: "x" },
          status: "completed",
        },
      }),
      j({
        type: "item.completed",
        item: {
          id: "i5",
          type: "file_change",
          changes: [{ path: ".mimir/artifacts/research.md", kind: "add" }],
        },
      }),
      j({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 300 } }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual([
      "thinking",
      "command",
      "message",
      "tool",
      "files",
      "done",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "command",
      command: "rg -n 'Config' src",
      output: "src/a.ts:1:Config\n",
      exitCode: 0,
      running: false,
    });
    expect(entries[2]).toMatchObject({ kind: "message", text: "I found a gap in AC10." });
    expect(entries[3]).toMatchObject({ kind: "tool", name: "docs · lookup" });
    expect(entries[4]).toMatchObject({ kind: "files", paths: [".mimir/artifacts/research.md"] });
    expect(entries[5]).toMatchObject({
      kind: "done",
      ok: true,
      detail: "1,200 tokens in · 300 out",
    });
  });

  it("reads Claude stream-json: text, tool calls paired with their results, and the result", () => {
    const entries = parseAgentStream([
      j({ type: "system", subtype: "init", model: "m" }),
      j({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading the handler." },
            { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "src/handler.ts" } },
            { type: "tool_use", id: "tu2", name: "Bash", input: { command: "git log -3" } },
          ],
        },
      }),
      j({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu1", content: "1  export const x = 1" },
            {
              type: "tool_result",
              tool_use_id: "tu2",
              content: [{ type: "text", text: "abc fix" }],
              is_error: true,
            },
          ],
        },
      }),
      j({
        type: "result",
        subtype: "success",
        is_error: false,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(["message", "tool", "command", "done"]);
    expect(entries[1]).toMatchObject({
      kind: "tool",
      name: "Read",
      summary: "src/handler.ts",
      output: "1  export const x = 1",
    });
    expect(entries[2]).toMatchObject({
      kind: "command",
      command: "git log -3",
      output: "abc fix",
      failed: true,
    });
    expect(entries[3]).toMatchObject({ kind: "done", ok: true });
  });

  it("keeps lines that are not agent events as plain text, and reports failures", () => {
    const entries = parseAgentStream([
      "Starting agent…",
      "",
      j({ type: "turn.failed", error: { message: "rate limited" } }),
      "{not json",
    ]);
    expect(entries).toEqual([
      { kind: "text", key: "l0", text: "Starting agent…" },
      { kind: "done", key: "l2", ok: false, detail: "rate limited" },
      { kind: "text", key: "l3", text: "{not json" },
    ]);
  });

  it("joins a Codex event split over terminal lines back together", () => {
    const line = j({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "x".repeat(50) },
    });
    const entries = parseAgentStream([line.slice(0, 30), line.slice(30)]);
    expect(entries).toMatchObject([{ kind: "message", text: "x".repeat(50) }]);
  });
});

describe("AgentTranscript", () => {
  it("shows messages as text, commands with their status, and the raw lines on request", () => {
    render(
      <AgentTranscript
        lines={[
          j({
            type: "item.completed",
            item: { id: "m", type: "agent_message", text: "Drafting the tickets now." },
          }),
          j({
            type: "item.started",
            item: { id: "c", type: "command_execution", command: "ls", status: "in_progress" },
          }),
        ]}
      />,
    );
    expect(screen.getByText("Drafting the tickets now.")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.queryByText(/item\.completed/)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Raw" }));
    expect(screen.getByText(/item\.completed/)).toBeTruthy();
  });

  it("says so when there is nothing yet", () => {
    render(<AgentTranscript lines={[]} empty="Waiting for the agent…" />);
    expect(screen.getByText("Waiting for the agent…")).toBeTruthy();
  });
});
