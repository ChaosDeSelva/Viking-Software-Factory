import { describe, expect, it } from "vitest";
import type { TraceDocument, TraceNode } from "./delivery-types.js";
import { traceTree } from "./trace-tree.js";

const doc: TraceDocument = {
  schemaVersion: 1,
  delivery: { id: "dlv_1", status: "built", prs: [] },
  ticket: { id: "int_1", title: "CSV export" },
  spec: { id: "s1", version: 2, title: "CSV export for reports", status: "approved" },
  plan: { id: "pl1", version: 1 },
  mission: { id: "msn_1" },
  execution: { id: "e1", status: "verified_pending_review" },
  tasks: [
    {
      planTaskId: "implement-frontend",
      mimirTaskId: "tsk_1",
      role: "implementer",
      status: "completed",
      harness: { id: "frontend-react", version: "1.1.0" },
      gate: { passed: false },
      reviews: [],
      events: [{ id: "evt_1", type: "task.completed", occurredAt: "2026-01-01T00:00:00Z" }],
      artifacts: [{ id: "art_1", kind: "test.output", hash: "sha256:abc" }],
    },
  ],
  reviewTasks: [],
  unattributedEvents: [
    { id: "evt_0", type: "mission.created", occurredAt: "2026-01-01T00:00:00Z" },
  ],
};

const kinds = (n: TraceNode): string[] => [n.kind, ...n.children.flatMap(kinds)];

describe("traceTree", () => {
  it("nests ticket, spec, plan, mission, tasks, events and artifacts", () => {
    const root = traceTree(doc);
    expect(root.kind).toBe("ticket");
    expect(kinds(root)).toEqual([
      "ticket",
      "spec",
      "plan",
      "mission",
      "task",
      "artifact",
      "events",
      "event",
      "events",
      "event",
    ]);
    const task = root.children[0]!.children[0]!.children[0]!.children[0]!;
    expect(task.label).toMatch(/implement-frontend.*completed.*gate failed/);
  });

  it("starts at the spec when there is no ticket", () => {
    expect(traceTree({ ...doc, ticket: null }).kind).toBe("spec");
  });
});
