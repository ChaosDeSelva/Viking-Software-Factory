import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type EventEnvelope } from "@mimir/protocol";
import type { AppendInput } from "./event-store.js";

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mimir-core-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function eventInput(overrides: Partial<AppendInput> = {}): AppendInput {
  const now = new Date().toISOString();
  const base: Omit<EventEnvelope, "id" | "sequence" | "schemaVersion"> = {
    streamId: "mission-1",
    occurredAt: now,
    observedAt: now,
    type: "task.created",
    source: "mimir",
    provenance: "observed",
    payload: { title: "hello" },
  };
  return { ...base, ...overrides };
}

export { newId };
