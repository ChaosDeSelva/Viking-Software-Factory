import { describe, expect, it } from "vitest";
import { EVENT_SCHEMA_VERSION, VERIFICATION_EVENT_TYPES, createEventSink } from "./events.js";

describe("event envelope (spec §13.3)", () => {
  it("lists exactly the six event types", () => {
    expect(VERIFICATION_EVENT_TYPES).toEqual([
      "verification.started",
      "verification.check.started",
      "verification.check.completed",
      "verification.completed",
      "verification.failed",
      "verification.cancelled",
    ]);
  });

  it("stamps schema version, unique ids, the correlation id, timestamp and a 1-based sequence", () => {
    const seen: unknown[] = [];
    let t = Date.parse("2026-10-14T12:00:00.000Z");
    const sink = createEventSink({
      correlationId: "exec-1",
      onEvent: (e) => seen.push(e),
      now: () => new Date((t += 1000)),
    });
    sink.emit("verification.started", { runId: "run_1" });
    sink.emit("verification.check.started", { runId: "run_1", checkId: "lint" });
    expect(seen).toEqual([
      {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: expect.stringMatching(/^evt_[0-9a-f-]{36}$/),
        correlationId: "exec-1",
        timestamp: "2026-10-14T12:00:01.000Z",
        sequence: 1,
        type: "verification.started",
        runId: "run_1",
      },
      expect.objectContaining({ sequence: 2, type: "verification.check.started", checkId: "lint" }),
    ]);
    const ids = seen.map((e) => (e as { eventId: string }).eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it("data cannot override envelope fields", () => {
    const seen: Array<Record<string, unknown>> = [];
    const sink = createEventSink<Record<string, unknown>>({
      correlationId: "c",
      onEvent: (e) => seen.push(e),
    });
    sink.emit("verification.started", { sequence: 99, correlationId: "evil" } as never);
    expect(seen[0]).toMatchObject({ sequence: 1, correlationId: "c" });
  });

  it("a throwing consumer does not break the run; the error is reported once", () => {
    const errors: unknown[] = [];
    const sink = createEventSink({
      correlationId: "c",
      onEvent: () => {
        throw new Error("consumer bug");
      },
      onListenerError: (e) => errors.push(e),
    });
    expect(() => sink.emit("verification.started", {})).not.toThrow();
    expect(() => sink.emit("verification.completed", {})).not.toThrow();
    expect(errors).toHaveLength(2);
  });
});
