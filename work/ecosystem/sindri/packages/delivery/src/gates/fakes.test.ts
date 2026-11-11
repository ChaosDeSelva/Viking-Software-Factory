import { describe, expect, it } from "vitest";
import { FakeDeliveryWorld, planTaskView, planView } from "./fakes.js";

describe("FakeDeliveryWorld", () => {
  it("knows only its own execution and tasks", async () => {
    const w = new FakeDeliveryWorld(planView([planTaskView("impl")])).addTask(
      "impl",
      "mt_1",
      "crw_1",
    );
    w.event("task.started", {}, { taskId: "mt_1" });
    expect(await w.events("exe_other")).toEqual([]);
    expect(await w.tasks("exe_other")).toEqual([]);
    await expect(w.claimAttempt("exe_other", "impl")).rejects.toThrow("unknown task impl");
    await expect(w.claimAttempt(w.executionId, "ghost")).rejects.toThrow("unknown task ghost");
    expect(await w.claimAttempt(w.executionId, "impl")).toBe(1);
  });

  it("fails reads of artifacts it does not hold", async () => {
    const w = new FakeDeliveryWorld(planView([]));
    await expect(w.getArtifact("art_nope")).rejects.toThrow("artifact art_nope not found");
    await expect(
      w.read({ id: "art_nope", taskId: "mt_1", kind: "diff", uri: "u", hash: "h" }),
    ).rejects.toThrow("no content for art_nope");
    // Marking a task Mimir does not list changes nothing.
    w.setMissionTaskStatus("mt_nope", "failed");
    expect((await w.getMission(w.missionId)).tasks).toEqual([]);
  });
});
