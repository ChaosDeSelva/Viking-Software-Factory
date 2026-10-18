import { z } from "zod";

export const TaskStatusSchema = z.enum([
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
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TaskStatus = TaskStatusSchema.enum;

export const MissionStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "completed",
  "cancelled",
  "failed",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export const MissionStatus = MissionStatusSchema.enum;

export const CrewStatusSchema = z.enum(["configured", "running", "stopped", "archived"]);
export type CrewStatus = z.infer<typeof CrewStatusSchema>;
export const CrewStatus = CrewStatusSchema.enum;

export const RuntimeSessionStateSchema = z.enum([
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
export type RuntimeSessionState = z.infer<typeof RuntimeSessionStateSchema>;
export const RuntimeSessionState = RuntimeSessionStateSchema.enum;

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export const ApprovalStatus = ApprovalStatusSchema.enum;

export const ProvenanceSchema = z.enum(["observed", "derived", "summarized"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;
export const Provenance = ProvenanceSchema.enum;

export const UsageSourceSchema = z.enum(["measured", "estimated", "unavailable"]);
export type UsageSource = z.infer<typeof UsageSourceSchema>;
export const UsageSource = UsageSourceSchema.enum;

export const CrewRoleSchema = z.enum(["lead", "implementer", "reviewer", "qa", "investigator"]);
export type CrewRole = z.infer<typeof CrewRoleSchema>;
export const CrewRole = CrewRoleSchema.enum;

export const CommandStatusSchema = z.enum([
  "accepted",
  "running",
  "succeeded",
  "failed",
  "rejected",
]);
export type CommandStatus = z.infer<typeof CommandStatusSchema>;
export const CommandStatus = CommandStatusSchema.enum;

/** A human decision on an approval (subset of ApprovalStatus). */
export const ApprovalDecisionSchema = z.enum(["approved", "rejected"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;
export const ApprovalDecision = ApprovalDecisionSchema.enum;
