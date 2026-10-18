import { MISSION_TERMINAL_STATUSES, validateDag } from "@mimir/core";
import {
  CancelMissionRequestSchema,
  CreateMissionRequestSchema,
  ListMissionsQuerySchema,
  MimirError,
  MissionIdParamsSchema,
  StartMissionRequestSchema,
  newId,
  type BudgetInput,
  type BudgetPolicy,
  type CreateMissionResponse,
  type GetMissionResponse,
  type ListMissionsResponse,
  type Mission,
  type Task,
  type TaskInput,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../context.js";
import { emit } from "../emit.js";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { memberOf } from "../orchestrator/commands.js";
import { argvFor } from "../templates.js";
import { accepted, byCreated } from "./common.js";

export const DEFAULT_WARN_AT_FRACTION = 0.8;

/**
 * Review I4: a hard budget refuses dispatch on unknown usage by default (core `onUnknown: block`).
 * When the runtime reports no usage at all, every session is `unavailable`, so such a budget
 * would block after the first session. Require the operator to choose explicitly.
 */
export function checkBudgetInput(input: BudgetInput, runtimeReportsUsage: boolean): void {
  const limited = input.limitTokens !== undefined || input.limitCost !== undefined;
  if (!limited || runtimeReportsUsage) return;
  if ((input.enforce ?? "hard") === "hard" && input.onUnknown === undefined) {
    throw new MimirError(
      "validation_failed",
      "the runtime reports no usage: a hard budget needs an explicit onUnknown (allow or block)",
      {
        reason: "budget_on_unknown_required",
        issues: [{ path: ["budget", "onUnknown"], message: "required", code: "custom" }],
      },
    );
  }
}

/** A persisted budget from a request's budget input. */
export function budgetFrom(
  input: BudgetInput,
  scope: { missionId: string; crewId: string | null },
  at: string,
): BudgetPolicy {
  return {
    id: newId("bgt"),
    missionId: scope.missionId as BudgetPolicy["missionId"],
    crewId: scope.crewId as BudgetPolicy["crewId"],
    limitTokens: input.limitTokens ?? null,
    limitCost: input.limitCost ?? null,
    warnAtFraction: input.warnAtFraction ?? DEFAULT_WARN_AT_FRACTION,
    ...(input.enforce !== undefined ? { enforce: input.enforce } : {}),
    ...(input.onUnknown !== undefined ? { onUnknown: input.onUnknown } : {}),
    createdAt: at,
    updatedAt: at,
    version: 0,
  };
}

const invalid = (reason: string, message: string, details: Record<string, unknown> = {}) =>
  new MimirError("validation_failed", message, { reason, ...details });

/**
 * Validates new tasks for `missionId` against the tasks it already has (unique ids, dependencies
 * inside the mission, crews of the mission, acyclic) and appends one `task.created` per input.
 * The caller wraps this in a store transaction.
 */
export function createTasks(
  ctx: ServerContext,
  missionId: string,
  inputs: readonly TaskInput[],
  at: Date,
): string[] {
  const rm = ctx.readModel;
  const existing = [...rm.tasks.values()].filter((t) => t.missionId === missionId);
  const ids = inputs.map((t) => t.id ?? newId("tsk"));
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id) || rm.tasks.has(id)) {
      throw new MimirError("conflict", `task ${id} already exists`, { taskId: id });
    }
    seen.add(id);
  }
  const inMission = new Set<string>([...existing.map((t) => t.id), ...ids]);
  inputs.forEach((t, i) => {
    for (const dep of t.dependsOn ?? []) {
      if (!inMission.has(dep)) {
        throw invalid("unknown_dependency", `dependency ${dep} is not a task of this mission`, {
          index: i,
          dependsOn: dep,
        });
      }
    }
    if (t.crewId !== undefined) {
      const crew = rm.crews.get(t.crewId);
      if (crew?.missionId !== missionId) {
        throw invalid("unknown_crew", `crew ${t.crewId} is not a crew of this mission`, {
          index: i,
          crewId: t.crewId,
        });
      }
      // Review C1: on an agent-kind crew argv goes to the agent CLI as flags. Only the server's
      // own template is accepted; anything else could switch off the agent's safeguards.
      const member = t.argv !== undefined ? memberOf(rm, t.crewId) : undefined;
      if (t.argv !== undefined && member !== undefined && member.agentKind !== "shell") {
        const template = argvFor(member.agentKind, member.role, t.brief);
        if (JSON.stringify(template) !== JSON.stringify(t.argv)) {
          throw invalid(
            "argv_not_allowed",
            `explicit argv is not allowed for a ${member.agentKind} crew (only its template)`,
            { index: i, agentKind: member.agentKind },
          );
        }
      }
    }
  });
  const deps = [
    ...[...rm.taskDependencies.values()].filter((d) => inMission.has(d.taskId)),
    ...inputs.flatMap((t, i) =>
      (t.dependsOn ?? []).map((dependsOnId) => ({ taskId: ids[i] as Task["id"], dependsOnId })),
    ),
  ];
  validateDag(
    [...inMission].map((id) => ({ id: id as Task["id"] })),
    deps,
  );
  inputs.forEach((t, i) => {
    const taskId = ids[i] as string;
    emit(ctx.store, at, {
      type: "task.created",
      streamId: `task:${taskId}`,
      taskId,
      missionId,
      ...(t.crewId !== undefined ? { crewId: t.crewId } : {}),
      payload: {
        missionId: missionId as Task["missionId"],
        crewId: t.crewId ?? null,
        title: t.title,
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
        acceptance: (t.acceptanceCriteria ?? []).join("\n"),
        dependsOn: t.dependsOn ?? [],
        brief: t.brief,
        ...(t.argv !== undefined ? { argv: t.argv } : {}),
        ...(t.verification !== undefined ? { verification: t.verification } : {}),
        ...(t.timeoutMs !== undefined ? { timeoutMs: t.timeoutMs } : {}),
      },
    });
  });
  return ids;
}

