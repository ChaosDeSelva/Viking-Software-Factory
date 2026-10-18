import type { CommandRecord } from "@mimir/core";
import { ErrorCodeSchema, IDEMPOTENCY_HEADER, MimirError } from "@mimir/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerContext } from "./context.js";
import { toMimirError } from "./errors.js";

export const IDEMPOTENCY_REPLAYED_HEADER = "idempotency-replayed";
/** Audit actor for requests authenticated with the operator bearer token. */
export const OPERATOR_ACTOR = "operator";
const MAX_KEY_LENGTH = 255;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** What a command handler returns; `target` is recorded in the audit entry. */
export interface CommandResult {
  status: number;
  body: unknown;
  target?: string;
}

/** Stored in the command ledger as the response (success) or error (failure). */
interface StoredReply {
  status: number;
  body: unknown;
}

/** Replies stored by `idempotent`, or an error record written by `CommandLedger.markInterrupted`. */
function storedReplyOf(rec: CommandRecord): StoredReply | null {
  const value = rec.status === "succeeded" ? rec.response : rec.error;
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v["status"] === "number" && "body" in v)
    return { status: v["status"], body: v["body"] };
  const code = ErrorCodeSchema.safeParse(v["code"]);
  if (!code.success) return null;
  const { message, ...rest } = v;
  const details = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "code"));
  const err = new MimirError(
    code.data,
    typeof message === "string" ? message : code.data,
    Object.keys(details).length > 0 ? details : undefined,
  );
  return { status: err.status, body: err.toBody() };
}

/**
 * Boot recovery: commands still `accepted` were cut off by a previous process. Fail them so a
 * replay of their key returns that failure instead of a permanent "in progress" 409.
 */
export function failInterruptedCommands(ctx: Pick<ServerContext, "ledger" | "audit">): number {
  const stale = ctx.ledger.listInFlight();
  for (const rec of stale) {
    ctx.ledger.markInterrupted(rec.id);
    ctx.audit.record({
      actor: "system",
      action: rec.kind,
      target: rec.id,
      decision: "failed",
      reason: "command interrupted by a server restart",
    });
  }
  return stale.length;
}

function keyOf(request: FastifyRequest): string | undefined {
  const raw = request.headers[IDEMPOTENCY_HEADER];
  const key = Array.isArray(raw) ? raw[0] : raw;
  return key === undefined || key.trim() === "" ? undefined : key.trim();
}

/**
 * Every mutating request must carry an `Idempotency-Key` header (422 otherwise). Deny by default:
 * this does not look at the raw URL (which the router decodes, audit C1), so no spelling of a
 * path can skip it.
 */
export function registerIdempotencyGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    if (!MUTATING.has(request.method)) return;
    const key = keyOf(request);
    if (key === undefined) {
      throw new MimirError("validation_failed", "Idempotency-Key header is required", {
        issues: [{ path: ["headers", IDEMPOTENCY_HEADER], message: "required", code: "required" }],
      });
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new MimirError("validation_failed", "Idempotency-Key header is too long", {
        issues: [{ path: ["headers", IDEMPOTENCY_HEADER], message: "too long", code: "too_big" }],
      });
    }
  });
}

/**
 * Wraps a mutating route handler: records the command in the ledger (`begin`), replays a stored
 * reply for a repeated key (with `Idempotency-Replayed: true`), 409s on a key reused with a
 * different request, and writes an audit entry for every executed command.
 */
export function idempotent(
  ctx: Pick<ServerContext, "ledger" | "audit">,
  action: string,
  handler: (
    request: FastifyRequest,
    command: CommandRecord,
  ) => Promise<CommandResult> | CommandResult,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const key = keyOf(request);
    if (key === undefined) throw new MimirError("validation_failed", "Idempotency-Key required");
    const begun = ctx.ledger.begin(key, action, {
      params: request.params ?? {},
      body: request.body ?? null,
    });
    if ("replay" in begun) {
      const rec = begun.replay;
      const stored =
        rec.status === "succeeded" || rec.status === "failed" ? storedReplyOf(rec) : null;
      if (stored === null) {
        throw new MimirError("conflict", "a command with this idempotency key is in progress", {
          commandId: rec.id,
        });
      }
      return reply
        .header(IDEMPOTENCY_REPLAYED_HEADER, "true")
        .code(stored.status)
        .send(stored.body);
    }
    const command = begun.fresh;
    let result: CommandResult;
    try {
      result = await handler(request, command);
    } catch (err) {
      const error = toMimirError(err);
      ctx.ledger.fail(command.id, { status: error.status, body: error.toBody() });
      ctx.audit.record({
        actor: OPERATOR_ACTOR,
        action,
        decision: "failed",
        reason: `${error.code}: ${error.message}`,
      });
      throw error;
    }
    ctx.ledger.succeed(command.id, { status: result.status, body: result.body });
    ctx.audit.record({
      actor: OPERATOR_ACTOR,
      action,
      decision: "succeeded",
      ...(result.target !== undefined ? { target: result.target } : {}),
    });
    return reply.code(result.status).send(result.body);
  };
}
