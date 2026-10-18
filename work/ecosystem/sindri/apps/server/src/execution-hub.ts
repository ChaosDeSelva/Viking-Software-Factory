import { createHash } from "node:crypto";
import { DeliveryLoop, type DeliveryNotice, type PermissionPolicy } from "@sindri/delivery";
import type { SecretStore } from "@sindri/intake";
import type { SqliteDatabase } from "@sindri/knowledge";
import { MimirClientFacade } from "@sindri/mimir-client";
import { ApiError } from "./errors.js";
import { isLoopbackHostHeader } from "./security.js";
import { FINAL_STATUSES } from "./statuses.js";
import type { SettingsStore } from "./settings.js";

export interface ExecutionHubOptions {
  db: SqliteDatabase;
  settings: SettingsStore;
  secrets?: SecretStore;
  permissionPolicy?: PermissionPolicy;
  /** fetch used for Mimir (tests). */
  mimirFetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Called when a background run fails (logged by the server). */
  onRunError?: (executionId: string, err: unknown) => void;
  /** Called after a background run returns, with the execution's status. */
  onSettled?: (executionId: string, status: string) => unknown;
  /** Delivery-loop warnings (default: dropped into onRunError's logger by the server). */
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

/** Notices relayed to SSE subscribers: the loop's own plus the server's quality assessment. */
export type HubNotice =
  | DeliveryNotice
  | { type: "quality_assessed"; executionId: string }
  | { type: "quality_failed"; executionId: string; message: string };

export interface MimirConnection {
  baseUrl: string;
  /** Held in memory only; S6's task-creation shim needs it. */
  token: string;
  facade: MimirClientFacade;
  loop: DeliveryLoop;
}

export interface MimirStatus {
  configured: boolean;
  url: string | null;
  tokenSecret: string | null;
  blocked: "local_only" | null;
  reachable: boolean | null;
  serverVersion: string | null;
  error: string | null;
}

interface Run {
  ctrl: AbortController;
  again: boolean;
  done: Promise<void>;
}

/** A failed fetch (connection refused, DNS, TLS) surfaces as 503 mimir_unavailable. */
export function asMimirUnavailable(err: unknown): unknown {
  if (err instanceof TypeError && /fetch/i.test(err.message))
    return new ApiError(503, "mimir_unavailable", "cannot reach Mimir");
  return err;
}

/**
 * Owns Sindri's connection to Mimir and the background delivery runs. Reads go through a
 * `DeliveryLoop` over an unconnected facade (no Mimir needed); mutations need a configured
 * Mimir (`settings.mimirUrl` + `settings.mimirTokenSecret` resolved via the SecretStore).
 * Every loop's notices are fanned out to subscribers (the SSE relay).
 */
export class ExecutionHub {
  readonly reader: DeliveryLoop;
  readonly #o: ExecutionHubOptions;
  readonly #listeners = new Set<(n: HubNotice) => void>();
  readonly #runs = new Map<string, Run>();
  #conn: { key: string; conn: MimirConnection } | undefined;
  #closed = false;

  constructor(o: ExecutionHubOptions) {
    this.#o = o;
    this.reader = this.#loop(new MimirClientFacade(this.#facadeOptions()));
  }

  /** Mission deep-link base (the configured Mimir URL without a trailing slash), if any. */
  mimirBaseUrl(): string | null {
    const url = this.#o.settings.get().mimirUrl;
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** The configured Mimir and its token, or 503 `mimir_unavailable` / `local_only`. */
  async #target(): Promise<{ baseUrl: string; token: string; key: string }> {
    const st = this.#o.settings.get();
    const baseUrl = this.mimirBaseUrl();
    if (!baseUrl || !st.mimirTokenSecret)
      throw new ApiError(
        503,
        "mimir_unavailable",
        "Mimir is not configured: set the Mimir URL and token secret name in Settings",
      );
    if (st.localOnly && !isLoopbackHostHeader(new URL(baseUrl).host))
      throw new ApiError(
        503,
        "local_only",
        "local-only mode allows Mimir only on a loopback address",
      );
    const token = this.#o.secrets ? await this.#o.secrets.get(st.mimirTokenSecret) : undefined;
    if (!token)
      throw new ApiError(
        503,
        "mimir_unavailable",
        `the SecretStore has no entry named ${st.mimirTokenSecret}`,
      );
    const key = `${baseUrl}\u0000${createHash("sha256").update(token).digest("hex")}`;
    return { baseUrl, token, key };
  }

