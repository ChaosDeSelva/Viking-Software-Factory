import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@brokkr/sdk";
import { MockExecutor } from "@brokkr/sdk/testing";
import { MimirError } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokkrVerifier,
  VerificationSettingsSchema,
  loadBrokkrSdk,
  parseHarnessRef,
  type BrokkrSdk,
  type BrokkrVerifyInput,
} from "./index.js";

const dirs: string[] = [];
const tmp = (prefix = "mimir-bv-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A git worktree whose package.json has the documentation harness's required scripts. */
function worktree(): { path: string; head: string; base: string } {
  const path = tmp("mimir-bv-wt-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: path,
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: path },
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({
      name: "wt",
      private: true,
      scripts: { "docs:links": "node -e 0", "docs:examples": "node -e 0" },
    }),
  );
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(path, "README.md"), "# docs\n");
  // Brokkr blocks package scripts when dependencies are not installed.
  mkdirSync(join(path, "node_modules"));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "work");
  return { path, head: git("rev-parse", "HEAD"), base };
}

const TASK = "tsk_01J0000000000000000000000A";
const MISSION = "msn_01J0000000000000000000000B";

/** Operator-side state outside the worktree: Brokkr home, Mimir data dir, settings files. */
interface Env {
  home: string;
  dataDir: string;
  settings: string;
  lockPath: string;
}

async function env(wt: { path: string }): Promise<Env> {
  const home = tmp("mimir-bv-home-");
  const settings = tmp("mimir-bv-settings-");
  const sel = await new sdk.Brokkr({ cwd: wt.path, homeDir: home }).resolve({
    task: { id: TASK, title: "t", description: "d" },
    harnesses: [{ name: "documentation", version: "^1" }],
  });
  const lockPath = join(settings, "lock.json");
  writeFileSync(lockPath, JSON.stringify(sel.lock));
  return { home, dataDir: tmp("mimir-bv-data-"), settings, lockPath };
}

function input(
  wt: { path: string; head: string; base: string },
  e: Env,
  extra: Partial<BrokkrVerifyInput> = {},
): BrokkrVerifyInput {
  return {
    taskId: TASK,
    missionId: MISSION,
    worktreePath: wt.path,
    baseRef: wt.base,
    headSha: wt.head,
    taskTitle: "Write the docs",
    verifierConfig: { harnesses: ["documentation@^1"], lockPath: e.lockPath },
    signal: new AbortController().signal,
    ...extra,
  };
}

const realSdk = sdk as unknown as BrokkrSdk;
const verifier = (e: Env, executor?: unknown) =>
  new BrokkrVerifier({
    sdk: realSdk,
    homeDir: e.home,
    dataDir: e.dataDir,
    ...(executor ? { executor } : {}),
  });
const passing = () => new MockExecutor({ "docs-links": "passed", "docs-examples": "passed" });

