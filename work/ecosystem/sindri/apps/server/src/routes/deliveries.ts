import { KnowledgeUpdater } from "@sindri/delivery";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import type { DeliveryService } from "../delivery-service.js";
import { DISPLAY_SANITIZED, forDisplay } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import { asMimirUnavailable, type ExecutionHub } from "../execution-hub.js";
import type { Factory } from "../factory.js";
import { executionsByProject, projectOfExecution } from "../queries.js";
import { reworkRequestText } from "../rework.js";
import type { Services } from "../services.js";
import { DELIVERED_STATUSES, FINAL_STATUSES } from "../statuses.js";

/** What Mimir's `local_delivery` artifact holds. */
const LocalDelivery = z.object({
  baseSha: z.string(),
  resultCommit: z.string(),
  patch: z.string(),
  repoPath: z.string(),
  apply: z.string(),
  undo: z.string(),
  /** A rework only: the change since the delivery it revises, for a checkout that has that. */
  followUp: z.object({ baseSha: z.string(), patch: z.string() }).optional(),
  /** A rework only: why `patch` is the follow-up and not the whole change. */
  followUpOnly: z.string().optional(),
});

/** Runs a call that talks to Mimir, so an unreachable Mimir is 503 `mimir_unavailable`, not 500. */
async function withMimir<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw asMimirUnavailable(err);
  }
}

const ProjectQuery = z.object({ projectId: z.string().min(1) });
const Rework = z.strictObject({ feedback: z.string().trim().min(1).max(20_000) });

