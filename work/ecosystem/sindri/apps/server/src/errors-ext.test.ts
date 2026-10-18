import { MimirClientError } from "@sindri/mimir-client";
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