/** Every path under `root` except `.git`, with a content hash for files. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (dir === root && name === ".git") continue;
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = p.slice(root.length + 1);
      if (st.isDirectory()) {
        out[rel] = "dir";
        walk(p);
      } else {
        out[rel] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

describe("parseHarnessRef and settings", () => {
  it.each([
    ["documentation@^1", { name: "documentation", version: "^1" }],
    ["backend-node@1.0.0", { name: "backend-node", version: "1.0.0" }],
    ["documentation", { name: "documentation", version: "*" }],
  ])("%s", (ref, expected) => {
    expect(parseHarnessRef(ref)).toEqual(expected);
  });

  it.each(["", "@1", "docs@", "a b@1"])("rejects %j", (ref) => {
    expect(() => parseHarnessRef(ref)).toThrow(MimirError);
  });

  it("requires harnesses and an absolute lock path (policy optional); no other keys", () => {
    const ok = { harnesses: ["documentation"], lockPath: "/x/lock.json" };
    expect(VerificationSettingsSchema.safeParse(ok).success).toBe(true);
    expect(
      VerificationSettingsSchema.safeParse({ ...ok, policyPath: "/x/policy.yaml" }).success,
    ).toBe(true);
    expect(VerificationSettingsSchema.safeParse({ harnesses: ["documentation"] }).success).toBe(
      false,
    );
    expect(VerificationSettingsSchema.safeParse({ ...ok, harnesses: [] }).success).toBe(false);
    expect(VerificationSettingsSchema.safeParse({ ...ok, lockPath: "rel/lock.json" }).success).toBe(
      false,
    );
    expect(VerificationSettingsSchema.safeParse({ ...ok, verdict: "passed" }).success).toBe(false);
  });
});

describe("loadBrokkrSdk", () => {
  it("loads the vendored @brokkr/sdk", async () => {
    const loaded = await loadBrokkrSdk();
    expect(loaded?.Brokkr).toBeTypeOf("function");
  });

  it("returns null when the SDK cannot be imported", async () => {
    const loaded = await loadBrokkrSdk(() => Promise.reject(new Error("Cannot find package")));
    expect(loaded).toBeNull();
  });
});

describe("BrokkrVerifier", () => {
  it("passes on a passed verdict bound to the task and the head commit", async () => {
    const wt = worktree();
    const e = await env(wt);
    const r = await verifier(e, passing()).verify(input(wt, e));
    expect(r.source).toBe("brokkr");
    expect(r.passed).toBe(true);
    const report = r.report as sdk.VerificationReport;
    expect(report.verdict).toBe("passed");
    expect(report.taskId).toBe(TASK);
    expect(report.repository.commitSha).toBe(wt.head);
    expect(r.binding).toEqual({
      taskId: TASK,
      missionId: MISSION,
      worktreePath: wt.path,
      baseRef: wt.base,
      headSha: wt.head,
    });
    expect(r.checks.map((c) => [c.name, c.passed])).toEqual([
      ["docs-links", true],
      ["docs-examples", true],
    ]);
  });

  it("writes nothing inside the worktree; run evidence goes to Mimir's data dir", async () => {
    const wt = worktree();
    const e = await env(wt);
    const before = snapshot(wt.path);
    const r = await verifier(e, passing()).verify(input(wt, e));
    expect(r.passed).toBe(true);
    expect(snapshot(wt.path)).toEqual(before);
    expect(existsSync(join(wt.path, ".brokkr"))).toBe(false);
    const runs = join(e.dataDir, "brokkr", "runs");
    expect(readdirSync(runs).length).toBeGreaterThan(0);
    // the evidence signing key is Mimir's own, under its data dir, mode 0600
    const key = join(e.dataDir, "brokkr", "signing.key");
    expect(statSync(key).mode & 0o777).toBe(0o600);
    expect(existsSync(join(e.home, ".brokkr", "key"))).toBe(false);
  });

  it("fails when Brokkr's verdict is failed", async () => {
    const wt = worktree();
    const e = await env(wt);
    const r = await verifier(
      e,
      new MockExecutor({ "docs-links": "passed", "docs-examples": "failed" }),
    ).verify(input(wt, e));
    expect(r.passed).toBe(false);
    expect((r.report as sdk.VerificationReport).verdict).toBe("failed");
    expect(r.checks.find((c) => c.name === "docs-examples")?.passed).toBe(false);
  });

  it("the worktree's own .brokkr cannot alter the verdict", async () => {
    const wt = worktree();
    const e = await env(wt);
    mkdirSync(join(wt.path, ".brokkr"), { recursive: true });
    writeFileSync(join(wt.path, ".brokkr", "config.yaml"), "harnesses: []\n");
    writeFileSync(
      join(wt.path, ".brokkr", "exceptions.yaml"),
      [
        "exceptions:",
        "  - id: exc-1",
        "    checkId: docs-examples",
        "    reason: trust me",
        "    approvedBy: mimir",
        "    expiresAt: 2099-01-01T00:00:00Z",
        "",
      ].join("\n"),
    );
    writeFileSync(join(wt.path, ".brokkr", "policy.yaml"), "requiredCheckIds: []\n");
    const r = await verifier(
      e,
      new MockExecutor({ "docs-links": "passed", "docs-examples": "failed" }),
    ).verify(input(wt, e));
    expect((r.report as sdk.VerificationReport).verdict).toBe("failed");
    expect(r.passed).toBe(false);
  });

  it("fails a passed verdict whose commit is not the observed head, or when the head is unknown", async () => {
    const wt = worktree();
    const e = await env(wt);
    const wrong = await verifier(e, passing()).verify(input(wt, e, { headSha: wt.base }));
    expect((wrong.report as sdk.VerificationReport).verdict).toBe("passed");
    expect(wrong.passed).toBe(false);
    expect(wrong.checks.at(-1)).toMatchObject({ name: "mimir.binding", passed: false });
    const unknown = await verifier(e, passing()).verify(input(wt, e, { headSha: null }));
    expect(unknown.passed).toBe(false);
  });

  it("runs workspace-untrusted with the project's contract, Mimir's run root and key, no approvers", async () => {
    const wt = worktree();
    const e = await env(wt);
    const seen: Record<string, unknown>[] = [];
    class SpyBrokkr extends sdk.Brokkr {
      constructor(options: sdk.BrokkrOptions) {
        super(options);
        seen.push(options as unknown as Record<string, unknown>);
      }
    }
    writeFileSync(join(e.settings, "policy.yaml"), "network: deny\n");
    const v = new BrokkrVerifier({
      sdk: { ...realSdk, Brokkr: SpyBrokkr as unknown as BrokkrSdk["Brokkr"] },
      homeDir: e.home,
      dataDir: e.dataDir,
      executor: passing(),
    });
    const r = await v.verify(
      input(wt, e, {
        verifierConfig: {
          harnesses: ["documentation@^1"],
          lockPath: e.lockPath,
          policyPath: join(e.settings, "policy.yaml"),
        },
      }),
    );
    expect(r.passed).toBe(true);
    const lock = JSON.parse(readFileSync(e.lockPath, "utf8")) as unknown;
    expect(seen[0]).toMatchObject({
      trust: "workspace-untrusted",
      harnesses: [{ name: "documentation", version: "^1" }],
      lock,
      policy: { network: "deny" },
      homeDir: e.home,
      runRoot: join(e.dataDir, "brokkr", "runs"),
      approvers: [],
      exceptions: [],
    });
    expect(Buffer.isBuffer(seen[0]?.["signingKey"])).toBe(true);
  });

  it("reuses the signing key across verifications", async () => {
    const wt = worktree();
    const e = await env(wt);
    await verifier(e, passing()).verify(input(wt, e));
    const key = readFileSync(join(e.dataDir, "brokkr", "signing.key"));
    await verifier(e, passing()).verify(input(wt, e));
    expect(readFileSync(join(e.dataDir, "brokkr", "signing.key"))).toEqual(key);
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it("blocks when the pinned lock does not match (verdict decides, no override)", async () => {
    const wt = worktree();
    const e = await env(wt);
    // a lock pinned to other content (Brokkr compares the pinned lock's digest)
    const lock = JSON.parse(readFileSync(e.lockPath, "utf8")) as Record<string, unknown>;
    writeFileSync(e.lockPath, JSON.stringify({ ...lock, digest: `sha256:${"0".repeat(64)}` }));
    const r = await verifier(e, passing()).verify(input(wt, e));
    expect(r.passed).toBe(false);
    expect((r.report as sdk.VerificationReport).verdict).not.toBe("passed");
  });

  it("refuses verification settings read from inside the worktree", async () => {
    const wt = worktree();
    const e = await env(wt);
    writeFileSync(join(wt.path, "lock.json"), readFileSync(e.lockPath));
    const err = await verifier(e, passing())
      .verify(
        input(wt, e, {
          verifierConfig: { harnesses: ["documentation"], lockPath: join(wt.path, "lock.json") },
        }),
      )
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(MimirError);
    expect(err).toMatchObject({ code: "validation_failed", details: { reason: "in_worktree" } });
  });

  it("refuses missing or malformed settings instead of passing", async () => {
    const wt = worktree();
    const e = await env(wt);
    for (const verifierConfig of [
      undefined,
      { harnesses: ["documentation"] },
      { harnesses: [], lockPath: e.lockPath },
      { harnesses: ["x"], lockPath: e.lockPath, extra: 1 },
    ]) {
      const err = await verifier(e, passing())
        .verify(input(wt, e, { verifierConfig }))
        .catch((x: unknown) => x);
      expect(err, JSON.stringify(verifierConfig)).toMatchObject({ code: "validation_failed" });
    }
  });

  it("runs real checks with Brokkr's LocalProcessExecutor", async () => {
    const wt = worktree();
    const e = await env(wt);
    const r = await verifier(e).verify(input(wt, e));
    const report = r.report as sdk.VerificationReport;
    expect(report.verdict, JSON.stringify(report.reasons)).toBe("passed");
    expect(r.passed).toBe(true);
  }, 120_000);
});
