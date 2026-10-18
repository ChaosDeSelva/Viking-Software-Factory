import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, ArtifactKindSchema, artifactContentType } from "./artifacts.js";

describe("artifact kinds", () => {
  it("are the agreed list", () => {
    expect(ARTIFACT_KINDS).toEqual([
      "brokkr.verification-report",
      "test.output",
      "changed-files",
      "diff",
      "review",
      "screenshot",
      "local_delivery",
      "pr.created",
      "file",
    ]);
  });

  it.each([...ARTIFACT_KINDS, "screenshot.desktop", "screenshot.mobile"])("accepts %s", (k) => {
    expect(ArtifactKindSchema.safeParse(k).success).toBe(true);
  });

  it.each(["git.diff", "screenshot.tablet", "diff.desktop", "", "Diff"])("rejects %s", (k) => {
    expect(ArtifactKindSchema.safeParse(k).success).toBe(false);
  });

  it.each([
    ["brokkr.verification-report", "application/json"],
    ["changed-files", "application/json"],
    ["local_delivery", "application/json"],
    ["diff", "text/x-diff; charset=utf-8"],
    ["test.output", "text/plain; charset=utf-8"],
    ["review", "text/markdown; charset=utf-8"],
    ["screenshot.mobile", "image/png"],
    ["pr.created", "text/plain; charset=utf-8"],
    ["file", "application/octet-stream"],
    ["something-else", "application/octet-stream"],
  ])("content type of %s is %s", (kind, type) => {
    expect(artifactContentType(kind)).toBe(type);
  });
});
