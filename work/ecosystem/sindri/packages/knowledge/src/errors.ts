/** Stable error codes shared by the Sindri packages; servers map them to HTTP statuses. */
export type SindriErrorCode = "not_found" | "validation_failed" | "invalid_state" | "no_connector";

export const SINDRI_ERROR_STATUS: Readonly<Record<SindriErrorCode, number>> = {
  not_found: 404,
  validation_failed: 422,
  invalid_state: 409,
  no_connector: 422,
};

const BRAND = Symbol.for("sindri.error");

/** A domain error with a stable `code`. Messages are for humans and may change. */
export class SindriError extends Error {
  override name = "SindriError";
  readonly [BRAND] = true;
  constructor(
    readonly code: SindriErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
  get status(): number {
    return SINDRI_ERROR_STATUS[this.code];
  }
}

/** True for any SindriError, including one from another copy of this module. */
export function isSindriError(e: unknown): e is SindriError {
  if (e instanceof SindriError) return true;
  if (typeof e !== "object" || e === null || !(e instanceof Error)) return false;
  const r = e as Error & Record<PropertyKey, unknown>;
  return r[BRAND] === true && typeof r["code"] === "string" && r["code"] in SINDRI_ERROR_STATUS;
}
