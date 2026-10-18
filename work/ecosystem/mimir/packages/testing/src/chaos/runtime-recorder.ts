import type {
  EventEnvelope,
  RuntimeAdapter,
  RuntimeEvent,
  RuntimeSessionState,
  SessionId,
} from "@mimir/protocol";

/** What `EventStore.append` takes. */
export type AppendLike = Omit<EventEnvelope, "id" | "sequence" | "schemaVersion">;

/** Anything with the store's `append` (dedupes on `(source, sourceEventId)`). */
export interface EventAppender {
  append(input: AppendLike): unknown;
}

export interface RecordRuntimeOptions {
  /** Envelope `source`. Default `runtime:fake`. */
  source?: string;
  /** Stream for runtime-wide events (`recovery.reconciled`). Default `runtime`. */
  runtimeStreamId?: string;
}

export interface RuntimeRecording {
  /** Gaps seen so far. */
  readonly gaps: number;
  /** Resolves once every reconcile triggered so far has been recorded. */
  idle(): Promise<void>;
  close(): void;
}

/**
 * Test bridge from a RuntimeAdapter subscription to the durable log, standing in for the
 * orchestrator's ingestion (T12) so runtime chaos can be checked against the real store now.
 *
 * - Session events become `session.*` envelopes on stream `session:<id>`, with provenance
 *   `observed` and `sourceEventId`s derived from runtime identity, so re-delivery dedupes.
 * - `runtime.gap` triggers `reconcile()`: a `recovery.reconciled {gap: true}` is appended, then
 *   one `session.state_changed` per session whose observed state differs from the last recorded
 *   one, and `session.lost` per lost session. Reconcile-derived ids are deterministic, so a second
 *   reconcile (or a restarted recorder) appends no duplicate session events.
 */
export async function recordRuntime(
  adapter: RuntimeAdapter,
  appender: EventAppender,
  opts: RecordRuntimeOptions = {},
): Promise<RuntimeRecording> {
  const source = opts.source ?? "runtime:fake";
  const runtimeStream = opts.runtimeStreamId ?? "runtime";
  const lastState = new Map<string, RuntimeSessionState>();
  const pending: Promise<void>[] = [];
  let gaps = 0;
  let closed = false;

  const base = (observedAt: string, sessionId?: string) => ({
    occurredAt: observedAt,
    observedAt,
    source,
    provenance: "observed" as const,
    streamId: sessionId === undefined ? runtimeStream : `session:${sessionId}`,
    // Runtime session ids are the Mimir session ids the orchestrator passed to createSession.
    ...(sessionId === undefined ? {} : { sessionId: sessionId as SessionId }),
  });

  const recordState = (
    sessionId: string,
    to: RuntimeSessionState,
    observedAt: string,
    sourceEventId: string,
    runtimeStatus?: string,
  ) => {
    const from = lastState.get(sessionId) ?? "starting";
    lastState.set(sessionId, to);
    appender.append({
      ...base(observedAt, sessionId),
      type: "session.state_changed",
      sourceEventId,
      payload: { from, to, ...(runtimeStatus === undefined ? {} : { runtimeStatus }) },
    });
  };

  const recordLost = (sessionId: string, reason: string, observedAt: string) =>
    appender.append({
      ...base(observedAt, sessionId),
      type: "session.lost",
      sourceEventId: `${sessionId}:lost`,
      payload: { reason },
    });

  const reconcile = async (observedAt: string): Promise<void> => {
    const { sessions, lost } = await adapter.reconcile();
    if (closed) return;
    appender.append({
      ...base(observedAt),
      type: "recovery.reconciled",
      payload: { sessions: sessions.length, lostSessionIds: lost, gap: true },
    });
    for (const s of sessions) {
      if (lastState.get(s.sessionId) === s.state) continue;
      recordState(
        s.sessionId,
        s.state,
        s.lastObservedAt,
        `${s.sessionId}:reconciled:${s.state}:${s.lastObservedAt}`,
      );
    }
    for (const id of lost) recordLost(id, "lost (reconcile)", observedAt);
  };

  const onEvent = (e: RuntimeEvent): void => {
    if (closed) return;
    switch (e.kind) {
      case "session.state_changed":
        recordState(
          e.sessionId,
          e.state,
          e.observedAt,
          e.sourceEventId !== undefined
            ? `${e.sessionId}:state:${e.sourceEventId}`
            : `${e.sessionId}:state:${e.state}:${e.observedAt}`,
          e.runtimeStatus,
        );
        return;
      case "session.output":
        appender.append({
          ...base(e.observedAt, e.sessionId),
          type: "session.output",
          payload: { text: e.text, redacted: false, lines: e.text.split("\n").length },
        });
        return;
      case "session.exited":
        appender.append({
          ...base(e.observedAt, e.sessionId),
          type: "session.exited",
          sourceEventId: `${e.sessionId}:exited`,
          payload: e.exitCode === undefined ? {} : { exitCode: e.exitCode },
        });
        return;
      case "session.lost":
        recordLost(e.sessionId, e.reason, e.observedAt);
        return;
      case "runtime.gap":
        gaps += 1;
        pending.push(reconcile(e.observedAt));
        return;
    }
  };

  const sub = await adapter.subscribe(onEvent);
  return {
    get gaps() {
      return gaps;
    },
    idle: async () => {
      while (pending.length > 0) await pending.shift();
    },
    close: () => {
      closed = true;
      sub.close();
    },
  };
}
