import { NewEntrySchema, type KnowledgeEntry, type SourceRef } from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

const EntryBody = NewEntrySchema.extend({
  createdBy: z.string().trim().min(1).max(200).default("user"),
});
const AddBody = EntryBody.extend({ projectId: z.string().min(1) });
const Retract = z.strictObject({ reason: z.string().trim().min(1).max(2000) });

export function knowledgeRoutes(app: FastifyInstance, s: Services) {
  /** Human labels for source refs. */
  const label = (ref: SourceRef): string => {
    if ("url" in ref) return ref.url;
    if ("taskEvidenceId" in ref) return `evidence:${ref.taskEvidenceId}`;
    const path = s.knowledge.documents.get(ref.documentId)?.path ?? `document:${ref.documentId}`;
    return ref.startLine !== undefined
      ? `${path}#L${ref.startLine}-L${ref.endLine ?? ref.startLine}`
      : path;
  };
  const view = (e: KnowledgeEntry) => ({
    ...e,
    sources: e.sourceRefs.map((ref) => ({ ref, label: label(ref) })),
  });
  const requireEntry = (id: string) => {
    const e = s.knowledge.knowledge.get(id);
    if (!e) throw notFound("knowledge entry");
    return e;
  };

  app.get<{ Querystring: { projectId?: string; q?: string } }>("/v1/knowledge", (req) => {
    const q = parseBody(
      z.object({ projectId: z.string().min(1), q: z.string().max(500).optional() }),
      req.query,
    );
    if (!s.knowledge.projects.get(q.projectId)) throw notFound("project");
    const needle = q.q?.trim().toLowerCase();
    const entries = s.knowledge.knowledge
      .listValid(q.projectId)
      .filter((e) => !needle || e.claim.toLowerCase().includes(needle));
    return { entries: entries.map(view) };
  });

  app.post("/v1/knowledge", (req, reply) => {
    const body = parseBody(AddBody, req.body);
    if (!s.knowledge.projects.get(body.projectId)) throw notFound("project");
    return reply.code(201).send({ entry: view(s.knowledge.knowledge.add(body)) });
  });

  app.post<{ Params: { id: string } }>("/v1/knowledge/:id/retract", (req) => {
    const body = parseBody(Retract, req.body);
    const e = requireEntry(req.params.id);
    if (e.validity === "retracted")
      throw new ApiError(409, "invalid_state", "entry is already retracted");
    return { entry: view(s.knowledge.knowledge.retract(e.id, body.reason)) };
  });

  app.post<{ Params: { id: string } }>("/v1/knowledge/:id/supersede", (req, reply) => {
    const body = parseBody(EntryBody, req.body);
    const e = requireEntry(req.params.id);
    if (e.validity !== "valid")
      throw new ApiError(
        409,
        "invalid_state",
        `only valid entries can be superseded (entry is ${e.validity})`,
      );
    return reply.code(201).send({ entry: view(s.knowledge.knowledge.supersede(e.id, body)) });
  });

  app.get<{ Params: { id: string } }>("/v1/knowledge/:id/history", (req) => {
    requireEntry(req.params.id);
    return { history: s.knowledge.knowledge.history(req.params.id).map(view) };
  });
}
