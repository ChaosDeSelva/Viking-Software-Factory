import { MAX_FIELD_CHARS, type IntakeCommentRecord, type IntakeRecord } from "@sindri/intake";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DISPLAY_SANITIZED, forDisplay } from "../display.js";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

/**
 * API view of an intake: raw remote payloads stay server-side. Ticket text goes out only as the
 * display copy the intake stored when it was written (audit M5: sanitized once, never per
 * response); short metadata strings are sanitized here.
 */
export function intakeView(r: IntakeRecord) {
  return {
    ...forDisplay({
      id: r.id,
      projectId: r.projectId,
      source: r.source,
      externalId: r.externalId,
      externalUrl: r.externalUrl,
      status: r.snapshot.status ?? null,
      importedAt: r.importedAt,
      syncState: r.syncState,
      permissions: r.permissions,
      createdAt: r.createdAt,
    }),
    title: r.display.title,
    body: r.display.body,
    hasPendingSnapshot: r.pendingSnapshot !== null,
    display: r.display,
  };
}

const commentView = (c: IntakeCommentRecord) => ({
  ...forDisplay({
    id: c.id,
    intakeId: c.intakeId,
    createdAt: c.createdAt,
    externalId: c.externalId,
    origin: c.origin,
  }),
  author: c.display.author,
  body: c.display.body,
  display: c.display,
});

/** These routes return only stored display text; the global response sanitizer skips them. */
const sanitized = { config: { [DISPLAY_SANITIZED]: true } };

const ManualIntake = z.strictObject({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  // Same cap as connector imports (review m6).
  body: z.string().max(MAX_FIELD_CHARS),
});

const ImportIntake = z.strictObject({
  projectId: z.string().min(1),
  url: z.string().url().max(2048),
});

export function intakeRoutes(app: FastifyInstance, s: Services) {
  const requireProject = (id: string) => {
    if (!s.knowledge.projects.get(id)) throw notFound("project");
  };

  app.post("/v1/intakes", sanitized, (req, reply) => {
    const body = parseBody(ManualIntake, req.body);
    requireProject(body.projectId);
    const rec = s.intake().createManual(body);
    return reply.code(201).send({ intake: intakeView(rec) });
  });

  app.post("/v1/intakes/import", sanitized, async (req, reply) => {
    const body = parseBody(ImportIntake, req.body);
    if (s.settings.get().localOnly)
      throw new ApiError(503, "local_only", "local-only mode is on: ticket imports are disabled");
    requireProject(body.projectId);
    const rec = await s.intake().importFromUrl(body.url, { projectId: body.projectId });
    return reply.code(201).send({ intake: intakeView(rec) });
  });

  app.get<{ Querystring: { projectId?: string } }>("/v1/intakes", sanitized, (req) => {
    const q = parseBody(z.object({ projectId: z.string().min(1) }), req.query);
    requireProject(q.projectId);
    return { intakes: s.intake().list(q.projectId).map(intakeView) };
  });

  app.get<{ Params: { id: string } }>("/v1/intakes/:id", sanitized, (req) => {
    const intake = s.intake();
    const rec = intake.get(req.params.id);
    if (!rec) throw notFound("intake");
    return { intake: intakeView(rec), comments: intake.comments(rec.id).map(commentView) };
  });
}
