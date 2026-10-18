import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CheckResultSchema,
  VerdictSchema,
  VerificationReportSchema,
  type CheckResult,
  type Verdict,
  type VerificationReport,
} from "@brokkr/core";

/** Version of the verification event contract (spec §13.3). */
export const EVENT_SCHEMA_VERSION = 1 as const;

/** The six verification event types, in lifecycle order. */
export const VERIFICATION_EVENT_TYPES = [
  "verification.started",
  "verification.check.started",
  "verification.check.completed",
  "verification.completed",
  "verification.failed",
  "verification.cancelled",
] as const;
export type VerificationEventType = (typeof VERIFICATION_EVENT_TYPES)[number];

/** Fields every event carries. `sequence` starts at 1 and is ordered within one run only. */
export interface EventEnvelope<T extends VerificationEventType = VerificationEventType> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  /** Unique per event (`evt_<uuid>`). */
  eventId: string;
  /** Execution correlation id supplied by the caller (or generated), also the report's `executionId`. */
  correlationId: string;
  /** ISO-8601 UTC. */
  timestamp: string;
  sequence: number;
  type: T;
}

export interface EventSinkOptions<E> {
  correlationId: string;
  onEvent?: ((event: E) => void) | undefined;
  /** Called when `onEvent` throws; the run continues. */
  onListenerError?: (error: unknown) => void;
  now?: () => Date;
}

export interface EventSink {
  emit(type: VerificationEventType, data: object): void;
}

/** Stamps envelopes onto event data and delivers them synchronously, in order. */
export function createEventSink<E>(options: EventSinkOptions<E>): EventSink {
  let sequence = 0;
  const now = options.now ?? (() => new Date());
  return {
    emit(type, data) {
      sequence += 1;
      const envelope = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: `evt_${randomUUID()}`,
        correlationId: options.correlationId,
        timestamp: now().toISOString(),
        sequence,
        type,
      };
      // Envelope first for readable JSON, and again last so data can never override it.
      const event = { ...envelope, ...data, ...envelope };
      if (!options.onEvent) return;
      try {
        options.onEvent(event as E);
      } catch (error) {
        options.onListenerError?.(error);
      }
    },
  };
}

// ------------------------------------------------------------- payloads

type Envelope<T extends VerificationEventType> = EventEnvelope<T>;

/** First event of a run. */
export interface VerificationStartedEvent extends Envelope<"verification.started"> {
  runId: string;
  /** Absolute run directory (`<home>/.brokkr/runs/<sha256(workspace)>/<runId>`, outside the workspace). */
  runDir: string;
  workspace: string;
  taskId?: string;
  /** `name@version` of every harness in the run. */
  harnesses: string[];
  /** Number of planned checks. */
  checks: number;
}

/** A check is about to execute. Checks skipped before execution emit only `check.completed`. */
export interface CheckStartedEvent extends Envelope<"verification.check.started"> {
  runId: string;
  checkId: string;
  command: string[];
}

/** A check has a final result (passed, failed, errored, skipped, cancelled, timed_out). */
export interface CheckCompletedEvent extends Envelope<"verification.check.completed"> {
  runId: string;
  checkId: string;
  result: CheckResult;
}

interface RunOutcome {
  runId: string;
  runDir: string;
  verdict: Verdict;
  summary: VerificationReport["summary"];
  reasons: string[];
}

/** The run finished and its report is stored; read `verdict` (it may be failed, incomplete or blocked). */
export interface VerificationCompletedEvent
  extends Envelope<"verification.completed">, RunOutcome {}

/** The run was interrupted by the caller's AbortSignal; the partial report is stored. */
export interface VerificationCancelledEvent
  extends Envelope<"verification.cancelled">, RunOutcome {}

/** Verification could not produce a report (invalid input, infrastructure error). Always the last event. */
export interface VerificationFailedEvent extends Envelope<"verification.failed"> {
  runId?: string;
  error: { code: string; message: string };
}

export type VerificationEvent =
  | VerificationStartedEvent
  | CheckStartedEvent
  | CheckCompletedEvent
  | VerificationCompletedEvent
  | VerificationCancelledEvent
  | VerificationFailedEvent;

// --------------------------------------------------------------- schema

const envelope = <T extends VerificationEventType>(type: T) => ({
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  eventId: z.string().min(1),
  correlationId: z.string().min(1),
  timestamp: z.iso.datetime(),
  sequence: z.number().int().positive(),
  type: z.literal(type),
});
const outcome = {
  runId: z.string().min(1),
  runDir: z.string().min(1),
  verdict: VerdictSchema,
  summary: VerificationReportSchema.shape.summary,
  reasons: z.array(z.string()),
};

/** Runtime schema of every event (published as `schemas/verification-event.v1.json`). */
export const VerificationEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope("verification.started"),
    runId: z.string().min(1),
    runDir: z.string().min(1),
    workspace: z.string().min(1),
    taskId: z.string().optional(),
    harnesses: z.array(z.string()),
    checks: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ...envelope("verification.check.started"),
    runId: z.string().min(1),
    checkId: z.string().min(1),
    command: z.array(z.string()),
  }),
  z.strictObject({
    ...envelope("verification.check.completed"),
    runId: z.string().min(1),
    checkId: z.string().min(1),
    result: CheckResultSchema,
  }),
  z.strictObject({ ...envelope("verification.completed"), ...outcome }),
  z.strictObject({ ...envelope("verification.cancelled"), ...outcome }),
  z.strictObject({
    ...envelope("verification.failed"),
    runId: z.string().optional(),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
]);
