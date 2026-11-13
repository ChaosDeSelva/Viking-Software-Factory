import { FakeProvider } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { FakeDeliveryWorld, planTaskView, planView } from "../gates/fakes.js";
import { GateRunner, repairContract } from "../gates/gate-runner.js";
import type { ContextReader, PlanView, PrReviewView } from "../gates/ports.js";
import { checkResearch, citationIds, withoutSourceLists } from "../gates/research.js";
import { DeliveryError, DeliveryReports } from "../report/delivery-report.js";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";

const GOOD_DOC = [
  "## Answer",
  "Retries back off [1].",
  "## Findings",
  "See [1].",
  "## Open questions",
  "None.",
  "## Sources",
  "[1] https://example.com/retry",
].join("\n");
const SOURCES = JSON.stringify([{ id: "1", kind: "url", ref: "https://example.com/retry" }]);

const context: ContextReader = {
  spec: (id) =>
    Promise.resolve({
      id,
      lineageId: "spl_1",
      version: 1,
      status: "approved",
      title: "Retries",
      intakeId: null,
      acceptanceCriteria: [{ id: "AC-1", text: "Answer it", verification: "manual" }],
    }),
  intake: () => Promise.resolve(undefined),
};

/** A stored plan as Sindri keeps it. */
const storedPlan = (tasks: PlanView["tasks"], work: NonNullable<PlanView["work"]>): PlanView =>
  planView(tasks, { work });

const RESEARCH = {
  kind: "research" as const,
  research: { sources: { code: false, feedbackGraph: false, web: true }, factCheck: false },
};

function researchWorld(document: string) {
  const plan = storedPlan(
    [planTaskView("research", { role: "investigator", maxRetries: 2 })],
    RESEARCH,
  );
  const w = new FakeDeliveryWorld(plan);
  w.addTask("research", "mt_res", "crw_inv", { template: "investigator" });
  w.artifact("mt_res", "report", document, { name: "research.md" });
  w.artifact("mt_res", "file", SOURCES, { name: "sources.json" });
  const db = openDeliveryTestDb();
  const gates = new GateRunner({
    db,
    executions: w,
    mimir: w,
    content: w,
    gatesFor: () => [{ id: "research", kind: "research", required: true }],
  });
  const reports = new DeliveryReports({
    db,
    executions: w,
    mimir: w,
    content: w,
    context,
    provider: new FakeProvider(() => {
      throw new Error("no model");
    }),
    gates,
    reviews: { list: () => [] },
  });
  return { w, gates, reports };
}

describe("citations never come from the source list", () => {
  it("drops Sources and References sections, up to the next heading of that level", () => {
    const doc = "## Answer\nA [1].\n## Sources\n[1] x\n### Notes\n[2] y\n## After\nB [3].";
    expect(withoutSourceLists(doc)).toBe("## Answer\nA [1].\n## After\nB [3].");
    expect(citationIds(doc)).toEqual(["1", "3"]);
    expect(citationIds("## Answer\nNo citation.\n## References\n[1] x")).toEqual([]);
  });

  it("fails no_citations when only the Sources list has numbers, and ignores its ids", async () => {
    const doc = GOOD_DOC.replace("Retries back off [1].", "Retries back off.")
      .replace("See [1].", "See above.")
      .concat("\n[9] https://example.com/other");
    const { failures } = await checkResearch({
      artifacts: {
        document: { text: doc, artifactId: "a1" },
        sources: { text: SOURCES, artifactId: "a2" },
      },
      allowed: { code: false, feedbackGraph: false, web: true },
      lessonRefs: new Set(),
    });
    const reasons = failures.map((f) => f.reason);
    expect(reasons).toContain("no_citations");
    expect(reasons).not.toContain("citation_unresolved:9");
  });
});

describe("repair tasks keep the task's mode and brief contract", () => {
  it("research: a read-only document repair with the original brief", async () => {
    const { w, gates } = researchWorld("## Answer\nNo sections [1].");
    const outcome = await gates.enforce(w.executionId, "research");
    expect(outcome.action).toBe("repair_task_created");
    const create = w.calls.find((c) => c.method === "createTask")!.args[0] as {
      mode?: unknown;
      instruction: string;
    };
    expect(create.mode).toEqual({ deliverable: "document", access: "read", network: "web" });
    expect(create.instruction).toContain("section_missing");
    expect(create.instruction).toContain(".mimir/artifacts/research.md");
  });

  it("pr_review: document/read/none, never write", () => {
    const pr: PrReviewView = {
      owner: "o",
      repo: "r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "t",
      body: "",
      author: null,
      baseRef: "main",
      headRef: "f",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      isCrossRepository: false,
      files: [],
      filesOmitted: 0,
      nonce: "abc123",
    };
    const tasks = [planTaskView("pr-review", { role: "reviewer" })];
    const plan = storedPlan(tasks, { kind: "pr_review", prReview: pr });
    const contract = repairContract(plan, tasks[0]!);
    expect(contract?.mode).toEqual({ deliverable: "document", access: "read", network: "none" });
    expect(contract?.brief).toContain(".mimir/artifacts/review.json");
    // A stored plan that is not a valid plan gives no contract.
    expect(repairContract({ ...plan, tasks: [] }, tasks[0]!)).toBeNull();
  });
});

describe("repairs without a contract", () => {
  it("escalate with repair_contract_unavailable and spend no attempt", async () => {
    const { w, gates } = researchWorld("## Answer\nNo sections [1].");
    (w.plan as { tasks: unknown[] }).tasks = [{ ...w.plan.tasks[0]!, objective: "" }];
    const outcome = await gates.enforce(w.executionId, "research");
    expect(outcome).toMatchObject({ action: "escalated", error: "repair_contract_unavailable" });
    expect(w.calls.some((c) => c.method === "createTask")).toBe(false);
    expect(w.execTasks[0]!.attempts).toBe(0);
  });
});

describe("reports read the task lineage the gates read", () => {
  it("shows the repaired document, and which task recorded it", async () => {
    const { w, gates, reports } = researchWorld("## Answer\nBroken [1].");
    const outcome = await gates.enforce(w.executionId, "research");
    const repairId = outcome.repairTaskId!;
    w.artifact(repairId, "report", GOOD_DOC, { name: "research.md" });
    w.artifact(repairId, "file", SOURCES, { name: "sources.json" });
    expect((await gates.evaluate(w.executionId, "research")).passed).toBe(true);
    const report = await reports.build(w.executionId);
    expect(report.research!.document).toMatchObject({ markdown: GOOD_DOC, taskId: repairId });
    expect(report.research!.gate?.passed).toBe(true);
  });
});

describe("document decisions", () => {
  it("lets exactly one of two concurrent decisions win", async () => {
    const { w, gates, reports } = researchWorld(GOOD_DOC);
    await gates.evaluate(w.executionId, "research");
    const results = await Promise.allSettled([
      reports.decide(w.executionId, { decision: "accepted", actor: "a" }),
      reports.decide(w.executionId, { decision: "rejected", actor: "b", reason: "no" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toBeInstanceOf(DeliveryError);
    expect(lost[0]!.reason).toMatchObject({
      code: "already_decided",
      details: { decision: { decision: "accepted", actor: "a" } },
    });
  });
});
