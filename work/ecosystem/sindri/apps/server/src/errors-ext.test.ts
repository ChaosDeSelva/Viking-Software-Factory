import {
  DeliveryError,
  GateError,
  KnowledgeUpdateError,
  ReviewPolicyError,
  TraceError,
} from "@sindri/delivery";
import { HarnessServiceError } from "@sindri/harnesses";
import { MimirClientError, MimirError } from "@sindri/mimir-client";
import { PlanStateError, PlanValidationError } from "@sindri/planner";
import { describe, expect, it } from "vitest";
import { domainApiError } from "./errors-ext.js";

describe("domainApiError: Mimir not_supported", () => {
  it("maps a Mimir that lacks a delivery route to 503 delivery_unavailable", () => {
    const e = domainApiError(new MimirClientError("not_supported", "no artifacts.content"));
    expect(e?.status).toBe(503);
    expect(e?.code).toBe("delivery_unavailable");
  });
  it("maps submission refusals to 409 and unknown codes to 500 (by code, review m3)", () => {
    expect(domainApiError(new MimirClientError("invalid_plan", "x"))?.status).toBe(409);
    expect(domainApiError(new MimirClientError("submission_mismatch", "x"))?.status).toBe(409);
    expect(domainApiError(new MimirClientError("rejected" as never, "x"))?.status).toBe(500);
  });
});

describe("domainApiError: by class and code", () => {
  const map = (err: unknown) => {
    const e = domainApiError(err);
    return e && { status: e.status, code: e.code, message: e.message, details: e.details };
  };

  it("maps planner errors, with the validation issues as details", () => {
    expect(map(new PlanValidationError(["cycle: a -> a"]))).toEqual({
      status: 422,
      code: "validation_failed",
      message: "plan validation failed",
      details: ["cycle: a -> a"],
    });
    expect(map(new PlanStateError("plan is draft"))).toMatchObject({
      status: 409,
      code: "invalid_state",
      message: "plan is draft",
    });
  });

  it("maps harness errors by code", () => {
    expect(map(new HarnessServiceError("not_wired", "x"))).toMatchObject({
      status: 503,
      code: "brokkr_unavailable",
    });
    expect(map(new HarnessServiceError("not_found", "x"))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(map(new HarnessServiceError("no_match", "x"))).toMatchObject({
      status: 422,
      code: "validation_failed",
      message: "harness selection failed (no_match)",
    });
  });

  it("maps unknown_* delivery and knowledge-update codes to 404, the rest to 409", () => {
    expect(map(new KnowledgeUpdateError("unknown_delivery", "gone"))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(map(new KnowledgeUpdateError("not_delivered", "later"))).toMatchObject({
      status: 409,
      code: "invalid_state",
      message: "later",
    });
    expect(map(new DeliveryError("unknown_execution", "gone"))).toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(map(new DeliveryError("gates_not_passed", "no"))).toMatchObject({
      status: 409,
      code: "invalid_state",
    });
  });

  it("maps trace, review policy and gate errors without echoing trace internals", () => {
    expect(map(new TraceError("row 7 missing in /data/x.db"))).toMatchObject({
      status: 404,
      message: "trace not available",
    });
    expect(map(new ReviewPolicyError("same_crew", "same crew"))).toMatchObject({
      status: 409,
      code: "invalid_state",
    });
    expect(map(new GateError("not verified"))).toMatchObject({
      status: 409,
      code: "invalid_state",
    });
  });

  it("maps a missing Mimir connection to 503 mimir_unavailable", () => {
    expect(map(new MimirClientError("not_connected", "x"))).toMatchObject({
      status: 503,
      code: "mimir_unavailable",
    });
  });

  it("maps Mimir's own errors by code, and leaves anything else to the caller", () => {
    expect(map(new MimirError("unauthorized"))).toMatchObject({
      status: 503,
      code: "mimir_unavailable",
    });
    expect(map(new MimirError("invalid_transition"))).toMatchObject({ status: 409 });
    expect(map(new MimirError("conflict"))).toMatchObject({
      status: 409,
      message: "Mimir refused the request (conflict)",
    });
    expect(map(new MimirError("not_found"))).toMatchObject({ status: 404, code: "not_found" });
    expect(map(new MimirError("runtime_unavailable"))).toMatchObject({
      status: 503,
      code: "mimir_error",
      message: "Mimir request failed (runtime_unavailable)",
    });
    expect(domainApiError(new Error("x"))).toBeNull();
    expect(domainApiError("x")).toBeNull();
  });
});
