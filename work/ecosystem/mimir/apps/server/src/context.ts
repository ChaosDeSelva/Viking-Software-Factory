import type { AuditLog, CommandLedger, EventStore } from "@mimir/core";
import type { RuntimeAdapter } from "@mimir/protocol";
import type { ArtifactStore } from "./orchestrator/artifacts.js";
import type { Orchestrator } from "./orchestrator/orchestrator.js";
import type { ReadModel } from "./readmodel.js";
import type { SseOptions } from "./routes/events.js";

/** Everything route handlers need; available as `app.mimir`. */
export interface ServerContext {
  store: EventStore;
  ledger: CommandLedger;
  audit: AuditLog;
  runtime: RuntimeAdapter | null;
  readModel: ReadModel;
  /** Server clock (injectable for tests). */
  now: () => Date;
  orchestrator: Orchestrator;
  /** Whether the runtime reports token/cost usage (none does yet; see checkBudgetInput). */
  runtimeReportsUsage: boolean;
  artifacts: ArtifactStore;
  allowedRoots: readonly string[];
  sse: SseOptions;
}

declare module "fastify" {
  interface FastifyInstance {
    mimir: ServerContext;
  }
}
