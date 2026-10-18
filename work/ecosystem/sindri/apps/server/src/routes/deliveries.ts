import { KnowledgeUpdater } from "@sindri/delivery";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import type { DeliveryService } from "../delivery-service.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { ExecutionHub } from "../execution-hub.js";
import { executionsByProject } from "../queries.js";
import type { Services } from "../services.js";
import { DELIVERED_STATUSES } from "../statuses.js";

const ProjectQuery = z.object({ projectId: z.string().min(1) });

/** Reviews inbox, deliveries (report, PR text, trace) and PR requests. */
export function deliveryRoutes(
  app: FastifyInstance,
  s: Services,
  hub: ExecutionHub,
  delivery: DeliveryService,
  approvals: ApprovalAuthority,
) {
  const projectExecutions = (projectId: string) => {
    if (!s.knowledge.projects.get(projectId)) throw notFound("project");
    return executionsByProject(s.db, projectId);
  };
  const requireDelivered = (id: string) => {
    const execution = hub.reader.get(id);
    if (!execution) throw notFound("delivery");
    if (!DELIVERED_STATUSES.has(execution.status))
      throw new ApiError(
        409,
        "invalid_state",
        `execution is ${execution.status}; a delivery exists once it is verified`,
      );
    return execution;
  };

  app.get<{ Querystring: { projectId?: string } }>("/v1/reviews", (req) => {
    const q = parseBody(ProjectQuery, req.query);
    const approvals = [];
    const escalations = [];
    const budgetAlerts = [];
    const gateFailures = [];
    const findings = [];
    for (const e of projectExecutions(q.projectId)) {
      approvals.push(
        ...hub.reader
          .approvals(e.id)
          .filter((a) => a.disposition === "inbox" && a.status === "pending"),
      );
      for (const t of hub.reader.tasks(e.id))
        if (t.escalation)
          escalations.push({
            executionId: e.id,
            planTaskId: t.planTaskId,
            escalation: t.escalation,
            reason: t.escalationReason,
            status: t.status,
            attempts: t.attempts,
          });
      budgetAlerts.push(
        ...hub.reader
          .inbox(e.id)
          .filter((i) => i.kind === "budget_exceeded" && i.status === "open"),
      );
      for (const g of delivery.gateResults(e.id))
        for (const fl of g.failures)
          gateFailures.push({
            executionId: e.id,
            planTaskId: g.planTaskId,
            evaluatedAt: g.evaluatedAt,
            ...fl,
          });
      for (const r of delivery.reviews(e.id)) {
        const base = {
          executionId: e.id,
          reviewId: r.id,
          planTaskId: r.planTaskId,
          role: r.role,
          verdict: r.verdict,
        };
        if (r.findings.length === 0 && r.verdict === "request_changes")
          findings.push({ ...base, severity: "major", message: r.reason ?? "changes requested" });
        for (const fd of r.findings) findings.push({ ...base, ...fd });
      }
    }
    return {
      deliveryService: delivery.kind,
      approvals,
      escalations,
      budgetAlerts,
      gateFailures,
      findings,
    };
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/deliveries", (req) => {
    const q = parseBody(ProjectQuery, req.query);
    return {
      deliveries: projectExecutions(q.projectId)
        .filter((e) => DELIVERED_STATUSES.has(e.status))
        .map((e) => ({ ...e, executionId: e.id })),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/deliveries/:id", async (req) => {
    requireDelivered(req.params.id);
    const report = await delivery.report(req.params.id);
    return {
      deliveryService: delivery.kind,
      report,
      prDescription: delivery.renderPrDescription(report),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/deliveries/:id/trace", async (req) => {
    requireDelivered(req.params.id);
    return { trace: await delivery.trace(req.params.id) };
  });

  app.get<{ Params: { id: string } }>("/v1/deliveries/:id/local", async (req) => {
    const execution = requireDelivered(req.params.id);
    const { facade } = await hub.connection();
    const events = await facade.replayEnvelopes(execution.mimirMissionId!);
    const artifact = events
      .filter(
        (e) =>
          e.type === "artifact.recorded" &&
          e.source === "mimir.server" &&
          (e.payload as { kind?: string }).kind === "local_delivery",
      )
      .at(-1);
    if (!artifact) return { result: null };
    const payload = artifact.payload as { artifactId: string };
    const result = z
      .object({
        baseSha: z.string(),
        resultCommit: z.string(),
        patch: z.string(),
        repoPath: z.string(),
        apply: z.string(),
        undo: z.string(),
      })
      .parse(JSON.parse(await facade.artifactContent(payload.artifactId)));
    return { result };
  });

  app.post<{ Params: { id: string } }>("/v1/executions/:id/pr", async (req) => {
    // Opening a PR is a human approval (audit M9): the approval secret, not just the token.
    const approver = approvals.require(req);
    req.log.info({ executionId: req.params.id, approver }, "PR requested");
    const execution = hub.reader.get(req.params.id);
    if (!execution) throw notFound("execution");
    if (execution.status !== "verified_pending_review")
      throw new ApiError(
        409,
        "invalid_state",
        `execution is ${execution.status}; a PR can be requested once it is verified`,
      );
    return { pr: await delivery.requestPr(execution.id) };
  });

  /** Re-run the quality assessment (reviews, gates, report) of a verified execution. */
  app.post<{ Params: { id: string } }>("/v1/executions/:id/assess", async (req) => {
    requireDelivered(req.params.id);
    await delivery.assess(req.params.id);
    hub.emit({ type: "quality_assessed", executionId: req.params.id });
    return { gates: delivery.gateResults(req.params.id) };
  });

  const updater = async (executionId: string) => {
    requireDelivered(executionId);
    const report = await delivery.report(executionId);
    return {
      report,
      service: new KnowledgeUpdater({
        db: s.db,
        knowledge: s.knowledge,
        reports: { get: (id) => (id === report.id ? report : undefined) },
      }),
    };
  };
  app.get<{ Params: { id: string } }>("/v1/deliveries/:id/proposals", async (req) => {
    const { report, service } = await updater(req.params.id);
    return { proposals: service.list(report.id) };
  });
  app.post<{ Params: { id: string } }>("/v1/deliveries/:id/proposals", async (req) => {
    approvals.require(req);
    const { report, service } = await updater(req.params.id);
    return { proposals: service.proposeEntries(report.id) };
  });
  app.post<{ Params: { id: string; proposalId: string } }>(
    "/v1/deliveries/:id/proposals/:proposalId/decision",
    async (req) => {
      const actor = approvals.require(req);
      const body = parseBody(
        z.object({
          decision: z.enum(["accepted", "rejected"]),
          reason: z.string().trim().min(1).max(2000).optional(),
        }),
        req.body,
      );
      const { report, service } = await updater(req.params.id);
      if (!service.list(report.id).some((p) => p.id === req.params.proposalId))
        throw notFound("proposal");
      return {
        proposal:
          body.decision === "accepted"
            ? service.accept(req.params.proposalId, actor)
            : service.reject(req.params.proposalId, actor, body.reason ?? "Rejected by reviewer"),
      };
    },
  );
  app.get("/v1/mimir/status", () => hub.status());
}
