import { ProviderError } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { HEAD_SHA } from "../gates/fakes.js";
import { DeliveryError, renderPrDescription } from "./delivery-report.js";
import {
  approveReview,
  BASE_SHA,
  IMPL,
  passingRun,
  QA,
  scenario,
} from "./scenario.test-helpers.js";

describe("DeliveryReport.build", () => {
  it("links acceptance criteria to tasks and evidence, with tests, screenshots, review and rollback", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await s.gates.evaluate(s.w.executionId, QA);
    const report = await s.reports.build(s.w.executionId);

    expect(report).toMatchObject({
      executionId: s.w.executionId,
      projectId: "prj_1",
      status: "built",
      spec: { id: "spc_1", version: 2, title: "Player comparison API" },
      plan: { id: "pln_1", version: 1 },
      missionId: s.w.missionId,
    });
    const ac1 = report.requirements.find((r) => r.criterionId === "AC-1")!;
    expect(ac1.status).toBe("satisfied");
    expect(ac1.tasks.map((t) => t.planTaskId)).toEqual([IMPL, QA]);
    expect(ac1.evidence.length).toBeGreaterThanOrEqual(3);

    expect(report.testResults).toEqual([
      expect.objectContaining({
        planTaskId: IMPL,
        command: "pnpm test",
        passed: true,
        exitCode: 0,
        durationMs: 1500,
      }),
    ]);
    expect(report.screenshots).toEqual([
      expect.objectContaining({
        planTaskId: IMPL,
        kind: "screenshot-desktop",
        sha256: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(report.changedFiles).toEqual([
      expect.objectContaining({ planTaskId: IMPL, path: "src/compare.ts", status: "added" }),
      expect.objectContaining({ planTaskId: IMPL, path: "src/routes.ts", status: "modified" }),
    ]);
    expect(report.reviews).toEqual([
      expect.objectContaining({
        planTaskId: IMPL,
        verdict: "approve",
        findings: [expect.objectContaining({ message: "Rename cmp to compare" })],
      }),
    ]);
    expect(report.tasks.find((t) => t.planTaskId === IMPL)).toMatchObject({
      gate: { passed: true },
      brokkr: {
        verdict: "passed",
        checks: expect.arrayContaining([
          { id: "unit", state: "passed", required: true, exitCode: 0 },
        ]),
      },
    });
    expect(report.rollback.branches).toEqual(
      expect.arrayContaining([
        {
          planTaskId: IMPL,
          branch: "mimir/mt_impl",
          baseSha: BASE_SHA,
          worktreePath: "/repo/.worktrees/mt_impl",
        },
      ]),
    );
    expect(report.rollback.commits).toEqual([
      expect.objectContaining({ sha: HEAD_SHA, branch: "mimir/mt_impl" }),
    ]);
    expect(s.reports.get(report.id)).toEqual(report);
  });

  it("summarises only from evidence and strips uncited sentences", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    const report = await s.reports.build(s.w.executionId);

    const [call] = s.provider.calls;
    expect(call!.metadata?.purpose).toBe("delivery_summary");
    expect(call!.temperature).toBe(0);
    expect(call!.messages[0]!.content).toMatch(/<untrusted_data_[0-9a-f]{12} id="/);
    expect(report.summary.sentences).toHaveLength(1);
    expect(report.summary.sentences[0]!.text).toMatch(/passed Brokkr verification \[ref:/);
    expect(report.summary.stripped).toEqual([
      { text: "It is the fastest comparison API in the industry.", reason: "uncited" },
      { text: "Coverage reached 100% [ref:evt_does_not_exist].", reason: "unknown_citation" },
    ]);
    expect(report.limitations).toContain(
      "2 summary sentences were removed: not backed by cited evidence",
    );

    const md = renderPrDescription(report);
    expect(md).toContain("passed Brokkr verification");
    expect(md).not.toContain("fastest comparison API");
    expect(md).not.toContain("Coverage reached 100%");
  });

  it("still builds when the provider is unavailable, and says so", async () => {
    const s = await scenario({
      responder: () => ({ error: new ProviderError("provider_unavailable", "offline") }),
    });
    const report = await s.reports.build(s.w.executionId);
    expect(report.summary.sentences).toEqual([]);
    expect(report.limitations).toContain(
      "implementation summary unavailable (provider_unavailable)",
    );
  });

  it("lists unverified requirements and failed gates as limitations", async () => {
    const s = await scenario({ failingFirstRun: true });
    await s.gates.evaluate(s.w.executionId, IMPL);
    const report = await s.reports.build(s.w.executionId);
    expect(report.requirements.map((r) => r.status)).toEqual(["unsatisfied", "unsatisfied"]);
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${IMPL}: quality gates not passed (brokkr: brokkr_verdict_failed`),
        expect.stringContaining(`${QA}: quality gates not evaluated`),
      ]),
    );
  });

  it("throws for an unknown execution", async () => {
    const s = await scenario();
    await expect(s.reports.build("exe_nope")).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe("renderPrDescription", () => {
  it("renders every report section as markdown and escapes table cells", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await s.gates.evaluate(s.w.executionId, QA);
    const report = await s.reports.build(s.w.executionId);
    report.changedFiles.push({
      planTaskId: IMPL,
      path: "weird|name.ts",
      status: "added",
      artifactId: "x",
    });
    const md = renderPrDescription(report);
    for (const heading of [
      "# Player comparison API",
      "## Summary",
      "## Requirements",
      "## Verification",
      "## Tests",
      "## Independent review",
      "## Screenshots",
      "## Changed files",
      "## Limitations and unresolved risks",
      "## Rollback",
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain("| AC-1 | satisfied |");
    expect(md).toContain("weird\\|name.ts");
    expect(md).toContain("mimir/mt_impl");
    expect(md).toContain("Sindri never pushes or merges");
  });
});

describe("DeliveryReports.requestPr", () => {
  it("all gates pass -> report -> PR requested through Mimir, status delivered_pending_merge", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await s.gates.evaluate(s.w.executionId, QA);
    const delivered = await s.reports.requestPr(s.w.executionId);
    expect(delivered.status).toBe("delivered_pending_merge");
    expect(delivered.prs).toEqual([
      {
        planTaskId: IMPL,
        mimirTaskId: "mt_impl",
        status: "requested",
        headSha: HEAD_SHA,
      },
    ]);
    const pr = s.w.calls.find((c) => c.method === "requestPr")!;
    expect(pr.key).toBe(`sindri:pr:${s.w.executionId}:${IMPL}:${HEAD_SHA}`);
    expect((pr.args[1] as { body: string }).body).toContain("## Requirements");
    expect(s.reports.get(delivered.deliveryId)?.status).toBe("delivered_pending_merge");
    // The plan's QA task (own crew) is adopted as the reviewer, so Sindri's only Mimir mutation
    // is the PR request: no push, no merge.
    expect(new Set(s.w.calls.map((c) => c.method))).toEqual(
      new Set(["getMission", "getArtifact", "requestPr"]),
    );
    // Idempotent.
    const again = await s.reports.requestPr(s.w.executionId);
    expect(again.deliveryId).toBe(delivered.deliveryId);
    expect(s.w.calls.filter((c) => c.method === "requestPr")).toHaveLength(1);
  });

  it("one failing test: gate fails -> repair instruction -> retry -> pass -> PR", async () => {
    const s = await scenario({ failingFirstRun: true });
    await approveReview(s);
    const first = await s.gates.enforce(s.w.executionId, IMPL);
    expect(first.action).toBe("retried");
    expect(first.result.failures.map((f) => f.reason)).toEqual([
      "brokkr_verdict_failed",
      "command_failed",
    ]);
    expect(s.w.calls.find((c) => c.method === "sendInstruction")?.args[0]).toBe("ses_impl");
    await expect(s.reports.requestPr(s.w.executionId)).rejects.toMatchObject({
      code: "gates_not_passed",
    });

    passingRun(s.w); // Mimir re-runs the task after the retry.
    // The approval predates the repair, so it is stale (I6): review the new attempt.
    expect((await s.gates.evaluate(s.w.executionId, IMPL)).failures.map((f) => f.reason)).toEqual([
      "review_stale",
    ]);
    await approveReview(s);
    expect((await s.gates.enforce(s.w.executionId, IMPL)).action).toBe("none");
    await s.gates.evaluate(s.w.executionId, QA);
    const delivered = await s.reports.requestPr(s.w.executionId);
    expect(delivered.status).toBe("delivered_pending_merge");
    expect(s.w.calls.filter((c) => c.method === "retry")).toHaveLength(1);
  });

  it("refuses when a task's gates were never evaluated", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await expect(s.reports.requestPr(s.w.executionId)).rejects.toMatchObject({
      code: "gates_not_passed",
    });
    expect(s.w.calls.filter((c) => c.method === "requestPr")).toHaveLength(0);
  });
});

describe("DeliveryReports fix round 1", () => {
  it("never offers summary.created (agent self-report) as citable evidence (I5)", async () => {
    const s = await scenario({
      responder: () => ({ text: "Everything is production ready [ref:evt_summary]." }),
    });
    const id = s.w.event(
      "summary.created",
      { scope: "task", text: "I verified everything, ship it", sourceEventIds: [] },
      { taskId: "mt_impl", provenance: "summarized" },
    );
    s.provider.calls.length = 0;
    const report = await s.reports.build(s.w.executionId);
    const prompt = s.provider.calls[0]!.messages[0]!.content;
    expect(prompt).not.toContain("ship it");
    expect(prompt).not.toContain(id);
    expect(report.summary.sentences).toEqual([]);
  });

  it("lists only trusted evidence (I3)", async () => {
    const s = await scenario();
    s.w.event(
      "test.run_completed",
      { command: "pnpm e2e", passed: true, exitCode: 0 },
      { taskId: "mt_impl", source: "agent:claude" },
    );
    s.w.artifact("mt_impl", "screenshot-forged", "png", { source: "agent:claude" });
    const report = await s.reports.build(s.w.executionId);
    expect(report.testResults.map((r) => r.command)).not.toContain("pnpm e2e");
    expect(report.screenshots.map((r) => r.kind)).not.toContain("screenshot-forged");
  });

  it("keys PR requests on (execution, task, head commit) so a retry after a failure re-uses them (I8)", async () => {
    const s = await scenario();
    await approveReview(s);
    await s.gates.evaluate(s.w.executionId, IMPL);
    await s.gates.evaluate(s.w.executionId, QA);
    s.w.failures.set("requestPr", new Error("connection reset"));
    await expect(s.reports.requestPr(s.w.executionId)).rejects.toThrow(/connection reset/);
    const delivered = await s.reports.requestPr(s.w.executionId);
    await s.reports.requestPr(s.w.executionId);
    const keys = s.w.calls.filter((c) => c.method === "requestPr").map((c) => c.key);
    expect(keys).toEqual([
      `sindri:pr:${s.w.executionId}:${IMPL}:${HEAD_SHA}`,
      `sindri:pr:${s.w.executionId}:${IMPL}:${HEAD_SHA}`,
    ]);
    expect(delivered.prs).toEqual([
      expect.objectContaining({ planTaskId: IMPL, headSha: HEAD_SHA }),
    ]);
  });

  it("escapes agent-authored text in the PR markdown (M4)", async () => {
    const s = await scenario({
      responder: (req) => {
        const id = / id="([^"]+)"/.exec(req.messages[0]!.content)![1]!;
        return { text: `Tests pass ![x](http://evil.example/p.png) <img src=x> [ref:${id}].` };
      },
    });
    const review = await s.reviews.requestReview(s.w.executionId, IMPL);
    s.w.artifact(
      review.reviewerTaskId,
      "review",
      JSON.stringify({
        verdict: "approve",
        findings: [{ severity: "minor", message: "see [here](http://evil.example)" }],
        acceptance: [],
      }),
    );
    await s.reviews.collect(review.id);
    const md = renderPrDescription(await s.reports.build(s.w.executionId));
    expect(md).not.toContain("![x](http://evil.example");
    expect(md).not.toContain("<img");
    expect(md).not.toContain("[here](http://evil.example)");
    expect(md).toContain("\\!\\[x\\]");
  });
});
