import { MISSION_TERMINAL_STATUSES } from "@mimir/core";
import {
  CreateTaskRequestSchema,
  ListTasksQuerySchema,
  MimirError,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  TaskIdParamsSchema,
  type CreateTaskResponse,
  type GetTaskResponse,
  type ListTasksResponse,
  type Task,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { accepted, byCreated } from "./common.js";
import { createTasks } from "./missions.js";

export function taskRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const rm = ctx.readModel;

  const taskOr404 = (id: string): Task => {
    const t = rm.tasks.get(id);
    if (!t) throw new MimirError("not_found", `task ${id} not found`, { taskId: id });
    return t;
  };

  app.get("/v1/tasks", (request): ListTasksResponse => {
    const q = parseWith(ListTasksQuerySchema, request.query);
    return {
      tasks: [...rm.tasks.values()]
        .filter((t) => q.missionId === undefined || t.missionId === q.missionId)
        .filter((t) => q.crewId === undefined || t.crewId === q.crewId)
        .filter((t) => q.status === undefined || t.status === q.status)
        .sort(byCreated),
    };
  });

  app.get("/v1/tasks/:id", (request): GetTaskResponse => {
    const { id } = parseWith(TaskIdParamsSchema, request.params);
    const task = taskOr404(id);
    return {
      task,
      spec: rm.taskSpec(id),
      mission: rm.missions.get(task.missionId) ?? null,
      dependencies: [...rm.taskDependencies.values()].filter(
        (dependency) => dependency.taskId === id,
      ),
      sessions: [...rm.sessions.values()].filter((session) => session.taskId === id),
      worktrees: [...rm.worktrees.values()].filter((worktree) => worktree.taskId === id),
      artifacts: [...rm.artifacts.values()].filter((artifact) => artifact.taskId === id),
      approvals: [...rm.approvals.values()].filter((approval) => approval.taskId === id),
    };
  });

  app.post(
    "/v1/tasks",
    idempotent(ctx, "task.create", (request) => {
      const { missionId, ...input } = parseWith(CreateTaskRequestSchema, request.body);
      const mission = rm.missions.get(missionId);
      if (!mission) {
        throw new MimirError("validation_failed", `mission ${missionId} not found`, {
          reason: "unknown_mission",
          missionId,
        });
      }
      if (MISSION_TERMINAL_STATUSES.has(mission.status)) {
        throw new MimirError("invalid_transition", `mission is ${mission.status}`, {
          missionId,
          status: mission.status,
        });
      }
      const [id] = ctx.store.withTransaction(() => createTasks(ctx, missionId, [input], ctx.now()));
      const response: CreateTaskResponse = { task: taskOr404(id as string) };
      return { status: 201, body: response, target: id as string };
    }),
  );

  app.post(
    "/v1/tasks/:id/retry",
    idempotent(ctx, "task.retry", async (request, command) => {
      const { id } = parseWith(TaskIdParamsSchema, request.params);
      const body = parseWith(RetryTaskRequestSchema, request.body ?? {});
      const task = taskOr404(id);
      if (body.expectedVersion !== undefined && body.expectedVersion !== task.version) {
        throw new MimirError("conflict", "task version changed", {
          expectedVersion: body.expectedVersion,
          version: task.version,
        });
      }
      const next = await ctx.orchestrator.retryTask(id);
      return { status: 202, body: accepted(command, { task: next }), target: id };
    }),
  );

  app.post(
    "/v1/tasks/:id/verify",
    idempotent(ctx, "task.verify", async (request) => {
      const { id } = parseWith(TaskIdParamsSchema, request.params);
      const body = parseWith(RetryTaskRequestSchema, request.body ?? {});
      const task = taskOr404(id);
      if (body.expectedVersion !== undefined && body.expectedVersion !== task.version)
        throw new MimirError("conflict", "task version changed");
      return { status: 200, body: await ctx.orchestrator.recheckVerification(id), target: id };
    }),
  );

  app.post(
    "/v1/tasks/:id/pr",
    idempotent(ctx, "task.pr", async (request, command) => {
      const { id } = parseWith(TaskIdParamsSchema, request.params);
      parseWith(RequestPrRequestSchema, request.body ?? {});
      taskOr404(id);
      const outcome = await ctx.orchestrator.requestPr(id);
      if (outcome.kind === "denied") {
        throw new MimirError("policy_denied", outcome.reason, { action: "pr.create" });
      }
      const extra =
        outcome.kind === "approval_required"
          ? { status: "approval_required" as const, approvalId: outcome.approval.id }
          : { status: "delivered" as const };
      const body = RequestPrResponseSchema.parse(accepted(command, extra));
      return { status: 202, body, target: id };
    }),
  );
}
