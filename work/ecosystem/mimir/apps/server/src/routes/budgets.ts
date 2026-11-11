import { isDeepStrictEqual } from "node:util";
import { MISSION_TERMINAL_STATUSES } from "@mimir/core";
import {
  MimirError,
  UpdateBudgetRequestSchema,
  newId,
  type BudgetPolicy,
  type UpdateBudgetResponse,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { emitProjected } from "../emit.js";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { byCreated } from "./common.js";
import { DEFAULT_WARN_AT_FRACTION, checkBudgetInput } from "./missions.js";

/**
 * `PATCH /v1/crews/:id/budget` and `PATCH /v1/missions/:id/budget`: the operator's way out of
 * `budget_exceeded`. Merges the given fields onto the scope's budget (or creates one) and appends
 * `budget.updated`; the scheduler unblocks tasks held only by that budget on its next tick.
 * Repeating a request (or sending the stored values) appends nothing.
 */
export function budgetRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const rm = ctx.readModel;

  for (const scope of ["crews", "missions"] as const) {
    app.patch(
      `/v1/${scope}/:id/budget`,
      idempotent(ctx, `${scope === "crews" ? "crew" : "mission"}.budget.update`, (request) => {
        const { id } = parseWith(z.object({ id: z.string().min(1) }), request.params);
        const body = parseWith(UpdateBudgetRequestSchema, request.body ?? {});
        let missionId: string;
        let crewId: string | null;
        if (scope === "crews") {
          const crew = rm.crews.get(id);
          if (!crew) throw new MimirError("not_found", `crew ${id} not found`, { crewId: id });
          missionId = crew.missionId;
          crewId = crew.id;
        } else {
          if (!rm.missions.has(id))
            throw new MimirError("not_found", `mission ${id} not found`, { missionId: id });
          missionId = id;
          crewId = null;
        }
        const mission = rm.missions.get(missionId);
        if (!mission || MISSION_TERMINAL_STATUSES.has(mission.status))
          throw new MimirError("invalid_transition", `mission is ${mission?.status ?? "gone"}`, {
            missionId,
          });
        const current = [...rm.budgets.values()]
          .filter((b) => b.crewId === crewId && b.missionId === missionId)
          .sort(byCreated)[0];
        if (body.expectedVersion !== undefined && body.expectedVersion !== (current?.version ?? 0))
          throw new MimirError("conflict", "budget version changed", {
            version: current?.version ?? null,
          });
        const iso = ctx.now().toISOString();
        const merged: BudgetPolicy = {
          id: current?.id ?? (newId("bgt") as BudgetPolicy["id"]),
          missionId: missionId as BudgetPolicy["missionId"],
          crewId: crewId as BudgetPolicy["crewId"],
          limitTokens:
            body.limitTokens !== undefined ? body.limitTokens : (current?.limitTokens ?? null),
          limitCost: body.limitCost !== undefined ? body.limitCost : (current?.limitCost ?? null),
          warnAtFraction:
            body.warnAtFraction ?? current?.warnAtFraction ?? DEFAULT_WARN_AT_FRACTION,
          ...((body.enforce ?? current?.enforce) !== undefined
            ? { enforce: body.enforce ?? current!.enforce! }
            : {}),
          ...((body.onUnknown ?? current?.onUnknown) !== undefined
            ? { onUnknown: body.onUnknown ?? current!.onUnknown! }
            : {}),
          createdAt: current?.createdAt ?? iso,
          updatedAt: current?.updatedAt ?? iso,
          version: current?.version ?? 0,
        };
        if (!current && merged.limitTokens === null && merged.limitCost === null)
          throw new MimirError("validation_failed", "a new budget needs limitTokens or limitCost", {
            reason: "budget_limit_required",
          });
        checkBudgetInput(
          {
            ...(merged.limitTokens !== null ? { limitTokens: merged.limitTokens } : {}),
            ...(merged.limitCost !== null ? { limitCost: merged.limitCost } : {}),
            ...(merged.enforce !== undefined ? { enforce: merged.enforce } : {}),
            ...(merged.onUnknown !== undefined ? { onUnknown: merged.onUnknown } : {}),
          },
          ctx.runtimeReportsUsage,
        );
        if (current && isDeepStrictEqual(merged, current)) {
          const same: UpdateBudgetResponse = { budget: current, changed: false };
          return { status: 200, body: same, target: current.id };
        }
        const budget: BudgetPolicy = current
          ? { ...merged, updatedAt: iso, version: current.version + 1 }
          : merged;
        emitProjected(ctx.store, ctx.now(), {
          type: "budget.updated",
          streamId: `budget:${budget.id}`,
          missionId,
          ...(crewId !== null ? { crewId } : {}),
          payload: { budget, previous: current ?? null },
        });
        const response: UpdateBudgetResponse = { budget, changed: true };
        return { status: 200, body: response, target: budget.id };
      }),
    );
  }
}
