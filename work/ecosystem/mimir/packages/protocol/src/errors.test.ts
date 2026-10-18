import { describe, expect, it } from "vitest";
import {
  ApiErrorBodySchema,
  ERROR_CODES,
  ErrorCodeSchema,
  MimirError,
  httpStatusFor,
  isMimirError,
} from "./errors.js";

describe("errors", () => {
  it("has exactly the specified codes and HTTP statuses", () => {
    expect(ERROR_CODES).toEqual([
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
    ]);
    expect(Object.fromEntries(ERROR_CODES.map((c) => [c, httpStatusFor(c)]))).toEqual({
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
    });
    expect(ErrorCodeSchema.safeParse("teapot").success).toBe(false);
  });

  it("MimirError carries code, status and details", () => {
    const err = new MimirError("capability_unavailable");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("capability_unavailable");
    expect(err.status).toBe(501);
    expect(err.message).toBe("capability_unavailable");
    expect(err.name).toBe("MimirError");
    expect(isMimirError(err)).toBe(true);
    expect(isMimirError(new Error("x"))).toBe(false);
    // Structural: survives duplicate package copies (no instanceof).
    const foreign = Object.assign(new Error("m"), {
      name: "MimirError",
      code: "conflict",
      status: 409,
    });
    expect(isMimirError(foreign)).toBe(true);
    expect(isMimirError({ name: "MimirError", code: "teapot", status: 418 })).toBe(false);

    const withDetails = new MimirError("not_found", "no such mission", { id: "msn_x" });
    expect(withDetails.details).toEqual({ id: "msn_x" });
    expect(withDetails.toBody()).toEqual({
      error: { code: "not_found", message: "no such mission", details: { id: "msn_x" } },
    });
    expect(ApiErrorBodySchema.parse(withDetails.toBody())).toEqual(withDetails.toBody());
  });

  it("ApiErrorBodySchema rejects malformed bodies at the right path", () => {
    const r = ApiErrorBodySchema.safeParse({ error: { code: "nope", message: "m" } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["error", "code"]);
    const ok = ApiErrorBodySchema.safeParse({ error: { code: "internal", message: "boom" } });
    expect(ok.success).toBe(true);
  });
});
