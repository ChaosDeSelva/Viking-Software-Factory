import { describe, expect, it } from "vitest";
import * as core from "./index.js";

describe("@mimir/core", () => {
  it("exports its package name", () => {
    expect(core.PACKAGE_NAME).toBe("@mimir/core");
  });

  it("exports the store and redaction API", () => {
    for (const name of [
      "openEventStore",
      "EventStore",
      "CommandLedger",
      "AuditLog",
      "hashRequest",
      "migrate",
      "listMigrations",
      "openDatabase",
      "acquireLock",
      "encodeCursor",
      "decodeCursor",
      "boundPayload",
      "redact",
      "redactPayload",
    ]) {
      expect(typeof (core as Record<string, unknown>)[name], name).toBe("function");
    }
    expect(core.DEFAULT_MAX_PAYLOAD_BYTES).toBe(262144);
    expect(core.MIN_MAX_PAYLOAD_BYTES).toBe(256);
    expect(core.DEFAULT_LOCK_STALE_MS).toBe(5000);
    expect(core.SENSITIVE_KEY_PATTERN.test("client_secret")).toBe(true);
    const store = core.openEventStore(":memory:");
    expect(store.latestCursor()).toBe(core.encodeCursor(0));
    store.close();
  });
});
