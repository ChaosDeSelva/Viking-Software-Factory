import { describe, expect, it } from "vitest";
import * as core from "../index.js";

describe("@mimir/core domain exports", () => {
  it.each([
    "taskMachine",
    "missionMachine",
    "validateDag",
    "readyTasks",
    "findCycle",
    "leaseManager",
    "schedule",
    "backoffMs",
    "budgetGuard",
    "blockedTooLong",
    "stuckDetector",
    "applyDecisions",
    "occupiesSlot",
    "BUDGET_EXCEEDED",
    "APPROVAL_REQUIRED",
    "POLICY_DENIED",
    "UNKNOWN_AFTER_RESTART",
    "isParked",
    "BUDGET_UNCERTAIN",
  ])("exports %s", (name) => {
    expect(core).toHaveProperty(name);
  });
});
