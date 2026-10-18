import {
  ApprovalDecisionRequestSchema,
  ApprovalIdParamsSchema,
  ListApprovalsQuerySchema,
  MimirError,
  type ListApprovalsResponse,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { accepted, byCreated } from "./common.js";

export function approvalRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;
  const rm = ctx.readModel;

  app.get("/v1/approvals", (request): ListApprovalsResponse => {
    const q = parseWith(ListApprovalsQuerySchema, request.query);
    return {
      approvals: [...rm.approvals.values()]
        .filter((a) => q.status === undefined || a.status === q.status)
        .filter((a) => q.missionId === undefined || a.missionId === q.missionId)
        .sort(byCreated),
    };
  });

  app.post(
    "/v1/approvals/:id/decision",
    idempotent(ctx, "approval.decide", async (request, command) => {
      const { id } = parseWith(ApprovalIdParamsSchema, request.params);
      const body = parseWith(ApprovalDecisionRequestSchema, request.body);
      if (!rm.approvals.has(id)) {
        throw new MimirError("not_found", `approval ${id} not found`, { approvalId: id });
      }
      const approval = await ctx.orchestrator.decide(id, body.decision, body.reason);
      return { status: 202, body: accepted(command, { approval }), target: id };
    }),
  );
}
