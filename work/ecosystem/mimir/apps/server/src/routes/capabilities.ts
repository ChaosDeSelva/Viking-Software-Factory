import { harnessInventory } from "../harnesses/doctor.js";
import { readFileSync } from "node:fs";
import { MimirError, PROTOCOL_VERSION, type CapabilitiesResponse } from "@mimir/protocol";
import type { FastifyInstance } from "fastify";

function readServerVersion(): string {
  try {
    // src/routes and dist/routes are both two levels below the package root.
    const url = new URL("../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = readServerVersion();

export function capabilitiesRoutes(app: FastifyInstance): void {
  app.get("/v1/harnesses", async () => ({ harnesses: await harnessInventory() }));
  app.get("/v1/capabilities", async (): Promise<CapabilitiesResponse> => {
    const { runtime } = app.mimir;
    let caps: CapabilitiesResponse["runtime"] = null;
    if (runtime !== null) {
      try {
        caps = await runtime.capabilities();
      } catch (err) {
        throw new MimirError("runtime_unavailable", "runtime capabilities unavailable", undefined, {
          cause: err,
        });
      }
    }
    return { serverVersion: SERVER_VERSION, protocolVersion: PROTOCOL_VERSION, runtime: caps };
  });
}
