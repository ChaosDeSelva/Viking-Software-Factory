import { redact } from "@mimir/core";
import {
  MimirError,
  SendInstructionRequestSchema,
  SessionIdParamsSchema,
  StopSessionRequestSchema,
  type RuntimeAdapter,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
import { accepted } from "./common.js";

const TerminalQuerySchema = z.object({
  lines: z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(5000))
    .default(200),
});

/** Runtimes that can read a session's terminal (HerdR: `pane.read`). Not in `RuntimeAdapter`. */
type TerminalReader = RuntimeAdapter & {
  readTerminal(sessionId: string, lines?: number): Promise<string>;
};
const canReadTerminal = (r: RuntimeAdapter): r is TerminalReader =>
  typeof (r as Partial<TerminalReader>).readTerminal === "function";

export function sessionRoutes(app: FastifyInstance): void {
  const ctx = app.mimir;

  const sessionOr404 = (id: string) => {
    const s = ctx.readModel.sessions.get(id);
    if (!s) throw new MimirError("not_found", `session ${id} not found`, { sessionId: id });
    return s;
  };

  app.get("/v1/sessions/:id", async (request) => {
    const { id } = parseWith(SessionIdParamsSchema, request.params);
    const persisted = sessionOr404(id);
    const session = (await ctx.runtime?.getSession(id)) ?? null;
    return {
      session,
      persisted,
      observedAt: session ? ctx.now().toISOString() : null,
      available: session !== null,
    };
  });

  app.post(
    "/v1/sessions/:id/input",
    idempotent(ctx, "session.input", async (request, command) => {
      const { id } = parseWith(SessionIdParamsSchema, request.params);
      const body = parseWith(SendInstructionRequestSchema, request.body);
      sessionOr404(id);
      await ctx.orchestrator.sendInput(id, body.text);
      return { status: 202, body: accepted(command, { sessionId: id }), target: id };
    }),
  );

  app.post(
    "/v1/sessions/:id/stop",
    idempotent(ctx, "session.stop", async (request, command) => {
      const { id } = parseWith(SessionIdParamsSchema, request.params);
      const body = parseWith(StopSessionRequestSchema, request.body);
      sessionOr404(id);
      const outcome = await ctx.orchestrator.stopSession(id, body.mode);
      if (outcome.kind === "approval_required") {
        throw new MimirError(
          "policy_denied",
          "force stop requires an approved runtime.force_stop approval",
          { action: "runtime.force_stop", approvalId: outcome.approval.id },
        );
      }
      if (outcome.kind === "denied") {
        throw new MimirError("policy_denied", outcome.reason, { action: "runtime.force_stop" });
      }
      return {
        status: 202,
        body: accepted(command, { sessionId: id, mode: body.mode }),
        target: id,
      };
    }),
  );

  /** The session's terminal text as the runtime shows it now. Display only: never a state source. */
  app.get("/v1/sessions/:id/terminal", async (request) => {
    const { id } = parseWith(SessionIdParamsSchema, request.params);
    const { lines } = parseWith(TerminalQuerySchema, request.query);
    sessionOr404(id);
    const runtime = ctx.runtime;
    if (!runtime) throw new MimirError("runtime_unavailable", "no runtime is configured");
    if (!canReadTerminal(runtime)) {
      throw new MimirError("capability_unavailable", "this runtime cannot read terminals", {
        feature: "terminalRead",
      });
    }
    const text = redact(await runtime.readTerminal(id, lines)).text;
    return {
      sessionId: id,
      text,
      lines,
      provenance: "observed",
      capturedAt: ctx.now().toISOString(),
    };
  });
}
