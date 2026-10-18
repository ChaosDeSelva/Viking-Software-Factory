import { createProvider, type LlmProvider } from "@sindri/director";
import { BrokkrHarnessService, FakeHarnessService, type HarnessService } from "@sindri/harnesses";
import { ensureDeliverySchema, ensureQualitySchema, type PermissionPolicy } from "@sindri/delivery";
import { applyMigrations } from "@sindri/knowledge";
import { openPlanner, type Planner } from "@sindri/planner";
import { S6DeliveryService, type DeliveryService } from "./delivery-service.js";
import { ExecutionHub } from "./execution-hub.js";
import { executionStatuses } from "./queries.js";
import { FINAL_STATUSES } from "./statuses.js";
import type { ServiceOptions, Services } from "./services.js";
import { effectiveProvider, type Settings } from "./settings.js";

/** Options for the plan, harness, execution and delivery side of the server (S7b). */
export interface FactoryOptions {
  /** A fixed HarnessService (tests). Otherwise chosen by `settings.brokkrEnabled`. */
  harnessService?: HarnessService;
  /** What Sindri does with Mimir approval requests (default: every action to the inbox). */
  permissionPolicy?: PermissionPolicy;
  /** fetch used for Mimir requests (tests). */
  mimirFetch?: typeof globalThis.fetch;
  /** Gates, review, report, PR and trace. Default: S6 (`@sindri/delivery`). */
  deliveryService?: DeliveryService;
  /** Envelope sources trusted as delivery evidence. Default: `mimir.server`. */
  trustedSources?: readonly string[];
  /** Delivery-loop warnings. */
  onWarn?: (msg: string, fields?: Record<string, unknown>) => void;
  /** Background delivery-run failures (the server logs them). */
  onRunError?: (executionId: string, err: unknown) => void;
  /** Startup resume retries this often while a configured Mimir is unreachable. Default 5 s. */
  resumeRetryMs?: number;
}

export type HarnessSource = "fake" | "brokkr" | "custom";

export interface Factory {
  planner: Planner;
  /** The LLM provider for planning, built from settings like the Director's. */
  provider(): LlmProvider;
  /**
   * The HarnessService in effect. `brokkrEnabled: false` (default) uses the fixture-backed
   * `FakeHarnessService`; `true` uses `BrokkrHarnessService`, which rejects `not_wired`
   * until the Brokkr SDK is wired (S4b).
   */
  harnesses(repoPath?: string): { service: HarnessService; source: HarnessSource };
  /** Mimir connection, background delivery runs and the notice fan-out. */
  hub: ExecutionHub;
  delivery: DeliveryService;
  /**
   * Startup: resume every non-final execution and assess verified ones that were never
   * assessed at their current settle point. Needs a configured Mimir; never throws. While the
   * configured Mimir is unreachable it retries every `resumeRetryMs` until it answers.
   */
  resume(): Promise<void>;
  /** After a settings change: re-attach runs when the Mimir target changed (review m2). */
  settingsChanged(): Promise<void>;
  /** Stops the resume retry timer. */
  close(): void;
}

/**
 * One-time backfill (S7b parked item M-A): databases written before `quality_assessments`
 * existed have assessed executions (gate rows) without a claim, so the first resume would
 * assess them again. Claims them at their last event row. Waits until the delivery tables exist.
 */
export function backfillAssessmentClaims(db: Services["db"]): void {
  const has = (t: string) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !==
    undefined;
  if (!has("gate_evaluations") || !has("execution_events")) return;
  applyMigrations(db, "server_backfill", [
    `INSERT OR IGNORE INTO quality_assessments (execution_id, settle_seq, assessed_at)
     SELECT g.execution_id,
            COALESCE((SELECT MAX(rowid) FROM execution_events e WHERE e.execution_id = g.execution_id), 0),
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       FROM (SELECT DISTINCT execution_id FROM gate_evaluations) g
      WHERE NOT EXISTS (SELECT 1 FROM quality_assessments q WHERE q.execution_id = g.execution_id)`,
  ]);
}

/**
 * Claims the settle assessment of an execution at its current settle point (the last event row).
 * False when it was already claimed: assessment is idempotent per execution and settle point.
 */
export function claimSettleAssessment(
  db: Services["db"],
  executionId: string,
  now: () => Date,
): boolean {
  const seq =
    (
      db
        .prepare("SELECT MAX(rowid) AS seq FROM execution_events WHERE execution_id = ?")
        .get(executionId) as { seq: number | null }
    ).seq ?? 0;
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO quality_assessments (execution_id, settle_seq, assessed_at) VALUES (?, ?, ?)",
      )
      .run(executionId, seq, now().toISOString()).changes === 1
  );
}