  /** A connected facade + loop, or 503 `mimir_unavailable` / `local_only`. */
  async connection(): Promise<MimirConnection> {
    const { baseUrl, token, key } = await this.#target();
    if (this.#conn?.key !== key) {
      const facade = new MimirClientFacade(this.#facadeOptions()).connect({ baseUrl, token });
      this.#conn = { key, conn: { baseUrl, token, facade, loop: this.#loop(facade) } };
    }
    return this.#conn.conn;
  }

  /**
   * After a settings change: when the Mimir target changed (URL, token, or now blocked by
   * local-only), stops every run still attached to the old connection and drops it, so no run
   * keeps talking to a Mimir the settings no longer name (S7b review m2). Returns the stopped ids.
   */
  async reconfigure(): Promise<string[]> {
    const current = this.#conn;
    if (!current) return [];
    let key: string | null;
    try {
      key = (await this.#target()).key;
    } catch {
      key = null;
    }
    if (key === current.key) return [];
    const ids = [...this.#runs.keys()];
    await this.stop(ids);
    if (this.#conn === current) this.#conn = undefined;
    return ids;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async status(): Promise<MimirStatus> {
    const st = this.#o.settings.get();
    const out: MimirStatus = {
      configured: Boolean(st.mimirUrl && st.mimirTokenSecret),
      url: this.mimirBaseUrl(),
      tokenSecret: st.mimirTokenSecret ?? null,
      blocked: null,
      reachable: null,
      serverVersion: null,
      error: null,
    };
    if (!out.configured) return out;
    try {
      const { facade } = await this.connection();
      const caps = await facade.capabilities();
      out.reachable = true;
      out.serverVersion = caps.serverVersion;
    } catch (err) {
      const e = asMimirUnavailable(err);
      if (e instanceof ApiError && e.code === "local_only") out.blocked = "local_only";
      else out.reachable = false;
      out.error = e instanceof ApiError ? e.message : e instanceof Error ? e.name : "error";
    }
    return out;
  }

  /** Subscribe to every loop's notices; returns an unsubscribe function. */
  subscribe(listener: (n: HubNotice) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  isRunning(executionId: string): boolean {
    return this.#runs.has(executionId);
  }

  /**
   * Runs (or resumes) an execution in the background until it settles. A call while a run is
   * active asks it to go round once more after it settles (a decision may have unblocked it).
   */
  async ensureRunning(executionId: string): Promise<void> {
    if (this.#closed) return;
    // A finished execution has nothing to run; never re-trigger its settle hook.
    if (FINAL_STATUSES.has(this.reader.get(executionId)?.status ?? "")) return;
    const active = this.#runs.get(executionId);
    if (active) {
      active.again = true;
      return;
    }
    const { loop } = await this.connection();
    this.#start(executionId, (signal) => loop.run(executionId, { signal }));
  }

  /**
   * Stops any active run of the execution, then runs `first` (a call that resumes the loop
   * itself, such as `resolveEscalation`) in the background as the execution's single consumer.
   * Resolves once `first` has changed something (its first notice) or finished; rejects when
   * `first` fails before that, so the caller sees refusals (unknown task, Mimir errors).
   */
  async takeover(
    executionId: string,
    first: (conn: MimirConnection, signal: AbortSignal) => Promise<unknown>,
  ): Promise<void> {
    const conn = await this.connection();
    // Reserve the slot at once (the new run waits for the old one), so a concurrent
    // ensureRunning joins this run instead of starting a second consumer (review m1).
    const active = this.#runs.get(executionId);
    active?.ctrl.abort();
    let settle!: { ok: () => void; fail: (e: unknown) => void };
    const ready = new Promise<void>((ok, fail) => (settle = { ok, fail }));
    this.#start(
      executionId,
      async (signal) => {
        const unsubscribe = this.subscribe((n) => {
          if (n.executionId === executionId) settle.ok();
        });
        try {
          await first(conn, signal);
        } finally {
          unsubscribe();
        }
        settle.ok();
      },
      (err) => settle.fail(err),
      active?.done,
    );
    return ready;
  }

  #start(
    executionId: string,
    first: (signal: AbortSignal) => Promise<unknown>,
    onEarlyError?: (err: unknown) => void,
    after?: Promise<void>,
  ): void {
    const ctrl = new AbortController();
    const run = { ctrl, again: false } as Run;
    this.#runs.set(executionId, run);
    const before = this.reader.get(executionId)?.status;
    run.done = (async () => {
      try {
        await after;
        await first(ctrl.signal);
        const { loop } = await this.connection();
        while (run.again && !ctrl.signal.aborted) {
          run.again = false;
          await loop.run(executionId, { signal: ctrl.signal });
        }
        // Only when this run moved the execution into a final status.
        const status = this.reader.get(executionId)?.status;
        if (
          status &&
          !ctrl.signal.aborted &&
          FINAL_STATUSES.has(status) &&
          !FINAL_STATUSES.has(before ?? "")
        )
          await this.#o.onSettled?.(executionId, status);
      } catch (err) {
        onEarlyError?.(err);
        this.#o.onRunError?.(executionId, err);
      } finally {
        if (this.#runs.get(executionId) === run) this.#runs.delete(executionId);
      }
    })();
  }

  /** Stops the background runs of these executions and waits for them to end. */
  async stop(executionIds: readonly string[]): Promise<void> {
    const runs = executionIds
      .map((id) => this.#runs.get(id))
      .filter((r): r is Run => r !== undefined);
    for (const r of runs) r.ctrl.abort();
    await Promise.all(runs.map((r) => r.done));
  }

  /** Best effort: asks Mimir to cancel these missions (project purge). Never throws. */
  async cancelMissions(missionIds: readonly string[], reason: string): Promise<void> {
    if (missionIds.length === 0) return;
    let conn: MimirConnection;
    try {
      conn = await this.connection();
    } catch {
      return;
    }
    for (const id of missionIds) {
      try {
        await conn.facade.cancel(id, reason);
      } catch (err) {
        this.#o.logger?.warn("mission cancel on purge failed", { missionId: id, err: String(err) });
      }
    }
  }

  /** Lets notices from outside a loop (quality assessment) reach SSE subscribers. */
  emit(notice: HubNotice): void {
    for (const l of this.#listeners) l(notice);
  }

  /** Aborts every run and waits for them to stop writing. */
  async close(): Promise<void> {
    this.#closed = true;
    const runs = [...this.#runs.values()];
    for (const r of runs) r.ctrl.abort();
    await Promise.all(runs.map((r) => r.done));
    this.#runs.clear();
    this.#listeners.clear();
  }

  #facadeOptions() {
    return {
      db: this.#o.db,
      acceptanceCriteriaFor: (plan: { specId: string }) => {
        const row = this.#o.db
          .prepare("SELECT body_json FROM specifications WHERE id = ?")
          .get(plan.specId) as { body_json: string } | undefined;
        if (!row) throw new Error("Cannot execute a plan without its specification");
        return (JSON.parse(row.body_json) as { acceptanceCriteria: { id: string; text: string }[] })
          .acceptanceCriteria;
      },
      agentKindFor: (_harness: string, role: string) => {
        const st = this.#o.settings.get();
        return ["reviewer", "qa", "security"].includes(role)
          ? (st.reviewerAgent ?? "claude")
          : (st.workerAgent ?? "claude");
      },
      ...(this.#o.mimirFetch ? { fetch: this.#o.mimirFetch } : {}),
      ...(this.#o.now ? { now: this.#o.now } : {}),
    };
  }

  #loop(facade: MimirClientFacade): DeliveryLoop {
    const loop = new DeliveryLoop({
      db: this.#o.db,
      mimir: facade,
      ...(this.#o.permissionPolicy ? { permissionPolicy: this.#o.permissionPolicy } : {}),
      ...(this.#o.now ? { now: this.#o.now } : {}),
      ...(this.#o.logger ? { logger: this.#o.logger } : {}),
    });
    loop.on((n) => {
      for (const l of this.#listeners) l(n);
    });
    return loop;
  }
}
