import { describe, expect, it } from "vitest";
import {
  ApprovalStatus,
  ApprovalStatusSchema,
  CommandStatusSchema,
  CrewRoleSchema,
  CrewStatusSchema,
  MissionStatusSchema,
  ProvenanceSchema,
  RuntimeSessionStateSchema,
  TaskStatus,
  TaskStatusSchema,
  UsageSourceSchema,
} from "./enums.js";

describe("enums", () => {
  it("have exactly the specified values", () => {
    expect(TaskStatusSchema.options).toEqual([
      "pending",
      "ready",
      "leased",
      "running",
      "verifying",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]);
    expect(MissionStatusSchema.options).toEqual([
      "draft",
      "active",
      "paused",
      "completed",
      "cancelled",
      "failed",
    ]);
    expect(CrewStatusSchema.options).toEqual(["configured", "running", "stopped", "archived"]);
    expect(RuntimeSessionStateSchema.options).toEqual([
      "requested",
      "starting",
      "idle",
      "running",
      "waiting",
      "blocked",
      "stopping",
      "stopped",
      "completed",
      "failed",
      "unknown",
    ]);
    expect(ApprovalStatusSchema.options).toEqual([
      "pending",
      "approved",
      "rejected",
      "expired",
      "cancelled",
    ]);
    expect(ProvenanceSchema.options).toEqual(["observed", "derived", "summarized"]);
    expect(UsageSourceSchema.options).toEqual(["measured", "estimated", "unavailable"]);
    expect(CrewRoleSchema.options).toEqual([
      "lead",
      "implementer",
      "reviewer",
      "qa",
      "investigator",
    ]);
    expect(CommandStatusSchema.options).toEqual([
      "accepted",
      "running",
      "succeeded",
      "failed",
      "rejected",
    ]);
  });

  it("expose value objects with the same name", () => {
    expect(TaskStatus.leased).toBe("leased");
    expect(ApprovalStatus.expired).toBe("expired");
  });

  it("reject unknown values", () => {
    expect(TaskStatusSchema.safeParse("done").success).toBe(false);
    expect(ProvenanceSchema.safeParse("guessed").success).toBe(false);
  });
});