export function createFactory(o: ServiceOptions & FactoryOptions, s: Services): Factory {
  const now = o.now ?? (() => new Date());
  const planner = openPlanner(s.db, { now });
  // Delivery tables and their purge hooks exist from startup, so a project purge reaches them
  // even before any execution runs in this process (audit M4).
  ensureDeliverySchema(s.db);
  ensureQualitySchema(s.db);
  let providerCache: { key: string; provider: LlmProvider } | undefined;
  const build = (st: Settings): LlmProvider =>
    o.providerFactory
      ? o.providerFactory(st)
      : createProvider(
          {
            director: {
              provider: effectiveProvider(st),
              model: st.model,
              ...(st.apiKeySecret ? { apiKeySecret: st.apiKeySecret } : {}),
            },
          },
          o.secrets ? { secrets: o.secrets } : {},
        );
  // The hub hands verified executions to `delivery` (declared below) for assessment.
  const hub: ExecutionHub = new ExecutionHub({
    db: s.db,
    settings: s.settings,
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.permissionPolicy ? { permissionPolicy: o.permissionPolicy } : {}),
    ...(o.mimirFetch ? { mimirFetch: o.mimirFetch } : {}),
    ...(o.onRunError ? { onRunError: o.onRunError } : {}),
    ...(o.onWarn ? { logger: { warn: o.onWarn } } : {}),
    onSettled: (executionId, status) => settleAssessment(executionId, status),
    now,
  });
  async function settleAssessment(executionId: string, status: string): Promise<void> {
    if (status !== "verified_pending_review") return;
    if (!claimSettleAssessment(s.db, executionId, now)) return;
    try {
      await delivery.assess(executionId);
      hub.emit({ type: "quality_assessed", executionId });
    } catch (err) {
      // Release the claim so the next startup (or settle) tries again.
      s.db.prepare("DELETE FROM quality_assessments WHERE execution_id = ?").run(executionId);
      o.onRunError?.(executionId, err);
      hub.emit({
        type: "quality_failed",
        executionId,
        message: err instanceof Error ? err.name : "error",
      });
    }
  }
  const provider = (): LlmProvider => {
    const st = s.settings.get();
    const key = JSON.stringify([st.provider, st.model, st.apiKeySecret, st.localOnly]);
    if (providerCache?.key !== key) providerCache = { key, provider: build(st) };
    return providerCache.provider;
  };
  const delivery: DeliveryService =
    o.deliveryService ??
    new S6DeliveryService({
      db: s.db,
      hub,
      specs: s.specs,
      intake: () => s.intake(),
      provider,
      ...(o.trustedSources ? { trustedSources: o.trustedSources } : {}),
      now,
    });
  backfillAssessmentClaims(s.db);
  const retryMs = o.resumeRetryMs ?? 5_000;
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  const scheduleRetry = () => {
    if (closed || hub.closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void resume();
    }, retryMs);
    retryTimer.unref();
  };
  async function resume(): Promise<void> {
    if (closed || hub.closed) return;
    let conn;
    try {
      conn = await hub.connection();
    } catch {
      return; // Mimir not configured (or blocked by local-only): nothing to resume.
    }
    try {
      await conn.facade.capabilities();
    } catch {
      scheduleRetry(); // Configured but unreachable: try again later.
      return;
    }
    for (const e of executionStatuses(s.db)) {
      try {
        if (!FINAL_STATUSES.has(e.status)) await hub.ensureRunning(e.id);
        else await settleAssessment(e.id, e.status);
      } catch (err) {
        o.onRunError?.(e.id, err);
      }
    }
  }
  async function settingsChanged(): Promise<void> {
    const stopped = await hub.reconfigure();
    if (stopped.length > 0) await resume();
  }
  return {
    planner,
    hub,
    delivery,
    resume,
    settingsChanged,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
    },
    provider,
    harnesses(repoPath) {
      if (o.harnessService) return { service: o.harnessService, source: "custom" };
      if (s.settings.get().brokkrEnabled)
        return {
          service: new BrokkrHarnessService({ cwd: repoPath ?? process.cwd() }),
          source: "brokkr",
        };
      // A fresh fake per request: it records every resolve call in memory.
      return { service: new FakeHarnessService(), source: "fake" };
    },
  };
}
