import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const TRUST_FAKE = { trustedSources: ["fake-mimir"] };

const FINDINGS = (what: string) =>
  [
    "## Answer",
    `${what} has a reports route [1].`,
    "## Findings",
    "Routes live in src/routes.ts [1].",
    "## Open questions",
    "None.",
    "## Sources",
    "[1] src/routes.ts:1",
  ].join("\n");
const SOURCES = JSON.stringify([{ id: "1", kind: "file", ref: "src/routes.ts:1" }]);

const diagram = (kind: string) => ["```mermaid", kind, "  A --> B", "```"].join("\n");
const SECTIONS = [
  "Why",
  "Goal",
  "Out of scope",
  "What exists today",
  "What we're borrowing",
  "Ground rules",
  "Decisions to settle",
  "Tickets",
  "Demo plan",
  "Exit criteria",
  "Risks",
  "Sources",
];
const PROPOSAL = [
  "# Reports page plan",
  ...SECTIONS.flatMap((t) =>
    t === "Goal"
      ? [`## ${t}`, diagram("flowchart LR"), diagram("sequenceDiagram")]
      : t === "Tickets"
        ? [
            `## ${t}`,
            diagram("gantt"),
            diagram("flowchart TD"),
            "### Ticket 0 (spike)",
            "- Decide where it runs",
            "### Ticket 1",
            "- [ ] Add the route (S, app)",
          ]
        : [`## ${t}`, "Text [1]."],
  ),
].join("\n\n");
const ENGINEERING =
  "## Findings by project\n### app\nRoutes [1].\n## Open questions\nNone.\n## Sources\n[1] src/routes.ts:1";

const findingsStep = (what: string) => [
  {
    kind: "complete" as const,
    artifacts: ["report@research.md", "file@sources.json"],
    contents: { "report@research.md": FINDINGS(what), "file@sources.json": SOURCES },
  },
];

async function approvedProposalPlan(flow: MimirFlow) {
  const repo = mkdtempSync(join(tmpdir(), "sindri-docs-site-"));
  const docs = (
    await flow.h.call({
      method: "POST",
      url: "/v1/projects",
      payload: { name: "docs-site", repoPath: repo },
    })
  ).json().project.id as string;
  const intake = (
    await flow.h.call({
      method: "POST",
      url: "/v1/intakes",
      payload: {
        projectId: flow.projectId,
        title: "Plan from the call",
        body: "We talked about the reports page and the docs-site.",
        workKind: "proposal",
        proposal: { referenceProjectIds: [docs], factCheck: false },
      },
    })
  ).json().intake;
  const d = await flow.h.call({
    method: "POST",
    url: "/v1/director/draft",
    payload: { projectId: flow.projectId, intakeId: intake.id, request: "Plan from the call" },
  });
  const a = await flow.h.call({
    method: "POST",
    url: `/v1/specs/${d.json().spec.id}/answer`,
    payload: { questionId: "Q1", answer: "Yes" },
  });
  const specId = a.json().spec.id as string;
  await flow.h.call({ method: "POST", url: `/v1/specs/${specId}/submit`, payload: {} });
  await flow.h.call({
    method: "POST",
    url: `/v1/specs/${specId}/approve`,
    payload: {},
    headers: await flow.h.approvalHeaders(),
  });
  const plan = (
    await flow.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } })
  ).json().plan as { id: string; tasks: { id: string }[] };
  await flow.h.call({ method: "POST", url: `/v1/plans/${plan.id}/submit`, payload: {} });
  const ok = await flow.h.call({
    method: "POST",
    url: `/v1/plans/${plan.id}/approve`,
    payload: {},
    headers: await flow.h.approvalHeaders(),
  });
  expect(ok.statusCode).toBe(200);
  return plan;
}

