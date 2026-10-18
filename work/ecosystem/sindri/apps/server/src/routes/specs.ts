import { SpecBodySchema, type Specification } from "@sindri/specs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

const Draft = z.strictObject({
  projectId: z.string().min(1),
  intakeId: z.string().min(1).optional(),
  request: z.string().trim().min(1).max(50_000),
});
const Answer = z.strictObject({
  questionId: z.string().min(1).max(200),
  answer: z.string().trim().min(1).max(20_000),
  author: z.string().trim().min(1).max(200).optional(),
});
/** The approver is the authenticated approval principal; there is no free-text approver. */
const Approve = z.strictObject({ acknowledgeUntrusted: z.boolean().optional() });
const Revise = z.strictObject({
  title: z.string().trim().min(1).max(500).optional(),
  body: SpecBodySchema.partial().strict().optional(),
});

type IdParams = { Params: { id: string } };

export function specRoutes(app: FastifyInstance, s: Services, approvals: ApprovalAuthority) {
  const requireSpec = (id: string): Specification => {
    const spec = s.specs.get(id);
    if (!spec) throw notFound("specification");
    return spec;
  };
  const meta = (id: string) => s.director().provenance(id);

  // ---------------------------------------------------------------- director
  app.post("/v1/director/draft", async (req, reply) => {
    const body = parseBody(Draft, req.body);
    if (!s.knowledge.projects.get(body.projectId)) throw notFound("project");
    if (body.intakeId) {
      const rec = s.intake().get(body.intakeId);
      if (!rec || rec.projectId !== body.projectId) throw notFound("intake");
    }
    const out = await s.director().draftSpec({
      projectId: body.projectId,
      request: body.request,
      ...(body.intakeId ? { intakeId: body.intakeId } : {}),
    });
    return reply.code(201).send({
      spec: out.spec,
      meta: out.meta,
      context: out.context.items.map((i) => ({
        id: i.id,
        kind: i.kind,
        title: i.title,
        ref: i.ref,
        excerpt: i.text.slice(0, 400),
      })),
      analysis: out.analysis,
    });
  });

  app.get<IdParams>("/v1/specs/:id/questions", (req) => {
    requireSpec(req.params.id);
    return { questions: s.director().questions(req.params.id) };
  });

  app.post<IdParams>("/v1/specs/:id/answer", (req, reply) => {
    requireSpec(req.params.id);
    const body = parseBody(Answer, req.body);
    const spec = s.director().answer(req.params.id, body.questionId, body.answer, {
      author: body.author ?? "user",
    });
    return reply.code(201).send({ spec, meta: meta(spec.id) });
  });

  // ---------------------------------------------------------------- specs
  app.get<{ Querystring: { projectId?: string } }>("/v1/specs", (req) => {
    const q = parseBody(z.object({ projectId: z.string().min(1) }), req.query);
    if (!s.knowledge.projects.get(q.projectId)) throw notFound("project");
    return { specs: s.specs.listByProject(q.projectId) };
  });

  app.get<{ Querystring: { from?: string; to?: string } }>("/v1/specs/diff", (req) => {
    const q = parseBody(z.object({ from: z.string().min(1), to: z.string().min(1) }), req.query);
    requireSpec(q.from);
    requireSpec(q.to);
    return { diff: s.specs.diff(q.from, q.to) };
  });

  app.get<IdParams>("/v1/specs/:id", (req) => {
    const spec = requireSpec(req.params.id);
    return {
      spec,
      meta: meta(spec.id),
      lineage: s.specs.listLineage(spec.lineageId).map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        title: v.title,
        createdAt: v.createdAt,
      })),
    };
  });

  app.get<IdParams>("/v1/specs/:id/render", (req) => {
    requireSpec(req.params.id);
    return { markdown: s.specs.render(req.params.id) };
  });

  app.post<IdParams>("/v1/specs/:id/submit", (req) => {
    requireSpec(req.params.id);
    return { spec: s.specs.submitForReview(req.params.id) };
  });

  app.post<IdParams>("/v1/specs/:id/approve", (req) => {
    const approver = approvals.require(req);
    requireSpec(req.params.id);
    const body = parseBody(Approve, req.body);
    // Sticky across the lineage (review C1): any flagged version needs the acknowledgement.
    if (meta(req.params.id).untrustedInstructionDetected && body.acknowledgeUntrusted !== true)
      throw new ApiError(
        409,
        "untrusted_unacknowledged",
        "this spec was drafted from text with flagged instructions; review them and send acknowledgeUntrusted: true",
      );
    return { spec: s.specs.approve(req.params.id, { approver }) };
  });

  app.post<IdParams>("/v1/specs/:id/revise", (req, reply) => {
    requireSpec(req.params.id);
    const body = parseBody(Revise, req.body);
    const spec = s.specs.revise(req.params.id, {
      ...(body.title ? { title: body.title } : {}),
      ...(body.body
        ? { body: Object.fromEntries(Object.entries(body.body).filter(([, v]) => v !== undefined)) }
        : {}),
    });
    // The revised text is untrusted too; the flag carries over (review C1).
    const revisedMeta = s
      .director()
      .recordRevision(
        req.params.id,
        spec.id,
        JSON.stringify({ title: body.title, body: body.body }),
      );
    return reply.code(201).send({ spec, meta: revisedMeta });
  });
}
