import { z } from "zod";

/**
 * Artifact kinds Mimir records (`artifact.recorded.kind`). `screenshot` may carry a `.desktop` or
 * `.mobile` suffix. `pr.created` is Mimir's record of `gh pr create` output (remote projects only).
 * `report` is a Markdown document (`*.md`) and `file` is any other file collected from
 * `<worktree>/.mimir/artifacts/` in the verifying step.
 */
export const ARTIFACT_KINDS = [
  "brokkr.verification-report",
  "test.output",
  "changed-files",
  "diff",
  "review",
  "screenshot",
  "local_delivery",
  "pr.created",
  "report",
  "file",
] as const;
export type BaseArtifactKind = (typeof ARTIFACT_KINDS)[number];

const KIND_PATTERN = new RegExp(
  `^(?:${ARTIFACT_KINDS.map((k) => k.replace(/[.]/g, "\\.")).join("|")}|screenshot\\.(?:desktop|mobile))$`,
);

export const ArtifactKindSchema = z.string().regex(KIND_PATTERN, "unknown artifact kind");
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/**
 * `Content-Type` served by `GET /v1/artifacts/:id/content` for a kind. A collected `file` or
 * `review` is served as JSON when its file `name` ends in `.json` (e.g. `sources.json`).
 */
export function artifactContentType(kind: string, name?: string): string {
  if ((kind === "file" || kind === "review") && name?.endsWith(".json")) return "application/json";
  if (kind === "screenshot" || kind.startsWith("screenshot.")) return "image/png";
  switch (kind) {
    case "brokkr.verification-report":
    case "changed-files":
    case "local_delivery":
      return "application/json";
    case "diff":
      return "text/x-diff; charset=utf-8";
    case "review":
    case "report":
      return "text/markdown; charset=utf-8";
    case "test.output":
    case "pr.created":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
