import { MAX_PROJECT_NOTES_BYTES, openGuidance, utf8Capped, type Skill } from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound, parseBody } from "../errors.js";
import type { Services } from "../services.js";

const ImportSkill = z.strictObject({ path: z.string().trim().min(1).max(4096) });

const PutGuidance = z.strictObject({
  notes: utf8Capped(MAX_PROJECT_NOTES_BYTES, "project notes"),
  defaultSkillIds: z.array(z.string().min(1).max(100)).max(50),
});

/** A skill without its content (lists); `GET /v1/skills/:id` returns the content too. */
const skillSummary = ({ content, ...rest }: Skill) => ({
  ...rest,
  bytes: Buffer.byteLength(content, "utf8"),
});

/**
 * The skills library (SKILL.md folders imported from disk) and per-project guidance: standing
 * notes and the skills every brief of the project carries. See docs/api.md, "Operator guidance".
 */
export function guidanceRoutes(app: FastifyInstance, s: Services) {
  const guidance = openGuidance(s.db);

  app.get("/v1/skills", () => ({ skills: guidance.list() }));

  app.post("/v1/skills", (req, reply) => {
    const body = parseBody(ImportSkill, req.body);
    const result = guidance.importPath(body.path);
    req.log.info(
      { imported: result.imported.length, skipped: result.skipped.length },
      "skills imported",
    );
    return reply.code(201).send({
      imported: result.imported.map(skillSummary),
      skipped: result.skipped,
    });
  });

  app.get<{ Params: { id: string } }>("/v1/skills/:id", (req) => {
    const skill = guidance.get(req.params.id);
    if (!skill) throw notFound("skill");
    const listed = guidance.listing(skill.id);
    return {
      skill: {
        ...skill,
        changedOnDisk: listed?.changedOnDisk ?? true,
        missingOnDisk: listed?.missingOnDisk ?? true,
      },
    };
  });

  app.post<{ Params: { id: string } }>("/v1/skills/:id/reimport", (req) => ({
    skill: skillSummary(guidance.reimport(req.params.id)),
  }));

  app.delete<{ Params: { id: string } }>("/v1/skills/:id", (req) => {
    guidance.delete(req.params.id);
    return { deleted: req.params.id };
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/guidance", (req) => {
    if (!s.knowledge.projects.get(req.params.id)) throw notFound("project");
    return { guidance: guidance.projectGuidance(req.params.id) };
  });

  app.put<{ Params: { id: string } }>("/v1/projects/:id/guidance", (req) => {
    if (!s.knowledge.projects.get(req.params.id)) throw notFound("project");
    const body = parseBody(PutGuidance, req.body);
    return { guidance: guidance.setProjectGuidance(req.params.id, body) };
  });
}
