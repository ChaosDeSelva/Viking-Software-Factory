import { test } from "node:test";
import assert from "node:assert/strict";
import { canControlMission } from "../apps/web/src/features/missionState.ts";
test("completed and unavailable missions never offer lifecycle controls", () => {
  for (const status of ["completed", "cancelled", "failed", "unknown", ""])
    for (const action of ["pause", "resume", "cancel"])
      assert.equal(canControlMission(status, action), false);
});
test("mission controls match the scheduling lifecycle", () => {
  assert.equal(canControlMission("active", "pause"), true);
  assert.equal(canControlMission("active", "resume"), false);
  assert.equal(canControlMission("paused", "resume"), true);
  assert.equal(canControlMission("paused", "pause"), false);
  assert.equal(canControlMission("draft", "cancel"), true);
  assert.equal(canControlMission("draft", "pause"), false);
});
