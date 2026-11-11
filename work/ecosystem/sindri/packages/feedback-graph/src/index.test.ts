import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@sindri/feedback-graph", () => {
  it("exports its package name and public API", () => {
    expect(api.PACKAGE_NAME).toBe("@sindri/feedback-graph");
    for (const name of [
      "FeedbackGraphClient",
      "createFeedbackGraphService",
      "normalizeLesson",
      "normalizeLessons",
    ] as const)
      expect(typeof api[name]).toBe("function");
  });
});
