import type { SnapshotResponse } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";

export function snapshotRoutes(app: FastifyInstance): void {
  app.get("/v1/snapshot", (): SnapshotResponse => app.mimir.readModel.snapshot());
}
