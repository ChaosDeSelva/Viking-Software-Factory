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
});