/** Every task `id` depends on, directly or through other tasks. */
function transitiveDeps(
  tasks: readonly { id: string; dependsOn: string[] }[],
  id: string,
): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const walk = (taskId: string) => {
    for (const dep of byId.get(taskId)?.dependsOn ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return [...seen];
}

/** Reviews inbox, deliveries (report, PR text, trace) and PR requests. */
export function deliveryRoutes(
  app: FastifyInstance,
  s: Services,
  hub: ExecutionHub,
  delivery: DeliveryService,
  approvals: ApprovalAuthority,
  f: Factory,
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
  /** Deliveries (execution ids) with a rework request being drafted right now, in this process. */
  const draftingRework = new Set<string>();

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
      // An escalation can only be answered while its run is open; a finished run keeps the
      // record on its tasks but has nothing left to decide.
      for (const t of FINAL_STATUSES.has(e.status) ? [] : hub.reader.tasks(e.id))
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
    const report = await withMimir(() => delivery.report(req.params.id));
    return {
      deliveryService: delivery.kind,
      report,
      prDescription: delivery.renderPrDescription(report),
    };
  });

  app.get<{ Params: { id: string } }>("/v1/deliveries/:id/trace", async (req) => {
    requireDelivered(req.params.id);
    return { trace: await withMimir(() => delivery.trace(req.params.id)) };
  });

  // The response sanitizer strips markup and cuts strings at 64 KB, which would leave a patch
  // that does not apply. This route opts out of it and sanitizes every field but the patches.
  app.get<{ Params: { id: string } }>(
    "/v1/deliveries/:id/local",
    { config: { [DISPLAY_SANITIZED]: true } },
    async (req) => {
      const execution = requireDelivered(req.params.id);
      const { facade } = await hub.connection();
      const content = await withMimir(async () => {
        const events = await facade.replayEnvelopes(execution.mimirMissionId);
        const artifact = events
          .filter(
            (e) =>
              e.type === "artifact.recorded" &&
              e.source === "mimir.server" &&
              (e.payload as { kind?: string }).kind === "local_delivery",
          )
          .at(-1);
        if (!artifact) return null;
        return facade.artifactContent((artifact.payload as { artifactId: string }).artifactId);
      });
      if (content === null) return { result: null };
      let parsed: z.infer<typeof LocalDelivery>;
      try {
        parsed = LocalDelivery.parse(JSON.parse(content));
      } catch {
        // Not something the caller sent: the artifact Mimir stored is not a local delivery.
        throw new ApiError(
          502,
          "mimir_error",
          "Mimir returned a local delivery result Sindri cannot read (not JSON, or fields are missing)",
        );
      }
      // Patches are served byte for byte; everything around them is sanitized.
      const { patch, followUp, ...rest } = parsed;
      return {
        result: {
          ...forDisplay(rest),
          patch,
          ...(followUp
            ? { followUp: { baseSha: forDisplay(followUp.baseSha), patch: followUp.patch } }
            : {}),
        },
      };
    },
  );

  /**
   * Request changes to a delivered execution: drafts a spec from the reviewer's feedback and ties
   * it to the delivery's verified results, so it is planned against, and run on top of, the
   * delivered code. The spec then goes through the usual questions, approvals, plan and run.
   */
  app.post<{ Params: { id: string } }>("/v1/deliveries/:id/rework", async (req, reply) => {
    const body = parseBody(Rework, req.body);
    const execution = requireDelivered(req.params.id);
    const plan = f.planner.get(execution.planId);
    const original = plan ? s.specs.get(plan.specId) : undefined;
    const projectId = projectOfExecution(s.db, execution.id) ?? original?.projectId;
    if (!plan || !original || !projectId || !s.knowledge.projects.get(projectId))
      throw notFound("delivery");

    // Drafting takes minutes and the check below only sees stored reworks, so a request that
    // arrives meanwhile is refused here. Nothing awaits between this check and taking the guard.
    if (draftingRework.has(execution.id))
      throw new ApiError(
        409,
        "invalid_state",
        "a change request for this delivery is already being drafted; wait for it to finish",
      );
    draftingRework.add(execution.id);
    try {
      // One open rework per delivery: a second request while the first spec is still a draft or
      // in review would produce two competing specs for the same change.
      for (const earlier of s.rework.forExecution(execution.id)) {
        const versions = s.specs.listLineage(earlier.specLineageId);
        const latest = versions.at(-1);
        if (latest && !versions.some((v) => v.status === "approved"))
          throw new ApiError(
            409,
            "invalid_state",
            `a rework of this delivery is already open as specification ${latest.id} (${latest.status}); revise or approve it instead of requesting another`,
            { reworkId: earlier.id, specId: latest.id, specLineageId: earlier.specLineageId },
          );
      }

      const { facade } = await hub.connection();
      const results = new Map(
        (await withMimir(() => facade.taskResultCommits(execution.mimirMissionId))).map((r) => [
          r.taskId,
          r.resultCommit,
        ]),
      );
      // The delivered change is the frontier of verified results: every task that has a result
      // commit and no dependant with one. A skipped task (no result) must not hide the completed
      // work beneath it, and with nothing skipped this is simply the plan's leaves.
      const mimirTask = new Map(
        hub.reader.tasks(execution.id).map((t) => [t.planTaskId, t.mimirTaskId]),
      );
      const resultOf = (planTaskId: string) => results.get(mimirTask.get(planTaskId) ?? "");
      const superseded = new Set(
        plan.tasks.filter((t) => resultOf(t.id)).flatMap((t) => transitiveDeps(plan.tasks, t.id)),
      );
      const baseCommits = [
        ...new Set(
          plan.tasks
            .filter((t) => !superseded.has(t.id))
            .map((t) => resultOf(t.id))
            .filter((c): c is string => typeof c === "string"),
        ),
      ];
      if (baseCommits.length === 0)
        throw new ApiError(
          409,
          "invalid_state",
          "this delivery has no verified result commit to build a rework on",
        );

      const report = await delivery.report(execution.id).catch(() => null);
      // No intakeId: the feedback, not the original ticket, is the source of this spec, so the
      // drafter records it as its own request instead of re-specifying the delivered ticket.
      const out = await s.director().draftSpec({
        projectId,
        request: reworkRequestText({
          originalTitle: original.title,
          feedback: body.feedback,
          baseCommits,
          changedFiles: report?.changedFiles.map((c) => c.path) ?? [],
        }),
        workspaceCommit: baseCommits[0]!,
        workspaceAlsoStartsFrom: baseCommits.slice(1),
      });
      // The spec is already stored. Without its rework row it is an ordinary spec, and a plan for
      // it would start from the default branch instead of the delivered change.
      let rework;
      try {
        rework = s.rework.create({
          projectId,
          sourceExecutionId: execution.id,
          specLineageId: out.spec.lineageId,
          baseCommits,
          feedback: body.feedback,
        });
      } catch (err) {
        req.log.error(
          { executionId: execution.id, specId: out.spec.id, err },
          "rework spec drafted but its link to the delivery could not be saved",
        );
        throw new ApiError(
          500,
          "internal",
          `the rework was drafted as specification ${out.spec.id}, but its link to this delivery could not be saved. Do not approve that specification: it would be planned from the default branch, not from the delivered change. Request the rework again.`,
          { specId: out.spec.id, specLineageId: out.spec.lineageId },
        );
      }
      req.log.info({ executionId: execution.id, reworkId: rework.id }, "rework requested");
      return reply.code(201).send({ rework, spec: out.spec, meta: out.meta });
    } finally {
      draftingRework.delete(execution.id);
    }
  });

  /** Reworks requested on a delivery, with the spec each one produced. */
  app.get<{ Params: { id: string } }>("/v1/deliveries/:id/reworks", (req) => {
    const execution = hub.reader.get(req.params.id);
    if (!execution) throw notFound("delivery");
    return {
      reworks: s.rework.forExecution(execution.id).map((r) => ({
        ...r,
        specs: s.specs
          .listLineage(r.specLineageId)
          .map((sp) => ({ id: sp.id, version: sp.version, status: sp.status, title: sp.title })),
      })),
    };
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
    return { pr: await withMimir(() => delivery.requestPr(execution.id)) };
  });

  /** Re-run the quality assessment (reviews, gates, report) of a verified execution. */
  app.post<{ Params: { id: string } }>("/v1/executions/:id/assess", async (req) => {
    requireDelivered(req.params.id);
    await withMimir(() => delivery.assess(req.params.id));
    hub.emit({ type: "quality_assessed", executionId: req.params.id });
    return { gates: delivery.gateResults(req.params.id) };
  });

  const updater = async (executionId: string) => {
    requireDelivered(executionId);
    const report = await withMimir(() => delivery.report(executionId));
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
