import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client.js";
import { explainStartError } from "./workErrors.js";

describe("explainStartError", () => {
  it("explains mirror_failed and local_only, and passes other errors through", () => {
    const mirror = explainStartError(
      new ApiError(502, "mirror_failed", "x", { reason: "commit_missing" }),
    ) as Error;
    expect(mirror.message).toMatch(/review clone.*base or head commit could not be found/);
    const local = explainStartError(new ApiError(503, "local_only", "x")) as Error;
    expect(local.message).toMatch(/Local-only mode is on/);
    const other = new ApiError(409, "invalid_state", "x");
    expect(explainStartError(other)).toBe(other);
  });
});
