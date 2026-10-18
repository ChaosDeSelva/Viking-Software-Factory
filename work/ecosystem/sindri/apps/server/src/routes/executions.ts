import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { forDisplay } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { asMimirUnavailable, type ExecutionHub } from "../execution-hub.js";
import type { ApprovalAuthority } from "../approval.js";
import type { DeliveryService } from "../delivery-service.js";
import type { Factory } from "../factory.js";
import { eventSeq, eventsAfter, executionsByProject, projectOfExecution } from "../queries.js";
import type { Services } from "../services.js";
import { FINAL_STATUSES } from "../statuses.js";

const Create = z.strictObject({ planId: z.string().min(1).max(200) });
const Decide = z.strictObject({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().min(1).max(2000).optional(),
});
const Resolve = z.strictObject({
  decision: z.enum(["retry", "skip", "replan", "abort"]),
  reason: z.string().trim().min(1).max(2000),
});

type IdParams = { Params: { id: string } };

const HEARTBEAT_MS = 15_000;

export function executionRoutes(
  app: FastifyInstance,
  s: Services,
  f: Factory,
  hub: ExecutionHub,
  delivery: DeliveryService,
  approvals: ApprovalAuthority,
) {
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => {
    for (const r of streams) r.end();
    streams.clear();
    await hub.close();
  });

  const requireExecution = (id: string) => {
    const execution = hub.reader.get(id);
    if (!execution) throw notFound("execution");
    return execution;
  };

  const view = (id: string) => {
    const execution = requireExecution(id);
    const plan = f.planner.get(execution.planId);
    const base = hub.mimirBaseUrl();
    return {
      execution: { ...execution, projectId: projectOfExecution(s.db, id) },
      tasks: hub.reader.tasks(id),
      approvals: hub.reader.approvals(id),
      artifacts: hub.reader.artifacts(id),
      plan: plan
        ? {
            id: plan.id,
            version: plan.version,
            specId: plan.specId,
            tasks: plan.tasks.map((t) => ({
              id: t.id,
              objective: t.objective,
              role: t.role,
              dependsOn: t.dependsOn,
              harnessId: t.harnessId,
              harnessVersion: t.harnessVersion,
            })),
          }
        : null,
      links: {
        mission: base ? `${base}/missions/${execution.mimirMissionId}` : null,
        agents: hub.reader
          .tasks(id)
          .filter((t) => t.sessionId)
          .map((t) => ({
            planTaskId: t.planTaskId,
            sessionId: t.sessionId as string,
            url: base ? `${base}/agents/${encodeURIComponent(t.sessionId as string)}` : null,
          })),
      },
      gates: delivery.gateResults(id).map((g) => ({
        planTaskId: g.planTaskId,
        passed: g.passed,
        engineering: g.engineering,
        failures: g.failures,
        evaluatedAt: g.evaluatedAt,
      })),
      running: hub.isRunning(id),
    };
  };

  app.post("/v1/executions", async (req, reply) => {
    const body = parseBody(Create, req.body);
    const plan = f.planner.get(body.planId);
    if (!plan) throw notFound("plan");
    if (plan.status !== "approved")
      throw new ApiError(409, "invalid_state", `plan is ${plan.status}; only approved plans run`);
    const project = s.knowledge.projects.get(plan.projectId);
    if (!project) throw notFound("project");
    const conn = await hub.connection();
    try {
      const mimirProject = await conn.facade.ensureProject(project.repoPath);
      const execution = await conn.loop.createExecution(plan, { projectId: mimirProject.id });
      await hub.ensureRunning(execution.id);
      return reply.code(201).send(view(execution.id));
    } catch (err) {
      throw asMimirUnavailable(err);
    }
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/executions", (req) => {
    const q = parseBody(z.object({ projectId: z.string().min(1) }), req.query);
    if (!s.knowledge.projects.get(q.projectId)) throw notFound("project");
    return { executions: executionsByProject(s.db, q.projectId) };
  });

  app.get<IdParams>("/v1/executions/:id", (req) => view(req.params.id));

  /**
   * SSE relay of Sindri's execution records: one `execution.snapshot`, then every stored
   * `execution.event` (id = Sindri event id, resumable with Last-Event-ID), then live events
   * and `execution.notice`s (status changes, approvals awaiting a human, escalations).
   * `?follow=0` replays and closes. Ordering is per execution only. An unknown Last-Event-ID
   * replays from the start. Opening a stream has no side effects.
   */
  app.get<IdParams & { Querystring: { follow?: string; after?: string } }>(
    "/v1/executions/:id/events",
    async (req, reply) => {
      const id = req.params.id;
      const execution = requireExecution(id);
      const follow = req.query.follow !== "0" && req.query.follow !== "false";
      const headerId = req.headers["last-event-id"];
      const lastId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? req.query.after;
      let seq = lastId ? eventSeq(s.db, id, lastId) : 0;

      reply.hijack();
      const raw = reply.raw;
      const cors = Object.fromEntries(
        Object.entries(reply.getHeaders()).filter(
          ([k]) => k.startsWith("access-control-") || k === "vary",
        ),
      );
      raw.writeHead(200, {
        ...cors,
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const write = (event: string, data: unknown, eventId?: string) =>
        raw.write(
          `${eventId ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(forDisplay(data))}\n\n`,
        );
      const flush = () => {
        for (;;) {
          const rows = eventsAfter(s.db, id, seq);
          for (const { seq: n, ...row } of rows) {
            write("execution.event", row, row.id);
            seq = n;
          }
          if (rows.length < 500) break;
        }
      };

      write("execution.snapshot", {
        execution: hub.reader.get(id) ?? execution,
        tasks: hub.reader.tasks(id),
      });
      flush();
      if (!follow) {
        raw.end();
        return;
      }
      streams.add(raw);
      const unsubscribe = hub.subscribe((n) => {
        if (n.executionId !== id) return;
        if (n.type === "event") flush();
        else write("execution.notice", n);
      });
      const ping = setInterval(() => raw.write(": ping\n\n"), HEARTBEAT_MS);
      req.raw.on("close", () => {
        clearInterval(ping);
        unsubscribe();
        streams.delete(raw);
      });
      // Read-only: the stream never starts runs or assessments (startup resume does).
    },
  );

  app.post<{ Params: { id: string; approvalId: string } }>(
    "/v1/executions/:id/approvals/:approvalId",
    async (req) => {
      // Deciding an agent's gated action is a human approval (review I1).
      const decidedBy = approvals.require(req);
      const { id, approvalId } = req.params;
      requireExecution(id);
      const body = parseBody(Decide, req.body);
      req.log.info({ executionId: id, approvalId, decidedBy }, "approval decided");
      const find = () =>
        hub.reader
          .approvals(id)
          .find((a) => a.id === approvalId || a.mimirApprovalId === approvalId);
      const approval = find();
      if (!approval) {
        // PR approvals arrive after execution streaming has settled. Read them through the
        // SDK, bind them to this mission, and retain the same human approval requirement.
        const execution = hub.reader.get(id)!;
        const conn = await hub.connection();
        const remote = await conn.facade.approvalForMission(execution.mimirMissionId, approvalId);
        if (!remote || remote.action !== "pr.create") throw notFound("approval");
        if (remote.status !== "pending")
          throw new ApiError(409, "invalid_state", `approval is already ${remote.status}`);
        await conn.facade.decideApproval(remote.id, body.decision, body.reason);
        return { approval: { ...remote, status: body.decision }, execution };
      }
      if (approval.status !== "pending")
        throw new ApiError(409, "invalid_state", `approval is already ${approval.status}`);
      const conn = await hub.connection();
      try {
        await conn.loop.decideApproval(id, approval.mimirApprovalId, body.decision, body.reason);
        await hub.ensureRunning(id);
      } catch (err) {
        throw asMimirUnavailable(err);
      }
      return { approval: find(), execution: hub.reader.get(id) };
    },
  );

  app.post<{ Params: { id: string; planTaskId: string } }>(
    "/v1/executions/:id/escalations/:planTaskId",
    async (req) => {
      const { id, planTaskId } = req.params;
      requireExecution(id);
      const body = parseBody(Resolve, req.body);
      const task = hub.reader.tasks(id).find((t) => t.planTaskId === planTaskId);
      if (!task) throw notFound("execution task");
      if (!task.escalation)
        throw new ApiError(409, "invalid_state", "this task has no open escalation");
      if (FINAL_STATUSES.has(hub.reader.get(id)?.status ?? ""))
        throw new ApiError(409, "invalid_state", "the execution has finished");
      try {
        // resolveEscalation resumes the loop itself, so it runs as the execution's consumer.
        await hub.takeover(id, ({ loop }, signal) =>
          loop.resolveEscalation(id, planTaskId, {
            decision: body.decision,
            actor: "user",
            reason: body.reason,
            signal,
          }),
        );
      } catch (err) {
        throw asMimirUnavailable(err);
      }
      return view(id);
    },
  );
}
