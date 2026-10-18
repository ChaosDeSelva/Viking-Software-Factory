import type { CommandRecord } from "@mimir/core";
import { newId, type OperationAccepted } from "@mimir/protocol";

/** Body for 202 responses: `OperationAccepted` plus resource fields for convenience. */
export function accepted<T extends object>(
  command: CommandRecord,
  extra: T,
): OperationAccepted & T {
  return {
    operationId: newId("op"),
    commandId: command.id as OperationAccepted["commandId"],
    ...extra,
  };
}

export const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;
