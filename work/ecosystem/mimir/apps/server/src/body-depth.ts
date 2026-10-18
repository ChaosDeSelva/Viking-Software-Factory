import { MAX_JSON_DEPTH, jsonDepth } from "@mimir/core";
import { MimirError } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";

/**
 * Deepest JSON nesting accepted in a request body. The command ledger stores `{params, body}`
 * and core bounds that at `MAX_JSON_DEPTH`, so the body itself gets one level less.
 */
export const MAX_BODY_DEPTH = MAX_JSON_DEPTH - 1;

/**
 * Rejects request bodies nested deeper than `MAX_BODY_DEPTH` with 422 before any handler runs
 * (core enforces the same bound again at `CommandLedger.begin` and `EventStore.append`).
 */
export function registerBodyDepthGuard(app: FastifyInstance, maxDepth = MAX_BODY_DEPTH): void {
  app.addHook("preValidation", async (request) => {
    const body = request.body;
    if (body === null || typeof body !== "object") return;
    if (jsonDepth(body, maxDepth) > maxDepth) {
      throw new MimirError("validation_failed", "request body is nested too deeply", {
        maxDepth,
      });
    }
  });
}
