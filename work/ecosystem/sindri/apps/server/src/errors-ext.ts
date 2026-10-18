import {
  KnowledgeUpdateError,
  DeliveryError,
  GateError,
  ReviewPolicyError,
  TraceError,
} from "@sindri/delivery";
import { HarnessServiceError } from "@sindri/harnesses";
import { isMimirError, MimirClientError } from "@sindri/mimir-client";
import { PlanStateError, PlanValidationError } from "@sindri/planner";
import { ApiError } from "./errors.js";

/**
 * Typed mapping for the planner, harness and Mimir errors used by the plan, harness and
 * execution routes. By class and code only; null for anything else.
 */
export function domainApiError(err: unknown): ApiError | null {
  if (err instanceof PlanValidationError)
    return new ApiError(422, "validation_failed", "plan validation failed", err.issues);
  if (err instanceof PlanStateError) return new ApiError(409, "invalid_state", err.message);
  if (err instanceof HarnessServiceError) {
    switch (err.code) {
      case "not_wired":
        return new ApiError(
          503,
          "brokkr_unavailable",
          "Brokkr is enabled but its SDK is not wired into Sindri yet",
        );
      case "not_found":
        return new ApiError(404, "not_found", "harness not found");
      default:
        return new ApiError(422, "validation_failed", `harness selection failed (${err.code})`);
    }
  }
  if (err instanceof KnowledgeUpdateError)
    return new ApiError(
      err.code.startsWith("unknown_") ? 404 : 409,
      err.code.startsWith("unknown_") ? "not_found" : "invalid_state",
      err.message,
    );
  if (err instanceof DeliveryError) {
    if (err.code.startsWith("unknown_")) return new ApiError(404, "not_found", err.message);
    return new ApiError(409, "invalid_state", err.message);
  }
  if (err instanceof TraceError) return new ApiError(404, "not_found", "trace not available");
  if (err instanceof ReviewPolicyError || err instanceof GateError)
    return new ApiError(409, "invalid_state", err.message);
  if (err instanceof MimirClientError) {
    switch (err.code) {
      case "not_connected":
        return new ApiError(503, "mimir_unavailable", "Mimir is not configured");
      case "not_supported":
        return new ApiError(
          503,
          "delivery_unavailable",
          `Mimir does not support this yet: ${err.message}`,
        );
      case "invalid_plan":
      case "submission_mismatch":
        return new ApiError(409, "invalid_state", `Mimir submission refused (${err.code})`);
      default:
        return new ApiError(500, "internal", "internal error");
    }
  }
  if (isMimirError(err)) {
    if (err.code === "unauthorized")
      return new ApiError(503, "mimir_unavailable", "Mimir rejected Sindri's token");
    if (err.code === "invalid_transition" || err.code === "conflict")
      return new ApiError(409, "invalid_state", `Mimir refused the request (${err.code})`);
    if (err.code === "not_found") return new ApiError(404, "not_found", "Mimir entity not found");
    return new ApiError(503, "mimir_error", `Mimir request failed (${err.code})`);
  }
  return null;
}
