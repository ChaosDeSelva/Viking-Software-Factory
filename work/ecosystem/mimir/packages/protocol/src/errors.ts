import { z } from "zod";

export const ERROR_CODES = [
  "validation_failed",
  "invalid_transition",
  "policy_denied",
  "unauthorized",
  "not_found",
  "conflict",
  "idempotency_replay_mismatch",
  "runtime_unavailable",
  "capability_unavailable",
  "cursor_expired",
  "internal",
] as const;

export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const HTTP_STATUS_BY_CODE = {
  validation_failed: 422,
  invalid_transition: 409,
  policy_denied: 403,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  idempotency_replay_mismatch: 409,
  runtime_unavailable: 503,
  capability_unavailable: 501,
  cursor_expired: 410,
  internal: 500,
} as const satisfies Record<ErrorCode, number>;

export function httpStatusFor(code: ErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

export const ApiErrorBodySchema = z
  .object({
    error: z.object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: "ApiErrorBody" });
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;

export class MimirError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown, options?: ErrorOptions) {
    super(message ?? code, options);
    this.name = "MimirError";
    this.code = code;
    this.status = httpStatusFor(code);
    if (details !== undefined) this.details = details;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

/** Structural check, so it also works across duplicate copies of this package. */
export function isMimirError(value: unknown): value is MimirError {
  if (value instanceof MimirError) return true;
  if (!(value instanceof Error) || value.name !== "MimirError") return false;
  const v = value as Error & { code?: unknown; status?: unknown };
  return ErrorCodeSchema.safeParse(v.code).success && typeof v.status === "number";
}
