import { openDatabase } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { BROKKR_REPORT_KIND } from "./brokkr-report.js";
import { brokkrReport, FakeDeliveryWorld, planTaskView, planView } from "./fakes.js";
import { GateRunner, type GateSpec } from "./gate-runner.js";

const IMPL = "implement-backend";

function world(opts: { session?: boolean } = {}) {
  const w = new FakeDeliveryWorld(planView([planTaskView(IMPL, { maxRetries: 2 })]));
  w.addTask(IMPL, "mt_impl", "crw_impl");
  if (opts.session !== false) {
    w.event("session.started", { runtime: "fake" }, { taskId: "mt_impl", sessionId: "ses_1" });
  }
  return w;
}

const report = (w: FakeDeliveryWorld, verdict: "passed" | "failed" = "passed") =>
  w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport({ verdict })));

const runner = (w: FakeDeliveryWorld, gates: GateSpec[] = []) =>
  new GateRunner({
    db: openDatabase(":memory:"),
    executions: w,
    mimir: w,
    content: w,
    gatesFor: () => gates,
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  });

const reasons = (r: { failures: { reason: string }[] }) => r.failures.map((f) => f.reason);

describe("GateRunner.enforce: edges", () => {
  it("retries without an instruction when Mimir reported no session for the task", async () => {
    const w = world({ session: false });
    w.setMissionTaskStatus("mt_impl", "failed");
    report(w, "failed");
    expect(await runner(w).enforce(w.executionId, IMPL)).toMatchObject({
      action: "retried",
      attempt: 1,
    });
    expect(w.calls.map((c) => c.method)).not.toContain("sendInstruction");
    expect(w.calls.find((c) => c.method === "retry")?.key).toBe("sindri:retry:mt_impl:1");
  });

  it("uses Sindri's task status when Mimir's mission no longer lists the task", async () => {
    const w = world();
    report(w, "failed");
    w.missionTasks.length = 0;
    w.execTasks[0]!.status = "failed";
    expect((await runner(w).enforce(w.executionId, IMPL)).action).toBe("retried");

    // A completed task Mimir does not list has no crew to put a repair task in.
    const done = world();
    report(done);
    done.missionTasks.length = 0;
    const r = runner(done, [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }]);
    expect((await r.enforce(done.executionId, IMPL)).action).toBe("escalated");
    expect(done.execTasks[0]!.attempts).toBe(0);
  });

  it("does not retry when another retry spent the last attempt meanwhile", async () => {
    for (const status of ["failed", "completed"]) {
      const w = world();
      report(w, status === "failed" ? "failed" : "passed");
      w.setMissionTaskStatus("mt_impl", status);
      // DeliveryLoop claimed attempts between this evaluation and the claim.
      w.claimAttempt = () => Promise.resolve(3);
      const r = runner(w, [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }]);
      expect((await r.enforce(w.executionId, IMPL)).action).toBe("exhausted");
      expect(w.calls.map((c) => c.method)).not.toContain("retry");
      expect(w.calls.map((c) => c.method)).not.toContain("createTask");
      expect(r.repairs(w.executionId, IMPL)).toEqual([]);
    }
  });

  it("escalates with the reason when a retry fails with a non-Error or the repair task is refused", async () => {
    const w = world();
    w.setMissionTaskStatus("mt_impl", "failed");
    report(w, "failed");
    w.failures.set("retry", "socket closed" as unknown as Error);
    expect(await runner(w).enforce(w.executionId, IMPL)).toMatchObject({
      action: "escalated",
      error: "socket closed",
    });

    const done = world();
    report(done);
    const r = runner(done, [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }]);
    done.failures.set("createTask", new Error("conflict: mission is not draft"));
    expect(await r.enforce(done.executionId, IMPL)).toMatchObject({
      action: "escalated",
      error: "conflict: mission is not draft",
    });
    done.failures.set("createTask", "refused" as unknown as Error);
    expect(await r.enforce(done.executionId, IMPL)).toMatchObject({
      action: "escalated",
      error: "refused",
    });
    expect(r.repairs(done.executionId, IMPL)).toEqual([]);
  });

  it("waits while the task is still running", async () => {
    const w = world();
    report(w, "failed");
    w.setMissionTaskStatus("mt_impl", "running");
    expect((await runner(w).enforce(w.executionId, IMPL)).action).toBe("pending");
    expect(w.execTasks[0]!.attempts).toBe(0);
  });
});

describe("GateRunner.evaluate: product gate evidence that cannot be trusted", () => {
  it("fails a review-artifact gate on altered bytes or a file that is not JSON", async () => {
    const gates: GateSpec[] = [{ id: "qa-verdict", kind: "review-artifact" }];
    const w = world();
    report(w);
    const altered = w.artifact("mt_impl", "review", '{"verdict":"approve"}');
    w.contents.set(altered, '{"verdict":"approve","findings":[]}');
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).failures).toEqual([
      { gateId: "qa-verdict", reason: "evidence_integrity_mismatch", evidenceRef: altered },
    ]);

    const notJson = w.artifact("mt_impl", "review", "LGTM");
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).failures).toEqual([
      { gateId: "qa-verdict", reason: "unparseable_review", evidenceRef: notJson },
    ]);
  });

  it("fails an artifact gate when Mimir's record differs from the event or is gone", async () => {
    const gates: GateSpec[] = [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }];
    const w = world();
    report(w);
    const shot = w.artifact("mt_impl", "screenshot", "png");
    w.artifacts.set(shot, { ...w.artifacts.get(shot)!, hash: `sha256:${"0".repeat(64)}` });
    expect(reasons(await runner(w, gates).evaluate(w.executionId, IMPL))).toEqual([
      "artifact_mismatch",
    ]);

    w.artifacts.delete(shot);
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).failures).toEqual([
      { gateId: "shots", reason: "artifact_unavailable", evidenceRef: shot },
    ]);
  });
});
