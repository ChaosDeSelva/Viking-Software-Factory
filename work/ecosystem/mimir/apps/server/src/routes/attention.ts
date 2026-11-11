import { MISSION_TERMINAL_STATUSES, blockedTooLong, budgetGuard, stuckDetector } from "@mimir/core";
import type { FastifyInstance } from "fastify";
import { toBudgetPolicy } from "../orchestrator/orchestrator.js";

export const DEFAULT_BLOCKED_THRESHOLD_MS = 10 * 60 * 1000;
export const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60 * 1000;

const STUCK_STATES = new Set(["starting", "running", "waiting", "idle"]);

export type AttentionEntry =
  | {
      kind: "blocked_too_long";
      taskId: string;
      missionId: string;
      reason: string | null;
      since: string;
      ageMs: number;
      thresholdMs: number;
    }
  | {
      kind: "stuck";
      sessionId: string;
      taskId: string | null;
      since: string;
      ageMs: number;
      thresholdMs: number;
    }
  | {
      kind: "approval_pending";
      approvalId: string;
      action: string;
      taskId: string | null;
      missionId: string | null;
      since: string;
    }
  | {
      kind: "budget_warning" | "budget_exceeded";
      budgetId: string;
      scope: "crew" | "mission" | "project";
      missionId: string | null;
      crewId: string | null;
      spentTokens: number;
      spentCost: number;
      /** The limits spend is measured against (null: unlimited in that dimension). */
      limitTokens: number | null;
      limitCost: number | null;
      /** Bumped by each operator change (`PATCH /v1/crews/:id/budget`, `.../missions/:id/budget`). */
      budgetVersion: number;
      uncertain: boolean;
    };

/**
 * What needs a human: tasks blocked too long, sessions with no observed change for too long,
 * pending approvals, and budgets at their warning fraction or exhausted.
 */
export function attentionRoutes(
  app: FastifyInstance,
  thresholds: { blockedMs: number; stuckMs: number },
): void {
  app.get("/v1/attention", () => {
    const { readModel: rm } = app.mimir;
    const now = app.mimir.now();
    const items: AttentionEntry[] = [];
    for (const a of rm.approvals.values()) {
      if (a.status !== "pending") continue;
      items.push({
        kind: "approval_pending",
        approvalId: a.id,
        action: a.action,
        taskId: a.taskId,
        missionId: a.missionId,
        since: a.createdAt,
      });
    }
    for (const t of rm.tasks.values()) {
      const item = blockedTooLong(t, now, thresholds.blockedMs);
      if (item?.kind === "blocked_too_long") {
        items.push({ ...item, reason: t.blockedReason ?? null });
      }
    }
    for (const s of rm.sessions.values()) {
      if (!STUCK_STATES.has(s.state)) continue;
      const item = stuckDetector(s.updatedAt, now, thresholds.stuckMs);
      if (item?.kind === "stuck") {
        items.push({
          kind: "stuck",
          sessionId: s.id,
          taskId: s.taskId,
          since: item.since,
          ageMs: item.ageMs,
          thresholdMs: item.thresholdMs,
        });
      }
    }
    const usage = [...rm.usageSamples.values()];
    const attribution = {
      agents: [...rm.agents.values()].map((a) => ({ id: a.id, crewId: a.crewId })),
      crews: [...rm.crews.values()],
    };
    for (const b of rm.budgets.values()) {
      // A finished mission's budget cannot be raised (409) and gates no more work.
      const mission = b.missionId === null ? undefined : rm.missions.get(b.missionId);
      if (mission && MISSION_TERMINAL_STATUSES.has(mission.status)) continue;
      const r = budgetGuard.evaluate(toBudgetPolicy(b), usage, attribution);
      if (!r.warn && !r.exhausted) continue;
      items.push({
        kind: r.exhausted ? "budget_exceeded" : "budget_warning",
        budgetId: b.id,
        scope: r.scope,
        missionId: b.missionId,
        crewId: b.crewId,
        spentTokens: r.spentTokens,
        spentCost: r.spentCost,
        limitTokens: b.limitTokens,
        limitCost: b.limitCost,
        budgetVersion: b.version,
        uncertain: r.uncertain,
      });
    }
    return { items };
  });
}
