import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { createLock, Registry } from "@brokkr/registry";
import { brokkrHomeSnapshot, loadContract, snapshotChanges } from "./index.js";
import { tmp } from "../test/helpers.js";

const FIXTURES = resolve(import.meta.dirname, "../../../tests/fixtures/harnesses");

function base() {
  const builtinDir = tmp("brokkr-builtin-");
  cpSync(join(FIXTURES, "e2e-react"), join(builtinDir, "e2e-react"), { recursive: true });
  const workspace = tmp("brokkr-ws-");
  const home = tmp("brokkr-home-");
  const outside = tmp("brokkr-caller-");
  return { builtinDir, workspace, home, outside };
}

describe("loadContract inputs (developer mode)", () => {
  it("records policy, org-policy and exceptions sources; a policy file replaces config policies", async () => {
    const s = base();
    mkdirSync(join(s.workspace, ".brokkr"));
    writeFileSync(
      join(s.workspace, ".brokkr", "config.yaml"),
      stringify({
        version: 1,
        project: "demo",
        harnesses: [{ name: "e2e-react", version: "^1.0.0" }],
        policies: { network: "deny" },
        profiles: [
          {
            name: "strict",
            harnesses: [{ name: "e2e-react", version: "^1.0.0" }],
            overrides: { policies: { reviewRequired: true } },
          },
        ],
      }),
    );
    mkdirSync(join(s.home, ".brokkr"));
    writeFileSync(join(s.home, ".brokkr", "org-policy.yaml"), "requiredCheckIds: [unit]\n");
    writeFileSync(join(s.outside, "policy.yaml"), "requiredCheckIds: [typecheck]\n");
    writeFileSync(join(s.outside, "exceptions.yaml"), "exceptions: []\n");
    const c = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer",
      policyFile: join(s.outside, "policy.yaml"),
      exceptionsFile: join(s.outside, "exceptions.yaml"),
      profile: "strict",
    });
    expect(c.projectId).toBe("demo");
    expect(c.policySources.map((p) => p.kind).sort()).toEqual([
      "exceptions",
      "organization-policy",
      "project-policy",
    ]);
    expect(c.warnings.join()).toMatch(/config policies were ignored/);
    expect(c.layers.map((l) => l.layer)).toEqual(["organization", "project", "task"]);

    const viaConfig = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer",
      policy: { reviewRequired: true },
    });
    expect(viaConfig.layers.find((l) => l.layer === "project")?.policy).toEqual({
      reviewRequired: true,
    });
    const configPolicies = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer",
    });
    expect(
      configPolicies.policySources.some(
        (p) => p.kind === "project-policy" && p.origin === "workspace_supplied",
      ),
    ).toBe(true);
  });

  it("invalid profile policies, unknown profiles and invalid config files are invalid-config", async () => {
    const s = base();
    writeFileSync(
      join(s.outside, "config.yaml"),
      stringify({
        version: 1,
        harnesses: [{ name: "e2e-react", version: "^1.0.0" }],
        profiles: [{ name: "bad", harnesses: [], overrides: { policies: { network: "maybe" } } }],
      }),
    );
    const opts = {
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer" as const,
      configFile: join(s.outside, "config.yaml"),
    };
    await expect(loadContract({ ...opts, profile: "bad" })).rejects.toMatchObject({
      code: "invalid-config",
    });
    await expect(loadContract({ ...opts, profile: "nope" })).rejects.toMatchObject({
      code: "not-found",
    });
    writeFileSync(join(s.outside, "broken.yaml"), "version: 2\n");
    await expect(
      loadContract({ ...opts, configFile: join(s.outside, "broken.yaml") }),
    ).rejects.toMatchObject({
      code: "invalid-config",
    });
    await expect(
      loadContract({ ...opts, configFile: join(s.outside, "missing.yaml") }),
    ).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("a workspace lock that does not match is reported as lock problems", async () => {
    const s = base();
    mkdirSync(join(s.workspace, ".brokkr"));
    writeFileSync(
      join(s.workspace, ".brokkr", "config.yaml"),
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
    const tampered = {
      ...lock,
      harnesses: lock.harnesses.map((h) => ({ ...h, digest: `sha256:${"0".repeat(64)}` })),
    };
    writeFileSync(join(s.workspace, ".brokkr", "harness.lock.json"), JSON.stringify(tampered));
    const c = await loadContract({
      workspace: s.workspace,
      home: s.home,
      builtinDir: s.builtinDir,
      trust: "developer",
    });
    expect(c.lockProblems.join()).toMatch(/modified|content digest/);
  });

  it("an unresolvable harness reports registry diagnostics", async () => {
    const s = base();
    mkdirSync(join(s.workspace, ".brokkr", "harnesses", "broken"), { recursive: true });
    writeFileSync(
      join(s.workspace, ".brokkr", "harnesses", "broken", "harness.yaml"),
      "kind: Harness\n",
    );
    writeFileSync(
      join(s.outside, "c.yaml"),
      stringify({ version: 1, harnesses: [{ name: "broken", version: "^1.0.0" }] }),
    );
    await expect(
      loadContract({
        workspace: s.workspace,
        home: s.home,
        builtinDir: s.builtinDir,
        trust: "developer",
        configFile: join(s.outside, "c.yaml"),
      }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/registry diagnostics/) });
  });
});

describe("brokkrHomeSnapshot", () => {
  it("records files and symlinks (not followed), ignores the run store, and reports changes", async () => {
    const home = tmp("brokkr-home-");
    mkdirSync(join(home, ".brokkr", "runs", "x"), { recursive: true });
    writeFileSync(join(home, ".brokkr", "runs", "x", "f"), "1");
    writeFileSync(join(home, ".brokkr", "config.yaml"), "a");
    symlinkSync("/etc/hosts", join(home, ".brokkr", "link"));
    const before = await brokkrHomeSnapshot(home);
    expect([...before.keys()].sort()).toEqual(["config.yaml", "link"]);
    writeFileSync(join(home, ".brokkr", "runs", "x", "f"), "2");
    writeFileSync(join(home, ".brokkr", "new.yaml"), "n");
    const { rmSync } = await import("node:fs");
    rmSync(join(home, ".brokkr", "config.yaml"));
    expect(snapshotChanges(before, await brokkrHomeSnapshot(home))).toEqual([
      "config.yaml",
      "new.yaml",
    ]);
    expect((await brokkrHomeSnapshot(tmp("brokkr-empty-"))).size).toBe(0);
    void readFileSync;
  });
});
