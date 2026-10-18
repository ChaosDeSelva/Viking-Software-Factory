import { monotonicFactory } from "ulid";
import { z } from "zod";

/** Prefix for each kind of identifier. IDs are `${prefix}_${ulid}`. */
export const ID_PREFIX = {
  project: "prj",
  mission: "msn",
  crew: "crw",
  crewMember: "cmb",
  task: "tsk",
  taskDependency: "tdp",
  agent: "agt",
  worktree: "wtr",
  command: "cmd",
  artifact: "art",
  approval: "apr",
  policy: "pol",
  budget: "bgt",
  usageSample: "usg",
  auditEntry: "aud",
  event: "evt",
  session: "ses",
  operation: "op",
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

function idSchema<B extends string>(prefix: IdPrefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID_PATTERN}$`), `expected a ${prefix}_<ulid> id`)
    .brand<B>();
}

export const ProjectIdSchema = idSchema<"ProjectId">(ID_PREFIX.project);
export type ProjectId = z.infer<typeof ProjectIdSchema>;
export const MissionIdSchema = idSchema<"MissionId">(ID_PREFIX.mission);
export type MissionId = z.infer<typeof MissionIdSchema>;
export const CrewIdSchema = idSchema<"CrewId">(ID_PREFIX.crew);
export type CrewId = z.infer<typeof CrewIdSchema>;
export const CrewMemberIdSchema = idSchema<"CrewMemberId">(ID_PREFIX.crewMember);
export type CrewMemberId = z.infer<typeof CrewMemberIdSchema>;
export const TaskIdSchema = idSchema<"TaskId">(ID_PREFIX.task);
export type TaskId = z.infer<typeof TaskIdSchema>;
export const TaskDependencyIdSchema = idSchema<"TaskDependencyId">(ID_PREFIX.taskDependency);
export type TaskDependencyId = z.infer<typeof TaskDependencyIdSchema>;
export const AgentIdSchema = idSchema<"AgentId">(ID_PREFIX.agent);
export type AgentId = z.infer<typeof AgentIdSchema>;
export const WorktreeIdSchema = idSchema<"WorktreeId">(ID_PREFIX.worktree);
export type WorktreeId = z.infer<typeof WorktreeIdSchema>;
export const CommandIdSchema = idSchema<"CommandId">(ID_PREFIX.command);
export type CommandId = z.infer<typeof CommandIdSchema>;
export const ArtifactIdSchema = idSchema<"ArtifactId">(ID_PREFIX.artifact);
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;
export const ApprovalIdSchema = idSchema<"ApprovalId">(ID_PREFIX.approval);
export type ApprovalId = z.infer<typeof ApprovalIdSchema>;
export const PolicyIdSchema = idSchema<"PolicyId">(ID_PREFIX.policy);
export type PolicyId = z.infer<typeof PolicyIdSchema>;
export const BudgetIdSchema = idSchema<"BudgetId">(ID_PREFIX.budget);
export type BudgetId = z.infer<typeof BudgetIdSchema>;
export const UsageSampleIdSchema = idSchema<"UsageSampleId">(ID_PREFIX.usageSample);
export type UsageSampleId = z.infer<typeof UsageSampleIdSchema>;
export const AuditEntryIdSchema = idSchema<"AuditEntryId">(ID_PREFIX.auditEntry);
export type AuditEntryId = z.infer<typeof AuditEntryIdSchema>;
export const EventIdSchema = idSchema<"EventId">(ID_PREFIX.event);
export type EventId = z.infer<typeof EventIdSchema>;
export const SessionIdSchema = idSchema<"SessionId">(ID_PREFIX.session);
export type SessionId = z.infer<typeof SessionIdSchema>;
export const OperationIdSchema = idSchema<"OperationId">(ID_PREFIX.operation);
export type OperationId = z.infer<typeof OperationIdSchema>;

/** Maps a prefix to its branded id type. */
export interface IdByPrefix {
  prj: ProjectId;
  msn: MissionId;
  crw: CrewId;
  cmb: CrewMemberId;
  tsk: TaskId;
  tdp: TaskDependencyId;
  agt: AgentId;
  wtr: WorktreeId;
  cmd: CommandId;
  art: ArtifactId;
  apr: ApprovalId;
  pol: PolicyId;
  bgt: BudgetId;
  usg: UsageSampleId;
  aud: AuditEntryId;
  evt: EventId;
  ses: SessionId;
  op: OperationId;
}

const nextUlid = monotonicFactory();

/** Create a new id: `${prefix}_${ulid}`. ULIDs are monotonic within one process. */
export function newId<P extends IdPrefix>(prefix: P): IdByPrefix[P] {
  return `${prefix}_${nextUlid()}` as IdByPrefix[P];
}

/** ISO-8601 UTC timestamp ending in `Z` (as produced by `Date#toISOString`); lexically sortable. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Hex git object id (abbreviated or full; SHA-1 or SHA-256). */
export const GitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/, "expected a git sha");
