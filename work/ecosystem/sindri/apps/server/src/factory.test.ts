import { DeliveryLoop } from "@sindri/delivery";
import { FakeProvider } from "@sindri/director";
import { openDatabase, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryService } from "./delivery-service.js";
import type { HubNotice } from "./execution-hub.js";
import { backfillAssessmentClaims, createFactory, type FactoryOptions } from "./factory.js";
import { createServices, type ServiceOptions } from "./services.js";
import { DEFAULT_SETTINGS } from "./settings.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(
  opts: Partial<ServiceOptions & FactoryOptions> = {},
  mimir: { url?: string; secret?: () => Promise<string | undefined> } = {},
) {
  let fake: FakeMimir | undefined;
  if (!mimir.url) {
    fake = await createFakeMimir();
    cleanups.push(() => fake!.close());
  }
  const token = fake?.token ?? "tok";
  const db: SqliteDatabase = openDatabase(":memory:");
  const secrets = { get: mimir.secret ?? (() => Promise.resolve(token)) };
  const services = createServices({ db, secrets, ...opts });
  services.settings.put({
    ...DEFAULT_SETTINGS,
    mimirUrl: mimir.url ?? fake!.url,
    mimirTokenSecret: "m.tok",
  });
  const errors: [string, unknown][] = [];
  const factory = createFactory(
    {
      db,
      secrets,
      onRunError: (id, err) => errors.push([id, err]),
      ...opts,
    },
    services,
  );
  cleanups.push(async () => {
    factory.close();
    await factory.hub.close();
  });
  const notices: HubNotice[] = [];
  factory.hub.subscribe((n) => notices.push(n));
  const addExecution = (id: string, status: string) =>
    db
      .prepare(
        `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at)
         VALUES (?, 'pln', 1, ?, ?, '{}', '2026-01-01T00:00:00Z')`,
      )
      .run(id, `msn_${id}`, status);
  return { db, services, factory, errors, notices, addExecution, fake };
}

describe("backfillAssessmentClaims", () => {
  it("does nothing before the delivery tables exist", () => {
    const db = openDatabase(":memory:");
    backfillAssessmentClaims(db);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'quality_assessments'").get(),
    ).toBeUndefined();
  });
});

describe("startup resume", () => {
  it("releases the claim and reports a settle assessment that fails, so a later start retries", async () => {
    const assess = vi.fn().mockRejectedValue(new RangeError("report failed"));
    const delivery = { kind: "custom", assess } as unknown as DeliveryService;
    const s = await setup({ deliveryService: delivery });
    s.addExecution("exe_1", "verified_pending_review");
    await s.factory.resume();
    expect(assess).toHaveBeenCalledWith("exe_1");
    expect(s.errors).toEqual([["exe_1", expect.any(RangeError)]]);
    expect(s.notices).toEqual([
      { type: "quality_failed", executionId: "exe_1", message: "RangeError" },
    ]);
    expect(s.db.prepare("SELECT * FROM quality_assessments").all()).toEqual([]);
    // Released: the next resume claims and tries again.
    assess.mockResolvedValueOnce(undefined);
    await s.factory.resume();
    expect(assess).toHaveBeenCalledTimes(2);
    expect(s.notices.at(-1)).toEqual({ type: "quality_assessed", executionId: "exe_1" });
    // Claimed now: a third resume does not assess again.
    await s.factory.resume();
    expect(assess).toHaveBeenCalledTimes(2);
  });

  it("names a non-Error assessment failure generically", async () => {
    const delivery = {
      kind: "custom",
      assess: () => Promise.reject("nope"),
    } as unknown as DeliveryService;
    const s = await setup({ deliveryService: delivery });
    s.addExecution("exe_1", "verified_pending_review");
    await s.factory.resume();
    expect(s.notices).toEqual([{ type: "quality_failed", executionId: "exe_1", message: "error" }]);
  });

  it("reports an execution it cannot resume and goes on with the next", async () => {
    let calls = 0;
    const s = await setup({}, {});
    const tokenOf = s.fake!.token;
    // The first connection (the reachability check) works; resuming the runs then does not.
    const run = vi.spyOn(DeliveryLoop.prototype, "run").mockResolvedValue("interrupted" as never);
    const t = await setup(
      {},
      {
        url: s.fake!.url,
        secret: () => Promise.resolve(++calls === 1 ? tokenOf : undefined),
      },
    );
    t.addExecution("exe_1", "running");
    t.addExecution("exe_2", "awaiting_human");
    await t.factory.resume();
    expect(t.errors.map(([id]) => id)).toEqual(["exe_1", "exe_2"]);
    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing once closed, and stops retrying an unreachable Mimir on close", async () => {
    const s = await setup({ resumeRetryMs: 60_000 }, { url: "http://127.0.0.1:9" });
    const capabilities = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const conn = await s.factory.hub.connection();
    conn.facade.capabilities = capabilities;
    await s.factory.resume();
    // A second failure while a retry is already scheduled does not schedule another.
    await s.factory.resume();
    expect(capabilities).toHaveBeenCalledTimes(2);
    s.factory.close();
    await s.factory.resume();
    expect(capabilities).toHaveBeenCalledTimes(2);
  });
});

describe("providers and harness services", () => {
  it("builds the planning provider from settings and reuses it until they change", async () => {
    const providerFactory = vi.fn(() => new FakeProvider(() => ({ text: "x" })));
    const s = await setup({ providerFactory });
    const a = s.factory.provider();
    expect(s.factory.provider()).toBe(a);
    s.services.settings.put({ ...s.services.settings.get(), model: "other-model" });
    expect(s.factory.provider()).not.toBe(a);
    expect(providerFactory).toHaveBeenCalledTimes(2);
  });

  it("uses the settings' provider without a provider factory, and Brokkr when enabled", async () => {
    vi.stubEnv("SINDRI_BROKKR_HOME", "/nonexistent-brokkr-home");
    const s = await setup();
    s.services.settings.put({
      ...s.services.settings.get(),
      provider: "fake",
      apiKeySecret: "anthropic.key",
    });
    expect(s.factory.provider()).toBeDefined();
    expect(s.factory.harnesses("/repo").source).toBe("fake");
    s.services.settings.put({ ...s.services.settings.get(), brokkrEnabled: true });
    expect(s.factory.harnesses("/repo").source).toBe("brokkr");
    expect(s.factory.harnesses().source).toBe("brokkr");
  });
});

describe("S6 delivery service", () => {
  it("assesses nothing for an execution it does not know", async () => {
    const s = await setup();
    await expect(s.factory.delivery.assess("exe_nope")).resolves.toBeUndefined();
    expect(s.factory.delivery.gateResults("exe_nope")).toEqual([]);
    expect(s.factory.delivery.reviews("exe_nope")).toEqual([]);
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM gate_evaluations").get()).toEqual({ n: 0 });
  });
});
