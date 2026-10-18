import { applyMigrations, openKnowledge, type Knowledge } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { QUALITY_MIGRATIONS } from "./gates/migrations.js";
import { ensureDeliverySchema, ensureQualitySchema } from "./schema.js";

const SECRET = "SEEDED PROJECT TEXT";

/** Every row of every table, as one string per table. */
function dump(k: Knowledge): Record<string, string> {
  const tables = k.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, JSON.stringify(k.db.prepare(`SELECT * FROM "${name}"`).all())]),
  );
}

function seed(k: Knowledge, projectId: string, n: string) {
  const run = (sql: string, ...a: unknown[]) => k.db.prepare(sql).run(...a);
  const plan = JSON.stringify({ id: `pln_${n}`, projectId, objective: SECRET });
  run(
    `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at, project_id)
     VALUES (?, ?, 1, ?, 'running', ?, 't', ?)`,
    `exe_${n}`,
    `pln_${n}`,
    `msn_${n}`,
    plan,
    projectId,
  );
  run(
    `INSERT INTO execution_tasks (id, execution_id, plan_task_id, mimir_task_id, status)
     VALUES (?, ?, 'impl', ?, 'running')`,
    `ext_${n}`,
    `exe_${n}`,
    `tsk_${n}`,
  );
  run(
    `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
     VALUES (?, ?, ?, 'x', ?, 't')`,
    `eev_${n}`,
    `exe_${n}`,
    `evt_${n}`,
    JSON.stringify({ text: SECRET }),
  );
  run(
    `INSERT INTO gate_evaluations (id, execution_id, project_id, plan_task_id, mimir_task_id, passed,
       failures_json, advisories_json, evaluated_at)
     VALUES (?, ?, ?, 'impl', ?, 0, ?, '[]', 't')`,
    `gev_${n}`,
    `exe_${n}`,
    projectId,
    `tsk_${n}`,
    JSON.stringify([{ reason: SECRET }]),
  );
  run(
    `INSERT INTO gate_repairs (id, execution_id, project_id, plan_task_id, mimir_task_id, attempt,
       evaluation_id, instruction, created_at)
     VALUES (?, ?, ?, 'impl', ?, 1, ?, ?, 't')`,
    `grp_${n}`,
    `exe_${n}`,
    projectId,
    `tsk_${n}`,
    `gev_${n}`,
    SECRET,
  );
  run(
    `INSERT INTO reviews (id, execution_id, project_id, plan_task_id, implementer_task_id,
       implementer_crew_id, reviewer_crew_id, reviewer_task_id, role, origin, status, findings_json,
       requested_at)
     VALUES (?, ?, ?, 'impl', ?, 'crw_a', 'crw_b', ?, 'reviewer', 'created', 'completed', ?, 't')`,
    `rev_${n}`,
    `exe_${n}`,
    projectId,
    `tsk_${n}`,
    `tsk_r_${n}`,
    JSON.stringify([{ severity: "major", message: SECRET }]),
  );
  run(
    `INSERT INTO deliveries (id, execution_id, project_id, status, report_json, created_at)
     VALUES (?, ?, ?, 'delivered_pending_merge', ?, 't')`,
    `dlv_${n}`,
    `exe_${n}`,
    projectId,
    JSON.stringify({ summary: SECRET }),
  );
  run(
    `INSERT INTO pr_requests (id, delivery_id, project_id, plan_task_id, mimir_task_id, status, created_at)
     VALUES (?, ?, ?, 'impl', ?, 'requested', 't')`,
    `prr_${n}`,
    `dlv_${n}`,
    projectId,
    `tsk_${n}`,
  );
  const ev = k.evidence.record({
    projectId,
    externalRef: `mimir:evt_${n}`,
    kind: "test_run",
    payload: { text: SECRET },
  });
  run(
    `INSERT INTO delivery_evidence (delivery_id, ref_id, task_evidence_id, project_id) VALUES (?, ?, ?, ?)`,
    `dlv_${n}`,
    `evt_${n}`,
    ev.id,
    projectId,
  );
  run(
    `INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, source_refs_json,
       confidence, status, created_at)
     VALUES (?, ?, ?, 'entry', ?, ?, 0.5, 'proposed', 't')`,
    `kpr_${n}`,
    `dlv_${n}`,
    projectId,
    SECRET,
    JSON.stringify([{ taskEvidenceId: ev.id }]),
  );
}