async function run(flow: MimirFlow, planId: string, tasks: number) {
  const ex = await flow.h.call({ method: "POST", url: "/v1/executions", payload: { planId } });
  expect(JSON.stringify(ex.json().error ?? null)).toBe("null");
  expect(ex.statusCode).toBe(201);
  const execution = ex.json().execution as { id: string };
  const settled = await until(
    async () => (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json(),
    (v: { execution: { status: string }; gates: unknown[] }) =>
      ["verified_pending_review", "failed", "blocked"].includes(v.execution.status) &&
      v.gates.length === tasks,
  );
  return { execution, settled };
}

describe("proposal runs", () => {
  it("researches each project, writes both documents, gates them and is accepted", async () => {
    const flow = (f = await startMimirFlow(
      {
        research: findingsStep("The app"),
        "research-docs-site": findingsStep("The docs site"),
        proposal: [
          {
            kind: "complete",
            artifacts: ["report@proposal.md", "file@engineering.md", "file@sources.json"],
            contents: {
              "report@proposal.md": PROPOSAL,
              "file@engineering.md": ENGINEERING,
              "file@sources.json": SOURCES,
            },
          },
        ],
      },
      TRUST_FAKE,
    ));
    const plan = await approvedProposalPlan(flow);
    expect(plan.tasks.map((t) => t.id)).toEqual(["research", "research-docs-site", "proposal"]);
    const { execution, settled } = await run(flow, plan.id, 3);
    expect(settled.execution.status).toBe("verified_pending_review");

    // Every task is a read-only document; the writer runs on the planning agent.
    const created = flow.fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/tasks");
    for (const r of created)
      expect((r.body as { mode?: unknown }).mode).toMatchObject({
        deliverable: "document",
        access: "read",
      });

    const report = (await until(
      async () => (await flow.h.call({ url: `/v1/deliveries/${execution.id}` })).json().report,
      (r: unknown) => Boolean(r),
    )) as {
      workKind: string;
      proposal: {
        proposal: { markdown: string };
        engineering: { markdown: string };
        findings: { planTaskId: string; project: string | null }[];
        gate: { passed: boolean } | null;
      };
    };
    expect(report.workKind).toBe("proposal");
    expect(report.proposal.proposal.markdown).toContain("## Demo plan");
    expect(report.proposal.engineering.markdown).toContain("## Findings by project");
    expect(report.proposal.findings.map((x) => [x.planTaskId, x.project])).toEqual([
      ["research", null],
      ["research-docs-site", "docs-site"],
    ]);
    expect(report.proposal.gate).toMatchObject({ passed: true });

    const accept = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/accept`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    expect(JSON.stringify(accept.json().error ?? null)).toBe("null");
    expect(accept.statusCode).toBe(200);
    expect(accept.json().report.proposal.decision).toMatchObject({ decision: "accepted" });

    // Revise: the feedback becomes a plan request over the same projects, and its writer is
    // handed the earlier proposal and appendix.
    const revise = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/follow-up`,
      payload: { question: "Add a rehearsal before each demo." },
    });
    expect(revise.statusCode).toBe(201);
    const intake = revise.json().intake;
    expect(intake.workKind).toBe("proposal");
    const d = await flow.h.call({
      method: "POST",
      url: "/v1/director/draft",
      payload: { projectId: flow.projectId, intakeId: intake.id, request: intake.title },
    });
    const a = await flow.h.call({
      method: "POST",
      url: `/v1/specs/${d.json().spec.id}/answer`,
      payload: { questionId: "Q1", answer: "Yes" },
    });
    const specId = a.json().spec.id as string;
    await flow.h.call({ method: "POST", url: `/v1/specs/${specId}/submit`, payload: {} });
    await flow.h.call({
      method: "POST",
      url: `/v1/specs/${specId}/approve`,
      payload: {},
      headers: await flow.h.approvalHeaders(),
    });
    const revised = (
      await flow.h.call({ method: "POST", url: "/v1/plans/propose", payload: { specId } })
    ).json().plan;
    expect(revised.tasks.map((t: { id: string }) => t.id)).toEqual([
      "research",
      "research-docs-site",
      "proposal",
    ]);
    expect(revised.work.proposal.text).toContain("Add a rehearsal before each demo.");
    expect(revised.work.proposal.text).toContain("the reports page and the docs-site");
    expect(revised.work.proposal.context.document).toContain("## Demo plan");
    expect(revised.work.proposal.context.document).toContain("# Engineering appendix");
  });

  it("fails the writer's gate when the proposal lacks its diagrams", async () => {
    const flow = (f = await startMimirFlow(
      {
        research: findingsStep("The app"),
        "research-docs-site": findingsStep("The docs site"),
        proposal: [
          {
            kind: "complete",
            artifacts: ["report@proposal.md", "file@engineering.md"],
            contents: {
              "report@proposal.md": PROPOSAL.replaceAll("```mermaid", "```text"),
              "file@engineering.md": ENGINEERING,
            },
          },
        ],
      },
      TRUST_FAKE,
    ));
    const plan = await approvedProposalPlan(flow);
    const { execution } = await run(flow, plan.id, 3);
    const gates = (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json().gates as {
      planTaskId: string;
      passed: boolean;
      failures: { reason: string }[];
    }[];
    const writer = gates.find((g) => g.planTaskId === "proposal")!;
    expect(writer.passed).toBe(false);
    expect(writer.failures.map((x) => x.reason)).toContain("too_few_diagrams:0");
  });

  it("restarts a run whose writer stopped, from where it stopped: research is not run again", async () => {
    const limit = { kind: "fail" as const, reason: "session_failed", retryable: false };
    const flow = (f = await startMimirFlow(
      {
        research: findingsStep("The app"),
        "research-docs-site": findingsStep("The docs site"),
        proposal: Array.from({ length: 8 }, () => limit),
      },
      TRUST_FAKE,
    ));
    const plan = await approvedProposalPlan(flow);
    const ex = await flow.h.call({
      method: "POST",
      url: "/v1/executions",
      payload: { planId: plan.id },
    });
    const execution = ex.json().execution as { id: string; mimirMissionId: string };
    const state = async () => (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json();
    // The writer runs out of attempts and is escalated; then Mimir fails the mission.
    await until(state, (v: { tasks: { planTaskId: string; escalation: string | null }[] }) =>
      v.tasks.some((t) => t.planTaskId === "proposal" && t.escalation),
    );
    const missionId = (await state()).execution.mimirMissionId as string;
    flow.fake.failMission(missionId);
    await until(state, (v: { execution: { status: string } }) =>
      ["awaiting_human", "failed"].includes(v.execution.status),
    );
    const retry = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/escalations/proposal`,
      payload: { decision: "retry", reason: "limit reset" },
    });
    expect(retry.statusCode).toBe(409);

    const startedBefore = (await state()).tasks.map((t: { planTaskId: string; status: string }) => [
      t.planTaskId,
      t.status,
    ]);
    expect(startedBefore).toContainEqual(["research", "completed"]);
    const mimirStarts = () =>
      flow.h.db
        .prepare(
          "SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ? AND type = 'task.started'",
        )
        .get(execution.id) as { n: number };
    const before = mimirStarts().n;

    // The limit has reset: restart the run.
    flow.fake.script("proposal", [
      {
        kind: "complete",
        artifacts: ["report@proposal.md", "file@engineering.md", "file@sources.json"],
        contents: {
          "report@proposal.md": PROPOSAL,
          "file@engineering.md": ENGINEERING,
          "file@sources.json": SOURCES,
        },
      },
    ]);
    const restart = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/restart`,
      payload: { reason: "Claude's weekly limit reset" },
    });
    expect(JSON.stringify(restart.json().error ?? null)).toBe("null");
    expect(restart.statusCode).toBe(200);
    const done = await until(
      state,
      (v: { execution: { status: string } }) => v.execution.status === "verified_pending_review",
    );
    expect(done.execution.status).toBe("verified_pending_review");
    // Only the writer ran again: one more session start, none for the research.
    expect(mimirStarts().n).toBe(before + 1);
    const restartedTwice = await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/restart`,
      payload: { reason: "again" },
    });
    expect(restartedTwice.statusCode).toBe(409);
  });
});
