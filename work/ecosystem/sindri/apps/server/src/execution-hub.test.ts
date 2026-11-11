import { DeliveryLoop, ensureDeliverySchema } from "@sindri/delivery";
import { applyMigrations, openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./errors.js";
import { asMimirUnavailable, ExecutionHub } from "./execution-hub.js";
import { SERVER_MIGRATIONS } from "./schema.js";
import { DEFAULT_SETTINGS, SettingsStore } from "./settings.js";

const MIMIR = "http://127.0.0.1:1";

function setup(
  settings: Partial<typeof DEFAULT_SETTINGS> = {},
  secret: () => Promise<string | undefined> = () => Promise.resolve("tok"),
) {
  const db: SqliteDatabase = openDatabase(":memory:");
  applyMigrations(db, "server", SERVER_MIGRATIONS);
  ensureDeliverySchema(db);
  const store = new SettingsStore(db, () => new Date());
  store.put({ ...DEFAULT_SETTINGS, mimirUrl: MIMIR, mimirTokenSecret: "m.tok", ...settings });
  const errors: [string, unknown][] = [];
  const settled: [string, string][] = [];
  const warnings: string[] = [];
  const hub = new ExecutionHub({
    db,
    settings: store,
    secrets: { get: secret },
    onRunError: (id, err) => errors.push([id, err]),
    onSettled: (id, status) => settled.push([id, status]),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  const addExecution = (id: string, status = "running") =>
    db
      .prepare(
        `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
         VALUES (?, 'pln', 1, ?, ?, '{}', '2026-01-01T00:00:00Z')`,
      )
      .run(id, `msn_${id}`, status);
  const setStatus = (id: string, status: string) =>
    db.prepare("UPDATE executions SET status = ? WHERE id = ?").run(status, id);
  return { db, store, hub, errors, settled, warnings, addExecution, setStatus };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `DeliveryLoop.run` that stays running until released. */
function holdRuns() {
  const releases: (() => void)[] = [];
  const run = vi.spyOn(DeliveryLoop.prototype, "run").mockImplementation(
    (_id, opts) =>
      new Promise((resolve) => {
        const done = () => resolve("interrupted" as never);
        releases.push(done);
        opts?.signal?.addEventListener("abort", done);
      }),
  );
  return { run, releaseAll: () => releases.splice(0).forEach((r) => r()) };
}

describe("ExecutionHub.ensureRunning", () => {
  it("starts one consumer when two callers ask for the same execution at once", async () => {
    const s = setup();
    s.addExecution("exe_1");
    const { run, releaseAll } = holdRuns();
    // Both calls see no active run before either has its connection.
    await Promise.all([s.hub.ensureRunning("exe_1"), s.hub.ensureRunning("exe_1")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.hub.isRunning("exe_1")).toBe(true);
    releaseAll();
    await s.hub.close();
  });

  it("goes round once more when asked while running, then reports the final status once", async () => {
    const s = setup();
    s.addExecution("exe_1");
    const { run, releaseAll } = holdRuns();
    await s.hub.ensureRunning("exe_1");
    await s.hub.ensureRunning("exe_1");
    releaseAll();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    s.setStatus("exe_1", "verified_pending_review");
    releaseAll();
    await vi.waitFor(() => expect(s.hub.isRunning("exe_1")).toBe(false));
    expect(s.settled).toEqual([["exe_1", "verified_pending_review"]]);
    // A finished execution is not run again.
    await s.hub.ensureRunning("exe_1");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does nothing once closed", async () => {
    const s = setup();
    s.addExecution("exe_1");
    const { run } = holdRuns();
    await s.hub.close();
    expect(s.hub.closed).toBe(true);
    await s.hub.ensureRunning("exe_1");
    expect(run).not.toHaveBeenCalled();
  });

  it("does not start a run when the hub closes while the connection is being made", async () => {
    let release!: (v: string) => void;
    const s = setup({}, () => new Promise((r) => (release = r)));
    s.addExecution("exe_1");
    const { run } = holdRuns();
    const pending = s.hub.ensureRunning("exe_1");
    await s.hub.close();
    release("tok");
    await pending;
    expect(run).not.toHaveBeenCalled();
    expect(s.hub.isRunning("exe_1")).toBe(false);
  });

  it("reports a failed background run to onRunError", async () => {
    const s = setup();
    s.addExecution("exe_1");
    vi.spyOn(DeliveryLoop.prototype, "run").mockRejectedValue(new Error("boom"));
    await s.hub.ensureRunning("exe_1");
    await vi.waitFor(() => expect(s.errors).toHaveLength(1));
    expect(s.errors[0]![0]).toBe("exe_1");
    expect(s.hub.isRunning("exe_1")).toBe(false);
  });
});

describe("ExecutionHub connection and settings", () => {
  it("refuses without a URL or token secret, a non-loopback Mimir under local-only, and a missing secret", async () => {
    await expect(setup({ mimirUrl: undefined }).hub.connection()).rejects.toMatchObject({
      status: 503,
      code: "mimir_unavailable",
    });
    await expect(
      setup({ mimirUrl: "https://mimir.example.com", localOnly: true }).hub.connection(),
    ).rejects.toMatchObject({ status: 503, code: "local_only" });
    await expect(
      setup({}, () => Promise.resolve(undefined)).hub.connection(),
    ).rejects.toMatchObject({
      code: "mimir_unavailable",
      message: expect.stringContaining("m.tok"),
    });
  });

  it("keeps one connection per target and strips trailing slashes from the base URL", async () => {
    const s = setup({ mimirUrl: `${MIMIR}//` });
    expect(s.hub.mimirBaseUrl()).toBe(MIMIR);
    const a = await s.hub.connection();
    expect(await s.hub.connection()).toBe(a);
    expect(a.baseUrl).toBe(MIMIR);
  });

  it("reconfigure() stops runs only when the target changed, and drops the old connection", async () => {
    const s = setup();
    expect(await s.hub.reconfigure()).toEqual([]); // never connected
    s.addExecution("exe_1");
    const { releaseAll } = holdRuns();
    await s.hub.ensureRunning("exe_1");
    const before = await s.hub.connection();
    expect(await s.hub.reconfigure()).toEqual([]); // same target
    s.store.put({ ...s.store.get(), mimirUrl: undefined });
    expect(await s.hub.reconfigure()).toEqual(["exe_1"]);
    expect(s.hub.isRunning("exe_1")).toBe(false);
    s.store.put({ ...s.store.get(), mimirUrl: MIMIR });
    expect(await s.hub.connection()).not.toBe(before);
    releaseAll();
  });

  it("status() reports unconfigured, blocked and unreachable targets", async () => {
    expect(await setup({ mimirUrl: undefined }).hub.status()).toMatchObject({
      configured: false,
      reachable: null,
    });
    expect(
      await setup({ mimirUrl: "https://mimir.example.com", localOnly: true }).hub.status(),
    ).toMatchObject({ configured: true, blocked: "local_only", reachable: null });
    const missing = await setup({}, () => Promise.resolve(undefined)).hub.status();
    expect(missing).toMatchObject({ reachable: false, error: expect.stringContaining("m.tok") });
  });

  it("cancelMissions is best effort: nothing without missions or a connection, warns per failure", async () => {
    const s = setup();
    const cancel = vi.fn().mockRejectedValue(new Error("down"));
    const conn = await s.hub.connection();
    conn.facade.cancel = cancel;
    await s.hub.cancelMissions([], "x");
    expect(cancel).not.toHaveBeenCalled();
    await s.hub.cancelMissions(["msn_1", "msn_2"], "purged");
    expect(cancel.mock.calls).toEqual([
      ["msn_1", "purged"],
      ["msn_2", "purged"],
    ]);
    expect(s.warnings).toEqual([
      "mission cancel on purge failed",
      "mission cancel on purge failed",
    ]);
    const unconfigured = setup({ mimirUrl: undefined });
    await expect(unconfigured.hub.cancelMissions(["msn_1"], "x")).resolves.toBeUndefined();
  });

  it("emit() reaches subscribers until they unsubscribe", () => {
    const s = setup();
    const seen: unknown[] = [];
    const off = s.hub.subscribe((n) => seen.push(n));
    s.hub.emit({ type: "quality_assessed", executionId: "exe_1" });
    off();
    s.hub.emit({ type: "quality_assessed", executionId: "exe_2" });
    expect(seen).toEqual([{ type: "quality_assessed", executionId: "exe_1" }]);
  });
});

describe("asMimirUnavailable", () => {
  it("turns a failed fetch into 503 mimir_unavailable and leaves other errors alone", () => {
    const e = asMimirUnavailable(new TypeError("fetch failed"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 503, code: "mimir_unavailable" });
    const other = new TypeError("x is not a function");
    expect(asMimirUnavailable(other)).toBe(other);
  });
});
