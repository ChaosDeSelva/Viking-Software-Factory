import { ensureDeliverySchema } from "@sindri/delivery";
import { openDatabase } from "@sindri/knowledge";
import { openPlanner } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import { eventSeq, projectOfExecution } from "./queries.js";

describe("queries", () => {
  it("has no project for an execution without a stored plan, and seq 0 for an unknown event", () => {
    const db = openDatabase(":memory:");
    openPlanner(db);
    ensureDeliverySchema(db);
    db.prepare(
      `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
       VALUES ('exe_1', 'pln_gone', 1, 'msn_1', 'running', '{}', '2026-01-01T00:00:00Z')`,
    ).run();
    expect(projectOfExecution(db, "exe_1")).toBeNull();
    expect(projectOfExecution(db, "exe_nope")).toBeNull();
    expect(eventSeq(db, "exe_1", "evt_nope")).toBe(0);
  });
});
