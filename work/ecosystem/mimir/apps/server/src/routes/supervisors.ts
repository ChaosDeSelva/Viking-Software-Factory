import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MimirError } from "@mimir/protocol";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { SupervisorStore } from "../supervision/store.js";
import { SupervisorPolicySchema } from "../supervision/policy.js";
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Control = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observe"), sessionId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("input"),
      sessionId: z.string().min(1),
      text: z.string().min(1).max(16000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stop"),
      sessionId: z.string().min(1),
      mode: z.enum(["soft", "force"]),
    })
    .strict(),
]);
export function supervisorRoutes(app: FastifyInstance, store: SupervisorStore) {
  app.get("/v1/supervisors", async () => ({ supervisors: store.list() }));
  app.get("/v1/supervisors/:id", async (request) => {
    const { id } = parseWith(z.object({ id: Id }), request.params);
    const supervisor = store.get(id);
    if (!supervisor) throw new MimirError("not_found", "Supervisor not found");
    return {
      supervisor,
      policy: store.policy(id),
      messages: store.messages(id),
      observations: store.observations(id),
    };
  });
  app.post(
    "/v1/supervisors/:id/policy",
    idempotent(app.mimir, "supervisor.policy", async (request) => {
      const { id } = parseWith(z.object({ id: Id }), request.params);
      const policy = parseWith(SupervisorPolicySchema, request.body);
      if (!app.mimir.readModel.missions.has(policy.missionId))
        throw new MimirError("not_found", "Mission not found");
      return { status: 200, body: store.configure(id, policy), target: id };
    }),
  );
  app.post(
    "/v1/supervisors",
    idempotent(app.mimir, "supervisor.register", async (request) => {
      const body = parseWith(
        z.object({ id: Id, parent: Id.nullable().default(null) }).strict(),
        request.body,
      );
      return { status: 201, body: store.register(body.id, body.parent), target: body.id };
    }),
  );
  app.post(
    "/v1/supervisors/:id/state",
    idempotent(app.mimir, "supervisor.state", async (request) => {
      const { id } = parseWith(z.object({ id: Id }), request.params);
      const body = parseWith(
        z
          .object({
            state: z.enum(["ready", "held", "waiting_external", "blocked"]),
            reason: z.string().max(8192).nullable(),
          })
          .strict(),
        request.body,
      );
      store.setState(id, body.state, body.reason);
      return { status: 200, body: store.get(id), target: id };
    }),
  );
  app.post(
    "/v1/supervisors/:id/messages",
    idempotent(app.mimir, "supervisor.message", async (request) => {
      const { id } = parseWith(z.object({ id: Id }), request.params);
      const body = parseWith(
        z.object({ id: z.string().min(1).max(128), control: Control }).strict(),
        request.body,
      );
      if (!app.mimir.readModel.sessions.has(body.control.sessionId))
        throw new MimirError("not_found", "Session not found");
      return {
        status: 202,
        body: store.enqueue(body.id, id, body.control.kind, body.control),
        target: id,
      };
    }),
  );
  app.post(
    "/v1/supervisors/:id/authorize",
    idempotent(app.mimir, "supervisor.authorize", async (request) => {
      const { id } = parseWith(z.object({ id: Id }), request.params);
      const body = parseWith(
        z
          .object({
            messageId: z.string().min(1),
            approved: z.boolean(),
            reason: z.string().min(1).max(8192),
          })
          .strict(),
        request.body,
      );
      store.authorize(id, body.messageId, body.approved, body.reason);
      return { status: 200, body: { authorized: body.approved }, target: id };
    }),
  );
  app.post(
    "/v1/supervisors/:id/resolve",
    idempotent(app.mimir, "supervisor.resolve", async (request) => {
      const { id } = parseWith(z.object({ id: Id }), request.params);
      const body = parseWith(
        z
          .object({
            messageId: z.string(),
            outcome: z.enum(["done", "failed"]),
            reason: z.string().min(1).max(8192),
          })
          .strict(),
        request.body,
      );
      store.resolve(id, body.messageId, body.outcome, body.reason);
      return { status: 200, body: { resolved: true }, target: id };
    }),
  );
}