describe("project purge reaches every delivery table (audit M4)", () => {
  it("cascades executions and deliveries from projects and purges the quality tables", () => {
    const k = openKnowledge(":memory:");
    ensureDeliverySchema(k.db);
    ensureQualitySchema(k.db);
    const p = k.projects.create({ name: "acme", repoPath: "/repos/acme" });
    const other = k.projects.create({ name: "other", repoPath: "/repos/other" });
    seed(k, p.id, "a");
    seed(k, other.id, "b");

    expect(() => k.projects.purge(p.id)).toThrow(/eraseEvidence/);
    k.projects.purge(p.id, { eraseEvidence: true });

    const after = dump(k);
    for (const [table, rows] of Object.entries(after)) {
      expect(rows.includes(p.id), `${table} still holds the project id`).toBe(false);
      for (const id of ["exe_a", "dlv_a", "gev_a", "grp_a", "rev_a", "kpr_a", "prr_a", "evt_a"])
        expect(rows.includes(id), `${table} still holds ${id}`).toBe(false);
    }
    // The other project's rows are untouched (its text is the same seeded string).
    for (const table of [
      "executions",
      "execution_tasks",
      "execution_events",
      "gate_evaluations",
      "gate_repairs",
      "reviews",
      "deliveries",
      "pr_requests",
      "delivery_evidence",
      "knowledge_proposals",
    ])
      expect(after[table], table).toContain("_b");
  });

  it("declares project_id foreign keys with ON DELETE CASCADE on executions and deliveries", () => {
    const k = openKnowledge(":memory:");
    ensureDeliverySchema(k.db);
    ensureQualitySchema(k.db);
    for (const table of ["executions", "deliveries"]) {
      const fks = k.db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      expect(fks, table).toContainEqual(
        expect.objectContaining({ table: "projects", from: "project_id", on_delete: "CASCADE" }),
      );
    }
  });

  it("upgrades existing deliveries: children kept, rows of purged projects dropped", () => {
    const k = openKnowledge(":memory:");
    applyMigrations(k.db, "delivery_quality", QUALITY_MIGRATIONS.slice(0, 2));
    const p = k.projects.create({ name: "acme", repoPath: "/repos/acme" });
    const run = (sql: string, ...a: unknown[]) => k.db.prepare(sql).run(...a);
    for (const [d, project] of [
      ["dlv_live", p.id],
      ["dlv_orphan", "prj_purged_before_m4"],
    ] as const) {
      run(
        `INSERT INTO deliveries (id, execution_id, project_id, status, report_json, created_at)
         VALUES (?, 'exe', ?, 'built', '{}', 't')`,
        d,
        project,
      );
      run(
        `INSERT INTO pr_requests (id, delivery_id, plan_task_id, mimir_task_id, status, created_at)
         VALUES (?, ?, 'impl', 'tsk', 'requested', 't')`,
        `prr_${d}`,
        d,
      );
      run(
        `INSERT INTO delivery_evidence (delivery_id, ref_id, task_evidence_id) VALUES (?, 'evt', 'tev')`,
        d,
      );
      run(
        `INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, source_refs_json,
           confidence, status, created_at)
         VALUES (?, ?, ?, 'entry', 'c', '[{"taskEvidenceId":"tev"}]', 0.5, 'proposed', 't')`,
        `kpr_${d}`,
        d,
        project,
      );
    }
    ensureQualitySchema(k.db);
    const ids = (table: string, col = "id") =>
      (k.db.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY 1`).all() as { v: string }[]).map(
        (r) => r.v,
      );
    expect(ids("deliveries")).toEqual(["dlv_live"]);
    expect(ids("pr_requests")).toEqual(["prr_dlv_live"]);
    expect(ids("delivery_evidence", "delivery_id")).toEqual(["dlv_live"]);
    expect(ids("knowledge_proposals")).toEqual(["kpr_dlv_live"]);
    expect(k.db.pragma("foreign_key_check")).toEqual([]);
    // Deleting the delivery's project now cascades through its children.
    k.db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
    for (const t of ["deliveries", "pr_requests", "knowledge_proposals"])
      expect(ids(t)).toEqual([]);
  });
});
