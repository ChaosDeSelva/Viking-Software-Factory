import { openDatabase, openKnowledge, type SqliteDatabase } from "@sindri/knowledge";
import { createFakeMimir, type FakeMimir } from "@sindri/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MimirClientFacade, type MimirClientFacadeOptions } from "./facade.js";
import { profileSettingsFromDb, settingsFromProfile } from "./project-settings.js";

const PROFILE = {
  checks: [{ id: "test", command: ["make", "test"], cwd: "services/api" }],
  network: "allow",
  env: { GOCACHE: "/caches/build", GOMODCACHE: "/caches/mod" },
  pathPrepend: ["/opt/shims"],
  codexSandbox: { writableRoots: ["/caches"], networkAccess: false },
  verificationTimeoutMs: 1_800_000,
};
const SETTINGS = {
  agent: {
    env: { GOCACHE: "/caches/build", GOMODCACHE: "/caches/mod" },
    pathPrepend: ["/opt/shims"],
    codexSandbox: { writableRoots: ["/caches"], networkAccess: false },
  },
  verificationTimeoutMs: 1_800_000,
};

let fake: FakeMimir | undefined;
let db: SqliteDatabase | undefined;
afterEach(async () => {
  await fake?.close();
  db?.close();
  fake = undefined;
  db = undefined;
});

interface Patch {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A facade on the fake Mimir; PATCH requests are recorded and answered by `onPatch` if given. */
async function boot(
  options: Partial<MimirClientFacadeOptions> = {},
  onPatch?: (p: Patch) => Response,
) {
  fake = await createFakeMimir({ stepDelayMs: 0 });
  db = openDatabase(":memory:");
  const patches: Patch[] = [];
  const warnings: string[] = [];
  const facade = new MimirClientFacade({
    db,
    onWarn: (msg) => warnings.push(msg),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const patch = {
          url: String(input),
          headers: init.headers as Record<string, string>,
          body: JSON.parse(String(init.body)) as unknown,
        };
        patches.push(patch);
        if (onPatch) return onPatch(patch);
      }
      return fetch(input, init);
    }) as typeof fetch,
    ...options,
  });
  facade.connect({ baseUrl: fake.url, token: fake.token });
  return { fake, db, facade, patches, warnings };
}

const created = (f: FakeMimir) =>
  f.requests.filter((r) => r.method === "POST" && r.path === "/v1/projects").map((r) => r.body);

describe("settingsFromProfile", () => {
  it("maps env, pathPrepend, codexSandbox and the verification timeout", () => {
    expect(settingsFromProfile(PROFILE)).toEqual(SETTINGS);
  });

  it("leaves out what the profile does not set", () => {
    expect(settingsFromProfile({})).toEqual({});
    expect(settingsFromProfile({ checks: PROFILE.checks, env: {}, pathPrepend: [] })).toEqual({});
    expect(settingsFromProfile({ pathPrepend: ["/opt/shims"] })).toEqual({
      agent: { pathPrepend: ["/opt/shims"] },
    });
  });
});

describe("ensureProject with an execution profile", () => {
  it("sends the agent settings when it creates the Mimir project", async () => {
    const { facade, fake } = await boot({ projectSettingsFor: () => SETTINGS });
    const project = await facade.ensureProject("/repos/app", { protectedBranches: ["main"] });
    expect(created(fake)).toEqual([
      {
        name: "app",
        repoPath: "/repos/app",
        settings: { protectedBranches: ["main"], ...SETTINGS },
      },
    ]);
    expect(project.settings).toEqual({ protectedBranches: ["main"], ...SETTINGS });
  });

  it("reads the profile of the Sindri project stored for the repository by default", async () => {
    const { facade, fake, db } = await boot();
    const knowledge = openKnowledge(db);
    const p = knowledge.projects.create({ name: "App", repoPath: "/repos/app" });
    expect(profileSettingsFromDb(db, "/repos/app")).toBeUndefined();
    knowledge.projects.setSettings(p.id, { executionProfile: PROFILE });
    expect(profileSettingsFromDb(db, "/repos/app")).toEqual(SETTINGS);
    expect(profileSettingsFromDb(db, "/repos/other")).toBeUndefined();

    await facade.ensureProject("/repos/app");
    expect(created(fake)).toEqual([{ name: "app", repoPath: "/repos/app", settings: SETTINGS }]);
  });

  it("sends empty settings and never patches for a project without a profile", async () => {
    const { facade, fake, patches } = await boot();
    await facade.ensureProject("/repos/app");
    await facade.ensureProject("/repos/app");
    expect(created(fake)).toEqual([{ name: "app", repoPath: "/repos/app", settings: {} }]);
    expect(patches).toEqual([]);
  });

  it("does not patch an existing project whose settings are up to date", async () => {
    const { facade, patches } = await boot({ projectSettingsFor: () => SETTINGS });
    await facade.ensureProject("/repos/app");
    await facade.ensureProject("/repos/app");
    expect(patches).toEqual([]);
  });

  it("patches an existing project when the profile changed, keeping its other settings", async () => {
    let owned: object = SETTINGS;
    const { facade, fake, patches } = await boot({ projectSettingsFor: () => owned }, () =>
      Response.json({ project: {} }),
    );
    const first = await facade.ensureProject("/repos/app", { protectedBranches: ["main"] });
    owned = { agent: { env: { GOFLAGS: "-mod=mod" } } };
    const second = await facade.ensureProject("/repos/app");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(`${fake.url}/v1/projects/${first.id}`);
    expect(patches[0]!.body).toEqual({
      settings: { protectedBranches: ["main"], agent: { env: { GOFLAGS: "-mod=mod" } } },
    });
    expect(patches[0]!.headers).toMatchObject({
      authorization: `Bearer ${fake.token}`,
      "content-type": "application/json",
      "idempotency-key": expect.any(String),
    });
    expect(second.id).toBe(first.id);
    expect(second.settings).toEqual({
      protectedBranches: ["main"],
      agent: { env: { GOFLAGS: "-mod=mod" } },
    });
  });

  it("continues with a warning when Mimir has no PATCH route (404 or 405)", async () => {
    let owned: object = SETTINGS;
    // The fake Mimir predates the route and answers 404 itself.
    const a = await boot({ projectSettingsFor: () => owned });
    const first = await a.facade.ensureProject("/repos/app");
    owned = {};
    const second = await a.facade.ensureProject("/repos/app");
    expect(a.patches).toHaveLength(1);
    expect(second).toEqual(first);
    expect(a.warnings).toHaveLength(1);
    await a.fake.close();
    a.db.close();

    owned = SETTINGS;
    const b = await boot(
      { projectSettingsFor: () => owned },
      () => new Response(null, { status: 405 }),
    );
    await b.facade.ensureProject("/repos/app");
    owned = {};
    await expect(b.facade.ensureProject("/repos/app")).resolves.toMatchObject({
      settings: SETTINGS,
    });
    expect(b.warnings).toHaveLength(1);
  });

  it("fails when Mimir refuses the new settings", async () => {
    let owned: object = SETTINGS;
    const { facade } = await boot({ projectSettingsFor: () => owned }, () =>
      Response.json(
        { error: { code: "validation_failed", message: "bad settings" } },
        { status: 422 },
      ),
    );
    await facade.ensureProject("/repos/app");
    owned = {};
    await expect(facade.ensureProject("/repos/app")).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});
