import { ProviderError } from "@sindri/director";
import { ConnectorError } from "@sindri/intake";
import { SindriError } from "@sindri/knowledge";
import { SpecStateError, SpecValidationError } from "@sindri/specs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiError, toApiError } from "./errors.js";

const map = (e: unknown) => {
  const a = toApiError(e);
  return [a.status, a.code, a.message];
};

describe("toApiError maps typed errors by code, never by message text", () => {
  it("maps SindriError codes", () => {
    expect(map(new SindriError("not_found", "unknown project p"))).toEqual([
      404,
      "not_found",
      "unknown project p",
    ]);
    expect(map(new SindriError("validation_failed", "bad"))).toEqual([
      422,
      "validation_failed",
      "bad",
    ]);
    expect(map(new SindriError("invalid_state", "nope"))).toEqual([409, "invalid_state", "nope"]);
    expect(map(new SindriError("no_connector", "none"))).toEqual([422, "no_connector", "none"]);
    expect(map(new SpecStateError("unknown specification s", "not_found"))[0]).toBe(404);
    expect(map(new SpecValidationError("x"))[0]).toBe(422);
  });

  it("maps provider and connector failures to 503", () => {
    expect(map(new ProviderError("provider_unavailable", "no key"))[0]).toBe(503);
    expect(map(new ProviderError("invalid_output", "bad")).slice(0, 2)).toEqual([
      503,
      "provider_error",
    ]);
    expect(map(new ConnectorError("Jira request failed: HTTP 500", 500)).slice(0, 2)).toEqual([
      503,
      "connector_failed",
    ]);
  });

  it("maps Zod and Fastify client errors to 422", () => {
    const zerr = z.object({ a: z.string() }).safeParse({}).error;
    expect(map(zerr)[0]).toBe(422);
    const fst = Object.assign(new Error("Body is not valid JSON"), {
      statusCode: 400,
      code: "FST_ERR_CTP_INVALID_JSON_BODY",
    });
    expect(map(fst).slice(0, 2)).toEqual([422, "invalid_json"]);
    expect(map(new ApiError(403, "origin_forbidden", "x"))[0]).toBe(403);
  });

  it("turns anything else into a 500 without echoing its message", () => {
    for (const e of [
      new Error("UNIQUE constraint failed: already exists, must be unique"),
      new Error("unknown project p (plain Error)"),
      new TypeError("cannot read properties of undefined"),
      Object.assign(new Error("not ours"), { statusCode: 400 }),
      "a string",
    ])
      expect(map(e)).toEqual([500, "internal", "internal error"]);
  });
});
