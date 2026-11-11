import { openDatabase } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { deliveryPurgeTargets, purgeDeliveryData } from "./delivery-purge.js";

const EMPTY = { planIds: [], executionIds: [], missionIds: [], deliveryIds: [], refIds: [] };

describe("deliveryPurgeTargets on databases from before the delivery tables", () => {
  it("finds nothing when neither plans nor executions exist", () => {
    const db = openDatabase(":memory:");
    expect(deliveryPurgeTargets(db, "prj_1")).toEqual(EMPTY);
    // Nothing to delete, and no table is required.
    expect(() => purgeDeliveryData(db, "prj_1", EMPTY)).not.toThrow();
  });

  it("finds the plans of a project that never ran", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE plans (id TEXT, project_id TEXT)");
    db.prepare("INSERT INTO plans VALUES (?, ?)").run("pln_1", "prj_1");
    db.prepare("INSERT INTO plans VALUES (?, ?)").run("pln_2", "prj_2");
    expect(deliveryPurgeTargets(db, "prj_1")).toEqual({ ...EMPTY, planIds: ["pln_1"] });
  });

  it("reaches executions through plans when they have no project column, and skips missing tables", () => {
    const db = openDatabase(":memory:");
    db.exec(`
      CREATE TABLE plans (id TEXT, project_id TEXT);
      CREATE TABLE executions (id TEXT, plan_id TEXT, mimir_mission_id TEXT);
      CREATE TABLE commands (idempotency_key TEXT, url TEXT, response TEXT);
    `);
    db.prepare("INSERT INTO plans VALUES ('pln_1', 'prj_1'), ('pln_2', 'prj_2')").run();
    db.prepare(
      "INSERT INTO executions VALUES ('exe_1', 'pln_1', 'msn_1'), ('exe_2', 'pln_1', NULL), ('exe_3', 'pln_2', 'msn_3')",
    ).run();
    db.prepare(
      `INSERT INTO commands VALUES ('k1', '/v1/executions/exe_1', '{}'), ('k2', '/v1/x', '{"m":"msn_1"}'),
         ('k3', '/v1/executions/exe_3', '{}'), ('keep', '/v1/executions/exe_1', '{}')`,
    ).run();
    const t = deliveryPurgeTargets(db, "prj_1");
    // A mission id that was never set is not a target.
    expect(t).toEqual({
      ...EMPTY,
      planIds: ["pln_1"],
      executionIds: ["exe_1", "exe_2"],
      missionIds: ["msn_1"],
    });
    purgeDeliveryData(db, "prj_1", t, "keep");
    expect(db.prepare("SELECT id FROM executions").all()).toEqual([{ id: "exe_3" }]);
    // The purge request's own idempotency row is kept; the rows naming the project's ids are not.
    expect(db.prepare("SELECT idempotency_key AS k FROM commands ORDER BY k").all()).toEqual([
      { k: "k3" },
      { k: "keep" },
    ]);
  });
});
