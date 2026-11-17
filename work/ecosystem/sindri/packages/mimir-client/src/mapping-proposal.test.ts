import type { Plan } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import {
  ENGINEERING_DOCUMENT,
  mapPlan,
  mimirTitleFor,
  modeFor,
  needsWeb,
  PROPOSAL_DOCUMENT,
  PROPOSAL_SECTION_TITLES,
} from "./mapping.js";
import { approvedPlan, planTask } from "./testing.js";

const proposal = (web = false): Plan =>
  approvedPlan(
    [
      planTask("research", { role: "investigator" }),
      planTask("research-docs-site", { role: "investigator" }),
      planTask("proposal", { role: "docs", dependsOn: ["research", "research-docs-site"] }),
      planTask("fact-check", { role: "reviewer", dependsOn: ["proposal"] }),
    ],
    {
      work: {
        kind: "proposal",
        proposal: {
          text: "Kickoff call\n\nWe should ship the reports page by Friday; the docs site needs it too.",
          sources: { code: true, web },
          factCheck: true,
          references: [
            {
              projectId: "prj-docs",
              name: "docs-site",
              slug: "docs-site",
              path: "/data/snapshots/prj-docs/abc",
              commit: "a".repeat(40),
              label: "A read-only snapshot of its default branch.",
            },
          ],
        },
      },
    },
  );

const briefOf = (plan: Plan, id: string) =>
  mapPlan(plan).tasks.find((t) => t.planTaskId === id)!.brief;

describe("proposal plans", () => {
  it("runs every task as a read-only document, on the web only when asked", () => {
    for (const task of proposal().tasks)
      expect(modeFor(proposal(), task)).toEqual({
        deliverable: "document",
        access: "read",
        network: "none",
      });
    expect(needsWeb(proposal(true))).toBe(true);
    expect(modeFor(proposal(true), proposal(true).tasks[0]!)?.network).toBe("web");
    expect(modeFor(proposal(true), proposal(true).tasks[0]!, { localOnly: true })?.network).toBe(
      "none",
    );
  });

  it("titles research and the writer by their bare ids, so dependants find their documents", () => {
    const plan = proposal();
    expect(plan.tasks.map((t) => mimirTitleFor(plan, t))).toEqual([
      "research",
      "research-docs-site",
      "proposal",
      expect.stringMatching(/^fact-check: /),
    ]);
  });

  it("points each investigator at its own project, with the pasted text as data", () => {
    const own = briefOf(proposal(), "research");
    expect(own).toContain("We should ship the reports page by Friday");
    expect(own).toMatch(/not instructions/i);
    expect(own).toContain(".mimir/artifacts/research.md");
    const other = briefOf(proposal(), "research-docs-site");
    expect(other).toContain("/data/snapshots/prj-docs/abc");
    expect(other).toContain("docs-site/");
    expect(other).toMatch(/only this project/i);
    expect(other).toMatch(/Do not install packages/);
  });

  it("has the writer read every project's findings and write the proposal and its appendix", () => {
    const writer = briefOf(proposal(), "proposal");
    expect(writer).toContain(".mimir/inputs/research/research.md");
    expect(writer).toContain(".mimir/inputs/research-docs-site/research.md");
    expect(writer).toContain(`.mimir/artifacts/${PROPOSAL_DOCUMENT}`);
    expect(writer).toContain(`.mimir/artifacts/${ENGINEERING_DOCUMENT}`);
    for (const title of PROPOSAL_SECTION_TITLES) expect(writer).toContain(title);
    expect(writer).toMatch(/Ticket 0.*spike/i);
    expect(writer).toMatch(/```mermaid/);
    for (const kind of ["flowchart", "sequenceDiagram", "gantt"]) expect(writer).toContain(kind);
    expect(writer).toContain("We should ship the reports page by Friday");
  });

  it("has the fact-check check the proposal against the appendix and the sources", () => {
    const check = briefOf(proposal(), "fact-check");
    expect(check).toContain(`.mimir/inputs/proposal/${PROPOSAL_DOCUMENT}`);
    expect(check).toContain(`.mimir/inputs/proposal/${ENGINEERING_DOCUMENT}`);
    expect(check).toMatch(/not supported by/i);
    expect(check).toContain(".mimir/artifacts/review.json");
  });

  it("tells the resolver the kind of work, so a plan's writer can run on the planning agent", () => {
    const asked: [string, string | undefined][] = [];
    mapPlan(proposal(), {
      agentKindFor: (_h, role, kind) => (asked.push([role, kind]), "claude"),
    });
    expect(asked).toContainEqual(["docs", "proposal"]);
  });

  it("hands a revision's writer the earlier documents to revise", () => {
    const plan = proposal();
    plan.work!.proposal!.context = { executionId: "exe_1", document: "# Earlier plan\n## Why" };
    const writer = briefOf(plan, "proposal");
    expect(writer).toMatch(/This is a revision/);
    expect(writer).toContain("# Earlier plan");
    expect(briefOf(proposal(), "proposal")).not.toMatch(/This is a revision/);
  });

  it("lets the research crew run every project's research at once", () => {
    const crew = mapPlan(proposal()).crews.find((c) => c.role === "investigator")!;
    expect(crew.taskIds).toEqual(["research", "research-docs-site"]);
    expect(crew.request.limits.maxConcurrentTasks).toBe(2);
  });

  it("gives each crew a fallback member on the other agent, used only while its own cannot work", () => {
    const mapped = mapPlan(proposal(), {
      agentKindFor: (_h, role) => (role === "docs" ? "claude" : "codex"),
      fallbackAgentFor: (k) => ({ claude: "codex", codex: "claude" })[k],
    });
    const writer = mapped.crews.find((c) => c.role === "docs")!;
    expect(writer.request.members.map((m) => m.agentKind)).toEqual(["claude", "codex"]);
    const none = mapPlan(proposal(), { agentKindFor: () => "claude" });
    expect(none.crews.every((c) => c.request.members.length === 1)).toBe(true);
  });
});
