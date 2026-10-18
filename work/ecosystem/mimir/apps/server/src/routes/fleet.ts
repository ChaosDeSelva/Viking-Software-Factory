import type { FastifyInstance } from "fastify";
import { MimirError } from "@mimir/protocol";
import { z } from "zod";
import { FleetRuntime } from "../fleet-runtime/adapter.js";
import { parseWith } from "../errors.js";
import { idempotent } from "../idempotency.js";
export function fleetRoutes(app: FastifyInstance) {
  const fleet = () => {
    if (!(app.mimir.runtime instanceof FleetRuntime))
      throw new MimirError("capability_unavailable", "Fleet runtime is not configured");
    return app.mimir.runtime;
  };
  app.get("/v1/fleet", async () => ({ workers: await fleet().inventory() }));
  app.post(
    "/v1/fleet/:id/drain",
    idempotent(app.mimir, "fleet.drain", async (request) => {
      const { id } = parseWith(z.object({ id: z.string() }), request.params);
      const { draining } = parseWith(z.object({ draining: z.boolean() }).strict(), request.body);
      await fleet().setDraining(id, draining);
      return { status: 200, body: { workerId: id, draining }, target: id };
    }),
  );
}
