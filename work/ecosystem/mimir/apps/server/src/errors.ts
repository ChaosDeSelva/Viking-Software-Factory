import { MimirError, isMimirError, toValidationIssues } from "@mimir/protocol";
import type { FastifyError, FastifyInstance } from "fastify";
import type { z } from "zod";

function isZodError(err: unknown): err is z.ZodError {
  return (
    err instanceof Error &&
    err.name === "ZodError" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/** Parses `value` with `schema`, throwing `MimirError('validation_failed')` with `details.issues`. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MimirError("validation_failed", "request validation failed", {
      issues: toValidationIssues(result.error),
    });
  }
  return result.data;
}

/** Normalises any thrown value to a `MimirError` that is safe to send to clients. */
export function toMimirError(err: unknown): MimirError {
  if (isMimirError(err)) return err;
  if (isZodError(err)) {
    return new MimirError("validation_failed", "request validation failed", {
      issues: toValidationIssues(err),
    });
  }
  const status = (err as Partial<FastifyError> | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    // Fastify client errors (bad JSON, unsupported media type, body too large, ...).
    if (status === 404) return new MimirError("not_found", "not found");
    if (status === 401) return new MimirError("unauthorized");
    const message = err instanceof Error ? err.message : "invalid request";
    return new MimirError("validation_failed", message, { status });
  }
  return new MimirError("internal", "internal error");
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    const mimir = toMimirError(err);
    if (mimir.code === "internal") request.log.error({ err }, "unhandled error");
    void reply.code(mimir.status).send(mimir.toBody());
  });
  app.setNotFoundHandler((request, reply) => {
    const err = new MimirError("not_found", `route ${request.method} ${request.url} not found`);
    void reply.code(err.status).send(err.toBody());
  });
}
