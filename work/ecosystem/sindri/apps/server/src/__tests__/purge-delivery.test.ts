import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvedPlan, approvedSpec } from "./flow.js";
import { startMimirFlow, until, type MimirFlow } from "./mimir-flow.js";

let f: MimirFlow | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

/** Every row of every table, as text (the purge's own receipt holds only hashes, review I3). */
function dumpTables(flow: MimirFlow): Record<string, string> {
  const tables = flow.h.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      JSON.stringify(flow.h.db.prepare(`SELECT * FROM "${name}"`).all()),
    ]),
  );
}

describe("DELETE /v1/projects/:id/data purges delivery data (audit M4)", () => {
  it("leaves no execution, event, review, gate or delivery rows, and no text in the db or WAL", async () => {
    const flow = (f = await startMimirFlow({
      "implement-frontend": [{ kind: "approval", action: "fs.write", reason: "write export.ts" }],
    }));
    const plan = await approvedPlan(flow, await approvedSpec(flow));
    const created = await flow.h.call({
      method: "POST",
      url: "/v1/executions",
      payload: { planId: plan.id },
    });
    const execution = created.json().execution as { id: string; mimirMissionId: string };
    const detail = async () =>
      (await flow.h.call({ url: `/v1/executions/${execution.id}` })).json();
    await until(detail, (d) => d.execution.status === "awaiting_human");
    const approval = (await detail()).approvals[0];
    await flow.h.call({
      method: "POST",
      url: `/v1/executions/${execution.id}/approvals/${approval.id}`,
      payload: { decision: "approved" },
      headers: await flow.h.approvalHeaders(),
    });
    await until(detail, (d) => d.execution.status === "verified_pending_review");
    // Wait for the quality assessment (reviews, gate evaluations, delivery report).
    await until(detail, (d) => d.gates.length === plan.tasks.length);
    await until(
      async () => (await flow.h.call({ url: `/v1/deliveries/${execution.id}` })).statusCode,
      (c) => c === 200,
    );

    const markers = [
      flow.projectId,
      plan.id,
      execution.id,
      execution.mimirMissionId,
      "for the reports CSV export",
      "write export.ts",
    ];
    const before = dumpTables(flow);
    for (const table of [
      "executions",
      "execution_events",
      "gate_evaluations",
      "reviews",
      "deliveries",
    ])
      expect(before[table], table).toContain(execution.id);

    const del = await flow.h.call({
      method: "DELETE",
      url: `/v1/projects/${flow.projectId}/data`,
      payload: { confirm: "Reports" },
      key: "purge-key",
    });
    expect(del.statusCode).toBe(200);

    const after = dumpTables(flow);
    for (const [table, rows] of Object.entries(after))
      for (const m of markers) expect(rows.includes(m), `${table} still holds ${m}`).toBe(false);
    for (const table of [
      "executions",
      "execution_tasks",
      "execution_events",
      "execution_approvals",
      "artifacts_refs",
      "gate_evaluations",
      "reviews",
      "deliveries",
    ])
      expect(after[table], table).toBe("[]");

    // Deleted pages are zeroed (secure_delete) and the WAL is checkpointed and truncated.
    const dbPath = join(flow.h.dir, "sindri.db");
    const bytes = [dbPath, `${dbPath}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString("latin1"))
      .join("");
    // The purge's own idempotency record keeps only hashes (review I3), so nothing is left.
    for (const m of markers) expect(bytes.includes(m), `file bytes still hold ${m}`).toBe(false);
    expect((await flow.h.call({ url: `/v1/executions/${execution.id}` })).statusCode).toBe(404);
  });
});