export function missionOr404(ctx: ServerContext, id: string): Mission {
  const m = ctx.readModel.missions.get(id);
  if (!m) throw new MimirError("not_found", `mission ${id} not found`, { missionId: id });
  return m;
}

function checkVersion(mission: Mission, expected: number | undefined): void {
  if (expected !== undefined && expected !== mission.version) {
    throw new MimirError("conflict", "mission version changed", {
      expectedVersion: expected,
      version: mission.version,
    });
  }
}

export function missionRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const rm = ctx.readModel;

  app.get("/v1/missions", (request): ListMissionsResponse => {
    const q = parseWith(ListMissionsQuerySchema, request.query);
    const missions = [...rm.missions.values()]
      .filter((m) => q.projectId === undefined || m.projectId === q.projectId)
      .filter((m) => q.status === undefined || m.status === q.status)
      .sort(byCreated);
    return { missions };
  });

  app.get("/v1/missions/:id", (request): GetMissionResponse => {
    const { id } = parseWith(MissionIdParamsSchema, request.params);
    const mission = missionOr404(ctx, id);
    return {
      mission,
      crews: [...rm.crews.values()].filter((c) => c.missionId === id).sort(byCreated),
      tasks: [...rm.tasks.values()].filter((t) => t.missionId === id).sort(byCreated),
    };
  });

  app.post(
    "/v1/missions",
    idempotent(ctx, "mission.create", (request) => {
      const body = parseWith(CreateMissionRequestSchema, request.body);
      if (!rm.projects.has(body.projectId)) {
        throw invalid("unknown_project", `project ${body.projectId} not found`, {
          projectId: body.projectId,
        });
      }
      if (body.budget) checkBudgetInput(body.budget, ctx.runtimeReportsUsage);
      const at = ctx.now();
      const missionId = newId("msn");
      const taskIds = ctx.store.withTransaction(() => {
        emit(ctx.store, at, {
          type: "mission.created",
          streamId: `mission:${missionId}`,
          missionId,
          payload: {
            projectId: body.projectId,
            objective: body.objective,
            ...(body.budget
              ? {
                  budget: budgetFrom(body.budget, { missionId, crewId: null }, at.toISOString()),
                }
              : {}),
          },
        });
        return createTasks(ctx, missionId, body.tasks ?? [], at);
      });
      const response: CreateMissionResponse = {
        mission: missionOr404(ctx, missionId),
        ...(body.tasks !== undefined
          ? { tasks: taskIds.map((id) => rm.tasks.get(id) as Task) }
          : {}),
      };
      return { status: 201, body: response, target: missionId };
    }),
  );

  const transition = (
    action: "start" | "pause" | "resume" | "cancel",
    run: (id: string, body: { reason?: string | undefined }) => Promise<Mission>,
  ) =>
    app.post(
      `/v1/missions/:id/${action}`,
      idempotent(ctx, `mission.${action}`, async (request, command) => {
        const { id } = parseWith(MissionIdParamsSchema, request.params);
        const body =
          action === "cancel"
            ? parseWith(CancelMissionRequestSchema, request.body ?? {})
            : parseWith(StartMissionRequestSchema, request.body ?? {});
        const mission = missionOr404(ctx, id);
        checkVersion(mission, body.expectedVersion);
        if (MISSION_TERMINAL_STATUSES.has(mission.status) && action !== "cancel") {
          throw new MimirError("invalid_transition", `mission is ${mission.status}`, {
            missionId: id,
            status: mission.status,
          });
        }
        const reason = "reason" in body ? (body.reason as string | undefined) : undefined;
        const next = await run(id, reason !== undefined ? { reason } : {});
        return { status: 202, body: accepted(command, { mission: next }), target: id };
      }),
    );

  const orch = () => ctx.orchestrator;
  transition("start", (id) => orch().startMission(id));
  transition("pause", (id) => orch().pauseMission(id));
  transition("resume", (id) => orch().resumeMission(id));
  transition("cancel", (id, body) => orch().cancelMission(id, body.reason));
}
