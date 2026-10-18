export const PACKAGE_NAME = "@sindri/mimir-client";

export {
  MimirClientError,
  MimirClientFacade,
  type ConnectConfig,
  type FollowOptions,
  type FollowStream,
  type MimirClientErrorCode,
  type MimirClientFacadeOptions,
  type CreateTaskInput,
  type MissionSubmission,
} from "./facade.js";
export {
  crewKey,
  DEFAULT_AGENT_KIND,
  DEFAULT_HUMAN_RETRIES,
  idempotencyKey,
  mapPlan,
  mimirRoleFor,
  type AgentKindResolver,
  type MapPlanOptions,
  type MappedCrew,
  type MappedPlan,
  type MappedTask,
} from "./mapping.js";
export { MIMIR_CLIENT_MIGRATIONS } from "./migrations.js";
/** Protocol types Sindri code may name without importing `@mimir/*` itself. */
export {
  isMimirError,
  MimirError,
  type Approval,
  type ApprovalDecision,
  type Artifact,
  type EventEnvelope,
  type EventType,
  type MimirEvent,
  type MissionId,
  type Task as MimirTask,
  type TaskId as MimirTaskId,
  type TaskStatus as MimirTaskStatus,
  type TypedEvent,
} from "@mimir/protocol";
