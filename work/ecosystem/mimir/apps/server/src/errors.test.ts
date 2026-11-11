import { MimirError } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { toMimirError } from "./errors.js";

const clientError = (statusCode: number, message = "fastify says no") =>
  Object.assign(new Error(message), { statusCode });

describe("toMimirError", () => {
  it("keeps a MimirError as is", () => {
    const err = new MimirError("conflict", "c");
    expect(toMimirError(err)).toBe(err);
  });

  it("maps Fastify 404 and 401 client errors to not_found and unauthorized", () => {
    expect(toMimirError(clientError(404)).toBody()).toEqual({
      error: { code: "not_found", message: "not found" },
    });
    expect(toMimirError(clientError(401)).code).toBe("unauthorized");
  });

  it("maps other 4xx client errors to validation_failed with the status", () => {
    expect(toMimirError(clientError(413, "body too large")).toBody()).toEqual({
      error: { code: "validation_failed", message: "body too large", details: { status: 413 } },
    });
    // A non-Error object carrying a status has no message to pass on.
    expect(toMimirError({ statusCode: 415 }).toBody()).toEqual({
      error: { code: "validation_failed", message: "invalid request", details: { status: 415 } },
    });
  });

  it("maps 5xx, null and plain values to an opaque internal error", () => {
    for (const err of [clientError(503, "upstream secret"), null, "boom", 42]) {
      expect(toMimirError(err).toBody()).toEqual({
        error: { code: "internal", message: "internal error" },
      });
    }
  });
});
