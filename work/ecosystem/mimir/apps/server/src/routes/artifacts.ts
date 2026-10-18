import { createReadStream } from "node:fs";
import {
  ArtifactIdParamsSchema,
  artifactContentType,
  MimirError,
  type Artifact,
  type GetArtifactResponse,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { parseWith } from "../errors.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export function artifactRoutes(app: FastifyInstance, maxBytes = DEFAULT_MAX_ARTIFACT_BYTES): void {
  const ctx = app.mimir;

  const artifactOr404 = (id: string): Artifact => {
    const a = ctx.readModel.artifacts.get(id);
    if (!a) throw new MimirError("not_found", `artifact ${id} not found`, { artifactId: id });
    return a;
  };

  app.get("/v1/artifacts/:id", (request): GetArtifactResponse & { bytes: number | null } => {
    const { id } = parseWith(ArtifactIdParamsSchema, request.params);
    return { artifact: artifactOr404(id), bytes: ctx.readModel.artifactBytes.get(id) ?? null };
  });

  /**
   * Raw content streamed from MIMIR_DATA_DIR/artifacts (never another path), so consumers never
   * read Mimir's filesystem. Content-Type follows the artifact kind; larger than the cap → 409;
   * pruned or unsafe → 404.
   */
  app.get("/v1/artifacts/:id/content", async (request, reply) => {
    const { id } = parseWith(ArtifactIdParamsSchema, request.params);
    const artifact = artifactOr404(id);
    const file = ctx.artifacts.locate(id);
    if (file === null) {
      throw new MimirError("not_found", `artifact ${id} content is not available`, {
        artifactId: id,
      });
    }
    if (file.bytes > maxBytes) {
      throw new MimirError("conflict", `artifact ${id} is larger than the served maximum`, {
        artifactId: id,
        reason: "too_large",
        bytes: file.bytes,
        maxBytes,
      });
    }
    return reply
      .header("content-type", artifactContentType(artifact.kind))
      .header("content-length", String(file.bytes))
      .header("x-artifact-hash", artifact.hash)
      .header("x-content-type-options", "nosniff")
      .send(createReadStream(file.path));
  });
}
