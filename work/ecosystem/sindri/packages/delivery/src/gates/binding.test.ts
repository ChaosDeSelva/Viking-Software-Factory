import type { SqliteDatabase } from "@sindri/knowledge";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import { MimirClientFacade } from "@sindri/mimir-client";
import { approvedPlan, planTask } from "@sindri/mimir-client/testing";
import type { PlanTask } from "@sindri/planner";
import { createFakeMimir, type FakeMimir, type TaskStep } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryLoop } from "../delivery-loop.js";
import { ReviewOrchestrator } from "../review/review-orchestrator.js";
import {
  contextReaderFrom,
  executionReaderFor,
  mimirActionsFor,
  mimirArtifactContentReader,
} from "./binding.js";
import { BROKKR_REPORT_KIND } from "./brokkr-report.js";
import { brokkrReport } from "./fakes.js";
import { GateRunner } from "./gate-runner.js";

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

/** The fake Mimir's envelope source. Production trusts only `mimir.server`. */
const FAKE_SOURCES = ["fake-mimir"];
async function boot(scripts: Record<string, TaskStep[]>) {
  fake = await createFakeMimir({ stepDelayMs: 0, scripts });
  const d = (db = openDeliveryTestDb());
  const facade = new MimirClientFacade({ db: d }).connect({ baseUrl: fake.url, token: fake.token });
  const executions = (loop: DeliveryLoop) => executionReaderFor({ db: d, loop, mimir: facade });
  const mimir = mimirActionsFor(facade);
  const project = await facade.ensureProject("/repos/app");
  return { d, facade, mimir, executions, project };
}

async function run(tasks: PlanTask[] = [planTask("impl")]) {
  const b = await boot({
    impl: [{ kind: "complete", artifacts: ["changed-files", BROKKR_REPORT_KIND, "screenshot"] }],
  });
  const loop = new DeliveryLoop({ db: b.d, mimir: b.facade, logger: { warn: () => undefined } });
  const execution = await loop.createExecution(approvedPlan(tasks), { projectId: b.project.id });
  expect((await loop.run(execution.id)).status).toBe("verified_pending_review");
  return { ...b, loop, execution, executions: b.executions(loop) };
}

