import { ensureDeliverySchema, ensureQualitySchema } from "@sindri/delivery";
import { openDatabase } from "@sindri/knowledge";
import { openPlanner } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import { deliveriesWork, eventSeq, projectOfExecution } from "./queries.js";

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

  it("says a delivery's checks failed only because a reviewer asked for changes", () => {
    const db = openDatabase(":memory:");
    openPlanner(db);
    ensureDeliverySchema(db);
    ensureQualitySchema(db);
    const plan = JSON.stringify({
      tasks: [{ id: "proposal" }, { id: "fact-check" }],
      work: { kind: "proposal", proposal: { text: "Plan" } },
    });
    const gate = db.prepare(
      `INSERT INTO gate_evaluations (id, execution_id, plan_task_id, mimir_task_id, passed,
         engineering_verdict, failures_json, advisories_json, evaluated_at)
       VALUES (?, ?, ?, 'tsk', ?, 'pass', ?, '[]', '2026-01-01T00:00:00Z')`,
    );
    const changes = JSON.stringify([
      { gateId: "review-verdict", reason: "review_request_changes" },
    ]);
    const broken = JSON.stringify([{ gateId: "proposal-diagrams", reason: "too_few_diagrams:0" }]);
    for (const [id, gates] of [
      [
        "exe_changes",
        [
          ["proposal", 1, "[]"],
          ["fact-check", 0, changes],
        ],
      ],
      [
        "exe_broken",
        [
          ["proposal", 0, broken],
          ["fact-check", 0, changes],
        ],
      ],
      [
        "exe_passed",
        [
          ["proposal", 1, "[]"],
          ["fact-check", 1, "[]"],
        ],
      ],
    ] as const) {
      db.prepare(
        `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
         VALUES (?, 'pln', 1, ?, 'verified_pending_review', ?, '2026-01-01T00:00:00Z')`,
      ).run(id, `msn_${id}`, plan);
      for (const [task, passed, failures] of gates)
        gate.run(`${id}:${task}`, id, task, passed, failures);
    }
    const work = deliveriesWork(db, ["exe_changes", "exe_broken", "exe_passed"]);
    expect(work.get("exe_changes")?.work).toMatchObject({
      gatePassed: false,
      changesRequested: true,
    });
    expect(work.get("exe_broken")?.work).toMatchObject({
      gatePassed: false,
      changesRequested: false,
    });
    expect(work.get("exe_passed")?.work).toMatchObject({
      gatePassed: true,
      changesRequested: false,
    });
  });

  it("says a plan is replaced once a revision of it was decided, accepted or rejected", () => {
    const db = openDatabase(":memory:");
    ensureDeliverySchema(db);
    ensureQualitySchema(db);
    // Only the columns the link reads: intake → spec → plan → run (no project rows).
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE IF NOT EXISTS intakes (id TEXT PRIMARY KEY, work_kind TEXT, linked_execution_id TEXT);
      CREATE TABLE IF NOT EXISTS specifications (id TEXT PRIMARY KEY, intake_id TEXT, title TEXT);
      CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, spec_id TEXT);
    `);
    const plan = JSON.stringify({
      tasks: [{ id: "proposal" }],
      work: { kind: "proposal", proposal: { text: "Plan" } },
    });
    const run = db.prepare(
      `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
       VALUES (?, ?, 1, ?, 'verified_pending_review', ?, '2026-01-01T00:00:00Z')`,
    );
    const revision = (n: number, earlier: string) => {
      db.prepare("INSERT INTO intakes VALUES (?, 'proposal', ?)").run(`int_${n}`, earlier);
      db.prepare("INSERT INTO specifications VALUES (?, ?, ?)").run(`spc_${n}`, `int_${n}`, `v${n}`);
      db.prepare("INSERT INTO plans VALUES (?, ?)").run(`pln_${n}`, `spc_${n}`);
      run.run(`exe_v${n}`, `pln_${n}`, `msn_${n}`, plan);
    };
    run.run("exe_v1", "pln_1", "msn_1", plan);
    revision(2, "exe_v1");
    revision(3, "exe_v2");
    const decide = (id: string, decision: string) =>
      db
        .prepare(
          `INSERT INTO document_decisions (execution_id, project_id, delivery_id, decision, actor, decided_at)
           VALUES (?, 'prj', NULL, ?, 'jacob', '2026-01-02T00:00:00Z')`,
        )
        .run(id, decision);
    // v3 not decided yet: v2 still waits.
    decide("exe_v2", "rejected");
    const work = deliveriesWork(db, ["exe_v1", "exe_v2", "exe_v3"]);
    expect(work.get("exe_v1")?.work.replacedBy).toBe("exe_v2");
    expect(work.get("exe_v2")?.work.replacedBy).toBeNull();
    expect(work.get("exe_v3")?.work.replacedBy).toBeNull();
  });
});
