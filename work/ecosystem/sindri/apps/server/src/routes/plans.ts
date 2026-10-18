import { PlanTaskSchema, type Plan } from "@sindri/planner";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { Factory } from "../factory.js";
import type { Services } from "../services.js";

const Propose = z.strictObject({ specId: z.string().min(1).max(200) });
/** The approver is the authenticated approval principal (audit M9); the body is empty. */
const Approve = z.strictObject({});
const Revise = z.strictObject({ tasks: z.array(PlanTaskSchema).min(1).max(200) });
const ListQuery = z.object({
  projectId: z.string().min(1).optional(),
  specId: z.string().min(1).optional(),
});

type IdParams = { Params: { id: string } };

const versionOf = (p: Plan) => ({
  id: p.id,
  version: p.version,
  status: p.status,
  specId: p.specId,
  specVersion: p.specVersion,
  approvedBy: p.approvedBy,
  approvedAt: p.approvedAt,
  createdAt: p.createdAt,
});

export function planRoutes(
  app: FastifyInstance,
  s: Services,
  f: Factory,
  approvals: ApprovalAuthority,
) {
  const requirePlan = (id: string): Plan => {
    const plan = f.planner.get(id);
    if (!plan) throw notFound("plan");
    return plan;
  };
  const versions = (p: Plan) => f.planner.listLineage(p.lineageId).map(versionOf);
  const harnessesFor = (projectId: string) =>
    f.harnesses(s.knowledge.projects.get(projectId)?.repoPath);

  app.post("/v1/plans/propose", async (req, reply) => {
    const body = parseBody(Propose, req.body);
    const spec = s.specs.get(body.specId);
    if (!spec) throw notFound("specification");
    const { service, source } = harnessesFor(spec.projectId);
    // Preflight: the planner reports an unreachable harness service as "no resolvable harness"
    // (422); asking it for its harnesses first surfaces `not_wired` as 503 brokkr_unavailable.
    await service.listHarnesses();
    const plan = await f.planner.propose(
      { id: spec.id },
      { provider: f.provider(), harnesses: service },
    );
    return reply.code(201).send({ plan, versions: versions(plan), harnessSource: source });
  });

  app.get<{ Querystring: { projectId?: string; specId?: string } }>("/v1/plans", (req) => {
    const q = parseBody(ListQuery, req.query);
    if (q.specId) {
      if (!s.specs.get(q.specId)) throw notFound("specification");
      return { plans: f.planner.listForSpec(q.specId) };
    }
    if (q.projectId) {
      if (!s.knowledge.projects.get(q.projectId)) throw notFound("project");
      return {
        plans: s.specs.listByProject(q.projectId).flatMap((sp) => f.planner.listForSpec(sp.id)),
      };
    }
    throw new ApiError(422, "validation_failed", "projectId or specId is required");
  });

  app.get<IdParams>("/v1/plans/:id", (req) => {
    const plan = requirePlan(req.params.id);
    return { plan, versions: versions(plan) };
  });

  app.get<IdParams>("/v1/plans/:id/versions", (req) => ({
    versions: versions(requirePlan(req.params.id)),
  }));

  app.get<IdParams>("/v1/plans/:id/dry-run", (req) => {
    const plan = requirePlan(req.params.id);
    return { dryRun: f.planner.dryRun(plan) };
  });

  app.post<IdParams>("/v1/plans/:id/submit", (req) => {
    requirePlan(req.params.id);
    return { plan: f.planner.submitForReview(req.params.id) };
  });

  app.post<IdParams>("/v1/plans/:id/approve", (req) => {
    const approver = approvals.require(req);
    requirePlan(req.params.id);
    parseBody(Approve, req.body);
    return { plan: f.planner.approve(req.params.id, approver) };
  });

  app.post<IdParams>("/v1/plans/:id/revise", async (req, reply) => {
    const plan = requirePlan(req.params.id);
    const body = parseBody(Revise, req.body);
    const { service } = harnessesFor(plan.projectId);
    const revised = await f.planner.revise(plan.id, { tasks: body.tasks }, { harnesses: service });
    return reply.code(201).send({ plan: revised, versions: versions(revised) });
  });
}
