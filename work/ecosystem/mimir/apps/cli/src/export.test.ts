import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportMission } from "./export.js";

const MISSION = "msn_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-export-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("exportMission pagination", () => {
  it("terminates and exports every event across several pages", () => {
    const data = join(home, "data");
    mkdirSync(data, { recursive: true });
    const store = openEventStore(join(data, "mimir.db"));
    const now = new Date().toISOString();
    const base = {
      occurredAt: now,
      observedAt: now,
      source: "mimir",
      provenance: "observed" as const,
    };
    store.appendMany(
      Array.from({ length: 1201 }, (_, i) => ({
        ...base,
        streamId: i % 2 ? MISSION : "other",
        type: "task.created" as const,
        ...(i % 2 ? { missionId: MISSION as never } : {}),
        payload: { i },
      })),
    );
    store.close();
    const out = join(home, "out.json");
    const r = exportMission(MISSION, out, {}, { ...process.env, MIMIR_DATA_DIR: data });
    expect(r.count).toBe(600);
    const file = JSON.parse(readFileSync(out, "utf8")) as { events: { payload: { i: number } }[] };
    expect(file.events.map((e) => e.payload.i)).toEqual(
      Array.from({ length: 600 }, (_, k) => 2 * k + 1),
    );
  }, 10_000);
});