describe("binding to S5's DeliveryLoop and MimirClientFacade (fake Mimir)", () => {
  it("reads S5's executions with envelope task, session, source and provenance from Mimir", async () => {
    const { execution, executions } = await run();
    const view = await executions.execution(execution.id);
    expect(view).toMatchObject({ id: execution.id, mimirMissionId: execution.mimirMissionId });
    const [task] = await executions.tasks(execution.id);
    expect(task).toMatchObject({ planTaskId: "impl", status: "completed" });
    const events = await executions.events(execution.id);
    const testRun = events.find((e) => e.type === "test.run_completed");
    expect(testRun).toMatchObject({
      mimirTaskId: task!.mimirTaskId,
      source: "fake-mimir",
      provenance: "observed",
    });
    expect(testRun?.sessionId).toMatch(/^ses/);
  });

  it("binds Brokkr's report to the head in the server-recorded changed-files manifest (no git.commit_observed)", async () => {
    const plan = approvedPlan([planTask("impl")]);
    const lock = plan.tasks[0]!.harnessLockDigest;
    const b = await boot({
      impl: [
        {
          kind: "complete",
          artifacts: ["diff", "changed-files", BROKKR_REPORT_KIND],
          contents: {
            [BROKKR_REPORT_KIND]: (taskId) =>
              JSON.stringify(
                brokkrReport({
                  taskId,
                  harness: { name: "backend-node", version: "1.0.0", lockDigest: lock },
                  repository: { commitSha: fake!.headShaOf(taskId) },
                }),
              ),
          },
        },
      ],
    });
    const loop = new DeliveryLoop({ db: b.d, mimir: b.facade, logger: { warn: () => undefined } });
    const execution = await loop.createExecution(plan, { projectId: b.project.id });
    await loop.run(execution.id);
    expect(fake!.events().map((e) => e.type)).not.toContain("git.commit_observed");
    const [task] = loop.tasks(execution.id);
    const gates = new GateRunner({
      db: b.d,
      executions: b.executions(loop),
      mimir: b.mimir,
      content: mimirArtifactContentReader(b.facade),
      trustedSources: FAKE_SOURCES,
      gatesFor: () => [],
    });
    const result = await gates.evaluate(execution.id, "impl");
    expect(result.failures).toEqual([]);
    expect(result.engineering?.verdict).toBe("passed");
    // The report is bound to the stored Mimir task id.
    expect(task!.mimirTaskId).toMatch(/^tsk_/);
  });

  it("claimAttempt increments the shared execution_tasks.attempts", async () => {
    const { execution, executions, loop } = await run();
    expect(await executions.claimAttempt(execution.id, "impl")).toBe(1);
    expect(await executions.claimAttempt(execution.id, "impl")).toBe(2);
    expect(loop.tasks(execution.id)[0]!.attempts).toBe(2);
  });

  it("evaluates gates end to end and fails closed on what the fake cannot prove", async () => {
    const { d, execution, executions, mimir, facade } = await run();
    const fakeContent = mimirArtifactContentReader(facade);
    const gates = new GateRunner({
      db: d,
      executions,
      mimir,
      content: fakeContent,
      trustedSources: FAKE_SOURCES,
      gatesFor: () => [
        { id: "tests", kind: "command", command: "pnpm test" },
        { id: "shots", kind: "artifact", artifactKind: "screenshot" },
      ],
    });
    const result = await gates.evaluate(execution.id, "impl");
    expect(result.failures).toEqual([
      {
        gateId: "brokkr",
        reason: "verification_report_invalid",
        evidenceRef: expect.stringMatching(/^art/),
      },
      // Protocol 0.0.0's test.run_completed carries no exit code.
      { gateId: "tests", reason: "command_exit_code_unrecorded", evidenceRef: expect.any(String) },
    ]);
    // With production trust (mimir.server only) nothing the fake recorded counts.
    const strict = new GateRunner({ db: d, executions, mimir, content: fakeContent });
    expect((await strict.evaluate(execution.id, "impl")).failures.map((f) => f.reason)).toEqual([
      "verification_report_missing",
    ]);
  });

  it("adopts the plan's review task; a later extra review surfaces Mimir's refusal", async () => {
    const { d, execution, executions, mimir, facade } = await run([
      planTask("impl"),
      planTask("review-impl", { role: "reviewer", dependsOn: ["impl"] }),
    ]);
    const before = { ...fake!.creates };
    const reviews = new ReviewOrchestrator({
      db: d,
      executions,
      mimir,
      content: mimirArtifactContentReader(facade),
    });
    const review = await reviews.requestReview(execution.id, "impl");
    expect(review.origin).toBe("plan");
    expect(review.reviewerCrewId).not.toBe(review.implementerCrewId);
    expect(fake!.creates).toEqual(before);
    await expect(reviews.requestReview(execution.id, "impl")).rejects.toMatchObject({
      code: "invalid_transition",
    });
  });

  it("reads artifact bytes through the facade (SDK artifacts.content); unknown PR tasks return not_found", async () => {
    const { facade, mimir } = await run();
    const manifest = fake!.artifacts().find((a) => a.kind === "changed-files")!;
    const text = await mimirArtifactContentReader(facade).read({
      id: manifest.id,
      taskId: manifest.taskId,
      kind: manifest.kind,
      uri: manifest.uri,
      hash: manifest.hash,
    });
    expect(JSON.parse(text)).toMatchObject({ headSha: fake!.headShaOf(manifest.taskId) });
    await expect(
      mimir.requestPr("tsk_x", { title: "t", body: "b" }, "sindri:pr:x"),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("one retry budget for runtime and verification failures (I1)", () => {
  it("DeliveryLoop retries runtime failures, GateRunner verification failures; total stays within maxRetries", async () => {
    const tasks = [planTask("impl", { maxRetries: 2 })];
    const b = await boot({
      impl: [
        { kind: "fail", reason: "runtime_failed: session lost" },
        { kind: "fail", reason: "verification_failed" },
        { kind: "fail", reason: "verification_failed" },
      ],
    });
    const holder: { gates?: GateRunner } = {};
    const loop = new DeliveryLoop({
      db: b.d,
      mimir: b.facade,
      logger: { warn: () => undefined },
      verificationFailures: { enforce: (e, t) => holder.gates!.enforce(e, t) },
    });
    const gates = (holder.gates = new GateRunner({
      db: b.d,
      executions: b.executions(loop),
      mimir: b.mimir,
      content: mimirArtifactContentReader(b.facade),
      trustedSources: FAKE_SOURCES,
    }));
    const execution = await loop.createExecution(approvedPlan(tasks), {
      projectId: b.project.id,
    });
    const result = await loop.run(execution.id);
    expect(result.status).toBe("blocked");
    const retries = fake!.requests.filter(
      (r) => r.method === "POST" && /\/v1\/tasks\/[^/]+\/retry$/.test(r.path),
    );
    expect(retries.map((r) => r.idempotencyKey)).toEqual([
      expect.stringMatching(/^sindri:retry:.+:1$/),
      expect.stringMatching(/^sindri:retry:.+:2$/),
    ]);
    const [task] = loop.tasks(execution.id);
    expect(task!.attempts).toBe(2);
    expect(task!.escalation).toBe("block");
    expect(gates.repairs(execution.id, "impl")).toEqual([
      expect.objectContaining({ attempt: 2, kind: "retry" }),
    ]);
  });
});

describe("contextReaderFrom", () => {
  it("maps @sindri/specs and @sindri/intake records to the trace views", async () => {
    const ctx = contextReaderFrom({
      specs: {
        get: (id: string) =>
          id === "spc_1"
            ? {
                id: "spc_1",
                lineageId: "spl_1",
                version: 3,
                status: "approved",
                title: "T",
                intakeId: "int_1",
                body: {
                  acceptanceCriteria: [{ id: "AC-1", text: "works", verification: "test" }],
                },
              }
            : undefined,
      },
      intakes: {
        get: (id: string) =>
          id === "int_1"
            ? {
                id: "int_1",
                source: "jira",
                externalId: "ENG-1",
                externalUrl: null,
                title: "Ticket",
                body: "secret body is not copied",
              }
            : undefined,
      },
    });
    expect(await ctx.spec("spc_1")).toEqual({
      id: "spc_1",
      lineageId: "spl_1",
      version: 3,
      status: "approved",
      title: "T",
      intakeId: "int_1",
      acceptanceCriteria: [{ id: "AC-1", text: "works", verification: "test" }],
    });
    expect(await ctx.intake("int_1")).toEqual({
      id: "int_1",
      source: "jira",
      externalId: "ENG-1",
      externalUrl: null,
      title: "Ticket",
    });
    expect(await ctx.spec("nope")).toBeUndefined();
  });
});

describe("artifact reads are bounded in time (audit L9)", () => {
  it("a Mimir content read that never answers becomes artifact_unavailable", async () => {
    const { readVerifiedArtifact } = await import("./evidence.js");
    const hung = { artifactContent: () => new Promise<string>(() => undefined) };
    const reader = mimirArtifactContentReader(hung, { timeoutMs: 50 });
    const mimir = {
      getArtifact: () =>
        Promise.resolve({ id: "art_x", taskId: "t", kind: "k", uri: "u", hash: "h" }),
    };
    const started = Date.now();
    const read = await readVerifiedArtifact(mimir, reader, "art_x");
    expect(read).toMatchObject({ ok: false, reason: "artifact_unavailable" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
