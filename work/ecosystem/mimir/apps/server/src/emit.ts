import type { AppendInput, EventStore } from "@mimir/core";
import {
  MimirError,
  payloadSchemaFor,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  type Provenance,
} from "@mimir/protocol";

/** Default `source` for events Mimir derives itself (commands, scheduler, orchestrator). */
export const SERVER_SOURCE = "mimir.server";

export interface EmitInput<T extends EventType> {
  type: T;
  /** Ordering is per stream only, e.g. `task:<id>`, `session:<id>`, `mission:<id>`. */
  streamId: string;
  payload: EventPayloadMap[T];
  provenance?: Provenance;
  source?: string;
  sourceEventId?: string;
  /** When the source observed it (runtime events); defaults to `now`. */
  observedAt?: string;
  correlationId?: string;
  missionId?: string;
  crewId?: string;
  taskId?: string;
  sessionId?: string;
}

/**
 * Appends one event after checking its payload against the protocol schema, so a malformed
 * payload is a loud programming error here instead of an event the read model silently skips.
 * Returns the stored envelope (a dedupe hit returns the earlier event).
 */
export function emit<T extends EventType>(
  store: EventStore,
  now: Date,
  input: EmitInput<T>,
): EventEnvelope {
  payloadSchemaFor(input.type).parse(input.payload);
  const at = now.toISOString();
  const event: AppendInput = {
    type: input.type,
    streamId: input.streamId,
    payload: input.payload,
    occurredAt: at,
    observedAt: input.observedAt ?? at,
    source: input.source ?? SERVER_SOURCE,
    provenance: input.provenance ?? "derived",
  };
  const optional = [
    "sourceEventId",
    "correlationId",
    "missionId",
    "crewId",
    "taskId",
    "sessionId",
  ] as const;
  for (const key of optional) {
    const value = input[key];
    if (value !== undefined) (event as Record<string, unknown>)[key] = value;
  }
  return store.append(event);
}

/**
 * `emit` for an event the read model must project (what a command creates or changes). The
 * store keeps a payload over its byte bound only as a truncation marker, which the read model
 * skips: the command would succeed for an entity that never exists. Such a request is refused
 * (422) and the append rolled back, with the caller's transaction if there is one.
 */
export function emitProjected<T extends EventType>(
  store: EventStore,
  now: Date,
  input: EmitInput<T>,
): EventEnvelope {
  return store.withTransaction(() => {
    const event = emit(store, now, input);
    if (!payloadSchemaFor(input.type).safeParse(event.payload).success) {
      throw new MimirError("validation_failed", "the request is too large to store", {
        reason: "payload_too_large",
        type: input.type,
      });
    }
    return event;
  });
}
