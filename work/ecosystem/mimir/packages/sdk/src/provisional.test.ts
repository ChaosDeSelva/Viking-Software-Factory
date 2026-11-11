import { describe, expect, it } from "vitest";
import { AttentionResponseSchema, TerminalReadResponseSchema } from "./provisional.js";

const issuesOf = (r: { success: boolean; error?: unknown }) =>
  r.success ? [] : (r.error as { issues: { path: unknown[]; message: string }[] }).issues;

describe("TerminalReadResponseSchema", () => {
  it("keeps the known fields and strips unknown ones", () => {
    expect(
      TerminalReadResponseSchema.safeParse({
        text: "$ ls",
        provenance: "observed",
        capturedAt: "2026-01-01T00:00:00Z",
        extra: 1,
      }),
    ).toEqual({
      success: true,
      data: { text: "$ ls", provenance: "observed", capturedAt: "2026-01-01T00:00:00Z" },
    });
    expect(TerminalReadResponseSchema.safeParse({ text: "" })).toEqual({
      success: true,
      data: { text: "" },
    });
  });

  it("rejects a non-object, a missing text, a wrong provenance and a non-string capturedAt", () => {
    expect(issuesOf(TerminalReadResponseSchema.safeParse([]))).toEqual([
      { path: [], message: "expected object", code: "invalid_type" },
    ]);
    const r = TerminalReadResponseSchema.safeParse({ provenance: "derived", capturedAt: 5 });
    expect(r.success).toBe(false);
    expect(issuesOf(r).map((i) => [i.path, i.message])).toEqual([
      [["text"], "expected string"],
      [["provenance"], 'expected "observed"'],
      [["capturedAt"], "expected string or absent"],
    ]);
  });
});

describe("AttentionResponseSchema", () => {
  it("accepts items with optional links, dropping unknown keys", () => {
    expect(
      AttentionResponseSchema.safeParse({
        items: [
          { id: "a1", kind: "approval", title: "Decide", approvalId: "apr_1", junk: true },
          { id: "a2", kind: "stuck", title: "Stuck", detail: "d", sessionId: "ses_1" },
        ],
      }),
    ).toEqual({
      success: true,
      data: {
        items: [
          { id: "a1", kind: "approval", title: "Decide", approvalId: "apr_1" },
          { id: "a2", kind: "stuck", title: "Stuck", detail: "d", sessionId: "ses_1" },
        ],
      },
    });
  });

  it("rejects a body without an items array", () => {
    expect(issuesOf(AttentionResponseSchema.safeParse(null))).toEqual([
      { path: ["items"], message: "expected an array", code: "invalid_type" },
    ]);
    expect(AttentionResponseSchema.safeParse({ items: {} }).success).toBe(false);
  });

  it("reports each bad item by index", () => {
    const r = AttentionResponseSchema.safeParse({
      items: ["x", { id: 1, kind: "nope", title: "t", taskId: 2 }],
    });
    expect(issuesOf(r).map((i) => i.path)).toEqual([
      ["items", 0],
      ["items", 1, "kind"],
      ["items", 1, "id"],
      ["items", 1, "taskId"],
    ]);
  });
});
