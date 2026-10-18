import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { createLock, Registry } from "@brokkr/registry";
import { loadContract } from "./index.js";
import { tmp } from "../test/helpers.js";

const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures/harnesses");

/** A built-in dir with e2e-react, a workspace with its own noop harness, config, lock and exceptions. */
function setup() {
  const builtinDir = tmp("brokkr-builtin-");
  cpSync(join(FIXTURES, "e2e-react"), join(builtinDir, "e2e-react"), { recursive: true });
  mkdirSync(join(builtinDir, "profiles"));
  writeFileSync(
    join(builtinDir, "profiles", "frontend-strict.yaml"),
    stringify({ name: "frontend-strict", harnesses: [{ name: "e2e-react", version: "^1.0.0" }] }),
  );
  const workspace = tmp("brokkr-ws-");
  cpSync(join(FIXTURES, "e2e-react"), join(workspace, ".brokkr", "harnesses", "noop"), {
    recursive: true,
  });
  const noop = join(workspace, ".brokkr", "harnesses", "noop", "harness.yaml");
  writeFileSync(noop, readFileSync(noop, "utf8").replace(/e2e-react/g, "noop"));
  writeFileSync(
    join(workspace, ".brokkr", "config.yaml"),
    stringify({ version: 1, harnesses: [{ name: "noop", version: "^1.0.0" }] }),
  );
  writeFileSync(
    join(workspace, ".brokkr", "exceptions.yaml"),
    stringify({ exceptions: [exception("from-workspace", "security-team@example.com")] }),
  );
  const home = tmp("brokkr-home-");
  const outside = tmp("brokkr-caller-");
  return { builtinDir, workspace, home, outside };
}

function exception(id: string, approvedBy: string) {
  return {
    id,
    policy: "check:unit",
    scope: {},
    reason: "r",
    approvedBy,
    approvedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    evidence: [],
  };
}

describe("loadContract: developer mode keeps workspace configuration", () => {
  it("reads the workspace config, harnesses and exceptions", async () => {
    const s = setup();
    const c = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer",
    });
    expect(c.trustMode).toBe("developer");
    expect(c.set.harnesses.map((h) => h.manifest.metadata.name)).toEqual(["noop"]);
    expect(c.exceptions.map((e) => e.id)).toEqual(["from-workspace"]);
    expect(c.warnings.join()).toMatch(/not pinned/);
    expect(c.lockProblems).toEqual([]);
  });

  it("refuses a config profile that shadows a built-in profile name", async () => {
    const s = setup();
    writeFileSync(
      join(s.workspace, ".brokkr", "config.yaml"),
      stringify({
        version: 1,
        harnesses: [],
        profiles: [{ name: "frontend-strict", harnesses: [{ name: "noop", version: "^1.0.0" }] }],
      }),
    );
    await expect(
      loadContract({
        workspace: s.workspace,
        home: s.home,
        builtinDir: s.builtinDir,
        trust: "developer",
        profile: "frontend-strict",
      }),
    ).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/shadows the built-in profile/),
    });
  });
});

describe("loadContract: workspace-untrusted mode (audit C1/C2)", () => {
  it("is the default and never reads the workspace config", async () => {
    const s = setup();
    await expect(
      loadContract({ workspace: s.workspace, home: s.home, builtinDir: s.builtinDir }),
    ).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/caller-supplied config/),
    });
  });

  it("uses the caller config, ignores workspace exceptions and blocks without a lock", async () => {
    const s = setup();
    const config = join(s.outside, "config.yaml");
    writeFileSync(
      config,
      stringify({ version: 1, harnesses: [{ name: "e2e-react", version: "^1.0.0" }] }),
    );
    const c = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      configFile: config,
    });
    expect(c.trustMode).toBe("workspace-untrusted");
    expect(c.set.harnesses.map((h) => h.manifest.metadata.name)).toEqual(["e2e-react"]);
    expect(c.exceptions).toEqual([]);
    expect(c.warnings.join("\n")).toMatch(
      /workspace \.brokkr\/(config\.yaml|exceptions\.yaml) ignored/,
    );
    expect(c.lockProblems).toEqual([expect.stringMatching(/no lock supplied by the caller/)]);
  });

  it("treats workspace harnesses as untrusted even when the caller config names them", async () => {
    const s = setup();
    const config = join(s.outside, "config.yaml");
    writeFileSync(
      config,
      stringify({ version: 1, harnesses: [{ name: "noop", version: "^1.0.0" }] }),
    );
    await expect(
      loadContract({
        workspace: s.workspace,
        home: s.home,
        builtinDir: s.builtinDir,
        configFile: config,
      }),
    ).rejects.toMatchObject({ code: "trust_required" });
  });

  it("refuses caller paths that point inside the workspace", async () => {
    const s = setup();
    await expect(
      loadContract({
        workspace: s.workspace,
        home: s.home,
        builtinDir: s.builtinDir,
        configFile: join(s.workspace, ".brokkr", "config.yaml"),
      }),
    ).rejects.toMatchObject({
      code: "invalid-config",
      message: expect.stringMatching(/inside the verified workspace/),
    });
  });

  it("accepts a caller lock and exceptions; exceptions need a caller-trusted approver", async () => {
    const s = setup();
    const config = join(s.outside, "config.yaml");
    writeFileSync(
      config,
      stringify({ version: 1, harnesses: [{ name: "e2e-react", version: "^1.0.0" }] }),
    );
    const registry = new Registry({
      cwd: s.outside,
      builtinDir: s.builtinDir,
      homeDir: s.home,
      config: { version: 1, harnesses: [] },
    });
    await registry.load();
    const lock = createLock(
      registry.resolve({ harnesses: [{ name: "e2e-react", range: "^1.0.0" }] }),
      [],
    );
    const lockFile = join(s.outside, "harness.lock.json");
    writeFileSync(lockFile, JSON.stringify(lock));
    const exceptionsFile = join(s.outside, "exceptions.yaml");
    writeFileSync(
      exceptionsFile,
      stringify({ exceptions: [exception("ok", "lead@example.com"), exception("self", "agent")] }),
    );
    const c = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      configFile: config,
      lockFile,
      exceptionsFile,
      approvers: ["lead@example.com"],
    });
    expect(c.lockProblems).toEqual([]);
    expect(c.lockDigest).toBe(lock.digest);
    expect(c.approvers).toEqual(["lead@example.com"]);
    expect(c.policySources.map((p) => p.origin)).toEqual(["external"]);
  });
});

describe("caller paths named like '..x' inside the workspace (fix round 2, minor 3)", () => {
  it("a workspace directory called '..x' is still inside the workspace", async () => {
    const s = setup();
    mkdirSync(join(s.workspace, "..x"));
    writeFileSync(join(s.workspace, "..x", "config.yaml"), "version: 1\nharnesses: []\n");
    await expect(
      loadContract({
        workspace: s.workspace,
        home: s.home,
        builtinDir: s.builtinDir,
        configFile: join(s.workspace, "..x", "config.yaml"),
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/inside the verified workspace/) });
  });
});
