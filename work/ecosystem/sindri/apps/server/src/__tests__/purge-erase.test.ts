import { ensureDeliverySchema, ensureQualitySchema } from "@sindri/delivery";
import { openKnowledge } from "@sindri/knowledge";
import { afterEach, describe, expect, it } from "vitest";
import { makeHarness, type Harness } from "./helpers.js";

const TEXT = "PLATYPUS SEEDED TEXT";
let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** Every row of every table, as text. */
function dump(hh: Harness): Record<string, string> {
  const tables = hh.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      JSON.stringify(hh.db.prepare(`SELECT * FROM "${name}"`).all()),
    ]),
  );
}

/** `table.column` cells that contain `needle`, as text or as bytes, over every table. */
function leftovers(hh: Harness, needle: string): string[] {
  const tables = hh.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const out: string[] = [];
  for (const { name } of tables) {
    const cols = (hh.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    for (const col of cols) {
      const hit = hh.db
        .prepare(
          `SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${col}" AS BLOB), CAST(? AS BLOB)) > 0`,
        )
        .get(needle) as { n: number };
      if (hit.n > 0) out.push(`${name}.${col}`);
    }
  }
  return out;
}

/** Rows as the delivery packages write them: execution, review, gate repair, delivery, proposal. */
function seedDelivery(hh: Harness, projectId: string) {
  ensureDeliverySchema(hh.db);
  ensureQualitySchema(hh.db);
  const k = openKnowledge(hh.db);
  const run = (sql: string, ...a: unknown[]) => hh.db.prepare(sql).run(...a);
  run(
    `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at, project_id)
     VALUES ('exe_p', 'pln_p', 1, 'msn_p', 'verified_pending_review', ?, 't', ?)`,
    JSON.stringify({ id: "pln_p", projectId, objective: TEXT }),
    projectId,
  );
  run(
    `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
     VALUES ('eev_p', 'exe_p', 'evt_p', 'x', ?, 't')`,
    JSON.stringify({ text: TEXT }),
  );
  run(
    `INSERT INTO gate_evaluations (id, execution_id, project_id, plan_task_id, mimir_task_id, passed,
       failures_json, advisories_json, evaluated_at)
     VALUES ('gev_p', 'exe_p', ?, 'impl', 'tsk_p', 0, ?, '[]', 't')`,
    projectId,
    JSON.stringify([{ reason: TEXT }]),
  );
  run(
    `INSERT INTO gate_repairs (id, execution_id, project_id, plan_task_id, mimir_task_id, attempt,
       evaluation_id, instruction, created_at)
     VALUES ('grp_p', 'exe_p', ?, 'impl', 'tsk_p', 1, 'gev_p', ?, 't')`,
    projectId,
    TEXT,
  );
  run(
    `INSERT INTO reviews (id, execution_id, project_id, plan_task_id, implementer_task_id,
       implementer_crew_id, reviewer_crew_id, reviewer_task_id, role, origin, status, findings_json,
       requested_at)
     VALUES ('rev_p', 'exe_p', ?, 'impl', 'tsk_p', 'crw_a', 'crw_b', 'tsk_r', 'reviewer', 'created',
       'completed', ?, 't')`,
    projectId,
    JSON.stringify([{ severity: "minor", message: TEXT }]),
  );
  run(
    `INSERT INTO deliveries (id, execution_id, project_id, status, report_json, created_at)
     VALUES ('dlv_p', 'exe_p', ?, 'delivered_pending_merge', ?, 't')`,
    projectId,
    JSON.stringify({ summary: TEXT }),
  );
  const ev = k.evidence.record({
    projectId,
    externalRef: "mimir:evt_p",
    kind: "test_run",
    payload: { text: TEXT },
  });
  run(
    `INSERT INTO knowledge_proposals (id, delivery_id, project_id, kind, claim, source_refs_json,
       confidence, status, created_at)
     VALUES ('kpr_p', 'dlv_p', ?, 'decision', ?, ?, 0.5, 'proposed', 't')`,
    projectId,
    TEXT,
    JSON.stringify([{ taskEvidenceId: ev.id }]),
  );
  return ev;
}

describe("DELETE /v1/projects/:id/data with task evidence (audit M4)", () => {
  it("refuses without eraseEvidence, then erases everything but evidence tombstones with it", async () => {
    const hh = (h = await makeHarness());
    const projectId = (
      await hh.call({
        method: "POST",
        url: "/v1/projects",
        payload: { name: "Platypus", repoPath: hh.repoDir },
      })
    ).json().project.id as string;
    await hh.call({
      method: "POST",
      url: "/v1/intakes",
      payload: { projectId, title: "Export", body: TEXT },
    });
    const ev = seedDelivery(hh, projectId);
    const before = dump(hh);
    for (const table of ["executions", "reviews", "gate_repairs", "deliveries", "task_evidence"])
      expect(before[table], table).toContain(projectId);

    const refused = await hh.call({
      method: "DELETE",
      url: `/v1/projects/${projectId}/data`,
      payload: { confirm: "Platypus" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("invalid_state");
    expect(refused.json().error.message).toMatch(/eraseEvidence/);

    const del = await hh.call({
      method: "DELETE",
      url: `/v1/projects/${projectId}/data`,
      payload: { confirm: "Platypus", eraseEvidence: true },
      key: "purge-key",
      headers: await hh.approvalHeaders(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ deleted: { projectId, evidenceErased: 1 } });

    for (const [table, rows] of Object.entries(dump(hh))) {
      expect(rows.includes(projectId), `${table} still holds the project id`).toBe(false);
      expect(rows.includes(TEXT), `${table} still holds seeded text`).toBe(false);
    }
    // Review I3: every column of every table, text and BLOB, with no row left out (the purge
    // request's own idempotency record included).
    expect(leftovers(hh, projectId)).toEqual([]);
    expect(leftovers(hh, TEXT)).toEqual([]);
    // A retried DELETE with the same key still replays, from the hashed receipt.
    const again = await hh.call({
      method: "DELETE",
      url: `/v1/projects/${projectId}/data`,
      payload: { confirm: "Platypus", eraseEvidence: true },
      key: "purge-key",
      headers: await hh.approvalHeaders(),
    });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.json()).toEqual({ replayed: true });
    // The evidence row survives as a tombstone: id and hash only.
    const tomb = hh.db.prepare("SELECT * FROM task_evidence WHERE id = ?").get(ev.id);
    expect(tomb).toMatchObject({
      id: ev.id,
      project_id: null,
      payload_json: "null",
      content_sha256: ev.contentSha256,
    });
  });
});
