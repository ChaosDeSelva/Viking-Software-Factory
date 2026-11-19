import {
  decideProjectDecision,
  DesignProposalSchema,
  projectDecisionLog,
  proposeProjectDecision,
} from "@sindri/knowledge";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApprovalAuthority } from "../approval.js";
import { DISPLAY_SANITIZED, forDisplay } from "../display.js";
import { parseBody } from "../errors.js";
import type { Services } from "../services.js";

type Project = { Params: { id: string } };
export function decisionLogRoutes(app: FastifyInstance, s: Services, approvals: ApprovalAuthority) {
  const root = "/v1/projects/:id/decision-log";
  app.get<Project>(root, { config: { [DISPLAY_SANITIZED]: true } }, (req) => {
    const { entries, markdown } = projectDecisionLog(s.db, req.params.id);
    return { entries: forDisplay(entries), markdown };
  });
  app.get<Project>(root + ".md", (req, reply) =>
    reply
      .type("text/markdown; charset=utf-8")
      .header("content-disposition", 'attachment; filename="decision-log.md"')
      .send(projectDecisionLog(s.db, req.params.id).markdown),
  );
  app.post<Project>(root, (req, reply) => {
    const proposal = parseBody(DesignProposalSchema, req.body);
    const projectId = req.params.id;
    const id = proposeProjectDecision(s.db, projectId, proposal, "API");
    return reply.code(201).send({ id, projectId });
  });
  app.post<{ Params: { id: string; entryId: string } }>(root + "/:entryId/decision", (req) => {
    const actor = approvals.require(req);
    const { decision } = parseBody(
      z.strictObject({ decision: z.enum(["accepted", "rejected"]) }),
      req.body,
    );
    decideProjectDecision(s.db, req.params.id, req.params.entryId, decision, actor);
    return { id: req.params.entryId, projectId: req.params.id, status: decision };
  });
}
