import { ProviderError } from "@sindri/director";
import { ConnectorError } from "@sindri/intake";
import { isSindriError } from "@sindri/knowledge";
import { ZodError, type ZodType } from "zod";
import { domainApiError } from "./errors-ext.js";

export type ErrorCode =
  | "unauthorized"
  | "origin_forbidden"
  | "host_forbidden"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "idempotency_mismatch"
  | "idempotency_in_progress"
  | "idempotency_key_required"
  | "validation_failed"
  | "invalid_json"
  | "confirmation_required"
  | "no_connector"
  | "local_only"
  | "provider_unavailable"
  | "provider_error"
  | "connector_failed"
  | "brokkr_unavailable"
  | "mimir_unavailable"
  | "mimir_error"
  | "delivery_unavailable"
  | "not_supported"
  | "not_exportable"
  | "already_imported"
  | "approval_required"
  | "approval_pairing_failed"
  | "approval_locked"
  | "untrusted_unacknowledged"
  | "project_required"
  | "mirror_failed"
  | "github_error"
  | "already_posted"
  | "post_in_progress"
  | "post_blocked"
  | "pr_head_moved"
  | "pr_changed_since_plan"
  | "already_decided"
  | "gates_not_passed"
  | "internal";

/** An error with a stable code and HTTP status, rendered as `{ error: { code, message, details? } }`. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);

export function parseBody<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success)
    throw new ApiError(422, "validation_failed", "request validation failed", r.error.issues);
  return r.data;
}

const PROVIDER_HINTS: Partial<Record<ProviderError["code"], string>> = {
  auth: "the provider is not signed in or its credentials expired; sign in and retry",
  rate_limited: "the provider's rate or usage limit was reached; retry later",
  timeout: "the provider did not answer within its time limit; retry, or narrow the request",
};

/**
 * Map errors to API errors by type and stable code only. Package errors are `SindriError`s
 * (`not_found` / `validation_failed` / `invalid_state` / `no_connector`); provider and
 * connector failures have their own classes. Anything else is an internal error: 500 with a
 * generic message, so internal details (SQL, paths, stack text) are never echoed.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError)
    return new ApiError(422, "validation_failed", "validation failed", err.issues);
  if (isSindriError(err)) return new ApiError(err.status, err.code, err.message);
  if (err instanceof ProviderError) {
    // The code says why; `detail` is what the provider itself reported (bounded and
    // secret-redacted where it is made), so an operator can tell a login from a limit.
    const hint = PROVIDER_HINTS[err.code];
    const suffix = `(${err.code})${hint ? `: ${hint}` : ""}`;
    const details = err.detail ? { reason: err.detail } : undefined;
    if (err.code === "provider_unavailable" || err.code === "auth" || err.code === "rate_limited")
      return new ApiError(
        503,
        "provider_unavailable",
        `LLM provider unavailable ${suffix}`,
        details,
      );
    return new ApiError(503, "provider_error", `LLM provider error ${suffix}`, details);
  }
  if (err instanceof ConnectorError)
    return new ApiError(503, "connector_failed", "the ticket system request failed");
  const domain = domainApiError(err);
  if (domain) return domain;
  // Fastify's own request errors (body parsing, media type, payload size).
  const e = err as { statusCode?: unknown; code?: unknown };
  if (
    err instanceof Error &&
    typeof e.code === "string" &&
    e.code.startsWith("FST_") &&
    typeof e.statusCode === "number" &&
    e.statusCode >= 400 &&
    e.statusCode < 500
  ) {
    if (e.statusCode === 415)
      return new ApiError(422, "validation_failed", "unsupported content type");
    if (e.statusCode === 413) return new ApiError(422, "validation_failed", "payload too large");
    return new ApiError(422, "invalid_json", "request body is not valid JSON");
  }
  return new ApiError(500, "internal", "internal error");
}

export const envelope = (e: ApiError) => ({
  error: {
    code: e.code,
    message: e.message,
    ...(e.details === undefined ? {} : { details: e.details }),
  },
});
