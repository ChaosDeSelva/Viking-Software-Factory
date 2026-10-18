import type { ExecutionStatus } from "@sindri/delivery";

/** Execution statuses after which `DeliveryLoop.run` does nothing (it returns at once). */
export const FINAL_STATUSES: ReadonlySet<string> = new Set<ExecutionStatus>([
  "verified_pending_review",
  "cancelled",
  "failed",
]);

/** Executions that have produced a delivery (the S6 delivery status lives on the report). */
export const DELIVERED_STATUSES: ReadonlySet<string> = new Set<ExecutionStatus>([
  "verified_pending_review",
]);
