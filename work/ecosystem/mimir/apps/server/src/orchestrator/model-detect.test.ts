import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentUnavailableFromOutput, codexThreadModel, modelFromOutput } from "./model-detect.js";

describe("modelFromOutput", () => {
  it("reads Claude Code's model from its init line or an assistant message", () => {
    expect(
      modelFromOutput(
        'noise\n{"type":"system","subtype":"init","model":"claude-opus-5-5","tools":[]}\n',
      ),
    ).toEqual({ model: "claude-opus-5-5" });
    expect(
      modelFromOutput('{"type":"assistant","message":{"model":"claude-sonnet-5-5","content":[]}}'),
    ).toEqual({ model: "claude-sonnet-5-5" });
  });

  it("notes a Codex thread, whose model is in Codex's own log", () => {
    expect(
      modelFromOutput('warning: x\n{"type":"thread.started","thread_id":"01a1db53-7961"}\n'),
    ).toEqual({ codexThread: "01a1db53-7961" });
  });

  it("ignores text that is not JSON and values that are not model names", () => {
    expect(modelFromOutput("Reading additional input from stdin...")).toEqual({});
    expect(modelFromOutput('{"type":"system","model":"two words"}')).toEqual({});
  });
});

describe("codexThreadModel", () => {
  it("finds the thread's log under today's folder and reads its model", () => {
    const home = mkdtempSync(join(tmpdir(), "codex-home-"));
    const now = new Date(2026, 10, 14, 10, 30);
    const dir = join(home, "sessions", "2026", "11", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "rollout-2026-11-14T10-30-43-01a1db53-7961-76e2.jsonl"),
      '{"type":"session_meta"}\n{"type":"turn_context","payload":{"model":"gpt-6.1-sol"}}\n',
    );
    expect(codexThreadModel("01a1db53-7961-76e2", { codexHome: home, now })).toBe("gpt-6.1-sol");
    expect(codexThreadModel("ffffffff-0000", { codexHome: home, now })).toBeNull();
    expect(codexThreadModel("../../etc", { codexHome: home, now })).toBeNull();
  });
});

describe("agentUnavailableFromOutput", () => {
  it("reads Claude Code's weekly limit with its reset time", () => {
    const line = JSON.stringify({
      type: "assistant",
      error: "rate_limit",
      api_error_status: 429,
      api_error: "usage_limit_reached",
      api_error_params: { rate_limit_info: { status: "rejected", resetsAt: 1794870000 } },
      message: { content: [] },
    });
    expect(agentUnavailableFromOutput(line)).toMatchObject({
      kind: "usage_limit",
      until: "2026-11-16T23:00:00.000Z",
    });
    const event = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: { status: "rejected", resetsAt: 1794870000 },
    });
    expect(agentUnavailableFromOutput(event)?.kind).toBe("usage_limit");
    // A rate-limit event that still allowed the request is not a refusal.
    expect(
      agentUnavailableFromOutput(
        JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }),
      ),
    ).toBeNull();
  });

  it("reads Codex's error events and a failed login", () => {
    expect(
      agentUnavailableFromOutput(
        '{"type":"error","message":"You\'ve hit your usage limit. Try again in 3 hours."}',
      )?.kind,
    ).toBe("usage_limit");
    expect(
      agentUnavailableFromOutput('{"type":"turn.failed","error":{"message":"401 Unauthorized"}}')
        ?.kind,
    ).toBe("auth");
    expect(agentUnavailableFromOutput("Error: Not logged in. Please run /login")?.kind).toBe(
      "auth",
    );
  });

  it("does not mistake the task's own work for an unavailable agent", () => {
    expect(
      agentUnavailableFromOutput(
        '{"type":"item.completed","item":{"text":"Added a usage limit check to the API"}}',
      ),
    ).toBeNull();
    expect(agentUnavailableFromOutput("The docs mention a rate limit of 10/s")).toBeNull();
  });
});
