import type { HealthResponse } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";

/**
 * `status` is `degraded` when the runtime reports not ok or when the event store has refused
 * corrupt rows (`integrity.refusedRows > 0`: part of the log cannot be served).
 */
export function healthRoutes(app: FastifyInstance): void {
  app.get("/v1/health", async (): Promise<HealthResponse> => {
    const { runtime, store } = app.mimir;
    const integrity = store.integrity();
    const intact = integrity.refusedRows === 0;
    if (runtime === null) return { status: intact ? "ok" : "degraded", integrity };
    let health: { ok: boolean; detail?: string };
    try {
      health = await runtime.health();
    } catch (err) {
      health = { ok: false, detail: err instanceof Error ? err.message : "health check failed" };
    }
    return { status: health.ok && intact ? "ok" : "degraded", runtime: health, integrity };
  });
}
