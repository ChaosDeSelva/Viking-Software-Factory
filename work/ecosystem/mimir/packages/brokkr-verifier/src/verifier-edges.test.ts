import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MimirError } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrokkrVerifier,
  loadBrokkrSdk,
  readSettingsFile,
  signingKeyAt,
  type BrokkrReport,
  type BrokkrSdk,
  type BrokkrVerifyInput,
} from "./index.js";

const dirs: string[] = [];
const tmp = (prefix = "mimir-bv-edge-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TASK = "tsk_01J0000000000000000000000A";
const HEAD = "a".repeat(40);

/** A stand-in SDK that records what it is given and returns `report` from verify. */
function fakeSdk(report: unknown, valid = true) {
  const seen: { options?: Record<string, unknown>; verify?: Record<string, unknown> } = {};
  const sdk: BrokkrSdk = {
    Brokkr: class {
      constructor(options: unknown) {
        seen.options = options as Record<string, unknown>;
      }
      resolve() {
        return Promise.resolve({ selection: true });
      }
      verify(input: unknown) {
        seen.verify = input as Record<string, unknown>;
        return Promise.resolve(report);
      }
    } as unknown as BrokkrSdk["Brokkr"],
    VerificationReportSchema: { safeParse: () => ({ success: valid }) },
  };
  return { sdk, seen };
}

const report = (over: Partial<BrokkrReport> = {}): BrokkrReport => ({
  id: "rep_1",
  taskId: TASK,
  verdict: "passed",
  repository: { commitSha: HEAD },
  reasons: [],
  checks: [],
  ...over,
});

function input(wt: string, extra: Partial<BrokkrVerifyInput> = {}): BrokkrVerifyInput {
  return {
    taskId: TASK,
    missionId: "msn_1",
    worktreePath: wt,
    baseRef: "main",
    headSha: HEAD,
    verifierConfig: { harnesses: ["documentation"], lock: { pinned: true } },
    signal: new AbortController().signal,
    ...extra,
  };
}

describe("BrokkrVerifier with a stand-in SDK", () => {
  it("accepts an inline lock, titles the task by its id and passes no env by default", async () => {
    const { sdk, seen } = fakeSdk(report());
    const wt = tmp();
    const r = await new BrokkrVerifier({ sdk, dataDir: tmp() }).verify(input(wt));
    expect(r.passed).toBe(true);
    expect(seen.options?.["lock"]).toEqual({ pinned: true });
    expect(seen.options).not.toHaveProperty("policy");
    expect(seen.options).not.toHaveProperty("homeDir");
    expect(seen.verify?.["task"]).toMatchObject({ id: TASK, title: TASK });
    expect(seen.verify).not.toHaveProperty("env");
  });

  it("passes the base commit as baseCommit only when it is a full commit id", async () => {
    for (const base of ["b".repeat(40), "c".repeat(64)]) {
      const { sdk, seen } = fakeSdk(report());
      await new BrokkrVerifier({ sdk, dataDir: tmp() }).verify(input(tmp(), { baseRef: base }));
      expect(seen.verify?.["baseCommit"]).toBe(base);
    }
    for (const base of ["main", "HEAD~1", "b".repeat(12), "B".repeat(40), "b".repeat(41), ""]) {
      const { sdk, seen } = fakeSdk(report());
      await new BrokkrVerifier({ sdk, dataDir: tmp() }).verify(input(tmp(), { baseRef: base }));
      expect(seen.verify).not.toHaveProperty("baseCommit");
    }
  });

  it("passes builtinDir through", async () => {
    const { sdk, seen } = fakeSdk(report());
    await new BrokkrVerifier({ sdk, dataDir: tmp(), builtinDir: "/b" }).verify(input(tmp()));
    expect(seen.options?.["builtinDir"]).toBe("/b");
  });

  it("refuses to start when the signal is already aborted", async () => {
    const { sdk, seen } = fakeSdk(report());
    const ac = new AbortController();
    ac.abort();
    const e = await new BrokkrVerifier({ sdk, dataDir: tmp() })
      .verify(input(tmp(), { signal: ac.signal }))
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "conflict" });
    expect(seen.options).toBeUndefined();
  });

  it("refuses a report that does not match Brokkr's schema, whatever its verdict", async () => {
    const { sdk } = fakeSdk(report(), false);
    const e = await new BrokkrVerifier({ sdk, dataDir: tmp() })
      .verify(input(tmp()))
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MimirError);
    expect(e).toMatchObject({ code: "internal" });
  });

  it("fails a passed report that names no task, and describes each check", async () => {
    const unbound: Partial<BrokkrReport> = report({
      checks: [
        { id: "a", required: true, state: "passed" },
        {
          id: "b",
          required: true,
          state: "timed_out",
          command: ["npm", "test"],
          exitCode: null,
          durationMs: 7,
          reason: "slow",
          log: "/runs/b.log",
        },
        { id: "c", required: false, state: "skipped" },
      ],
    });
    delete unbound.taskId;
    const { sdk } = fakeSdk(unbound);
    const r = await new BrokkrVerifier({ sdk, dataDir: tmp() }).verify(
      input(tmp(), { headSha: null }),
    );
    expect(r.passed).toBe(false);
    expect(r.checks).toEqual([
      {
        name: "a",
        command: [],
        passed: true,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        output: "passed",
      },
      {
        name: "b",
        command: ["npm", "test"],
        passed: false,
        exitCode: null,
        durationMs: 7,
        timedOut: true,
        output: "timed_out (slow; log: /runs/b.log)",
      },
      expect.objectContaining({
        name: "mimir.binding",
        passed: false,
        output: `report is for task (none) at ${HEAD}; expected task ${TASK} at (head not observed)`,
      }),
    ]);
  });
});

describe("signingKeyAt", () => {
  it("tightens a key file readable by others and keeps it", () => {
    const dir = tmp();
    const key = Buffer.alloc(32, 7);
    writeFileSync(join(dir, "signing.key"), key, { mode: 0o644 });
    chmodSync(join(dir, "signing.key"), 0o644);
    expect(signingKeyAt(dir)).toEqual(key);
    expect(statSync(join(dir, "signing.key")).mode & 0o777).toBe(0o600);
  });

  it("replaces a key that is too short", () => {
    const dir = tmp();
    writeFileSync(join(dir, "signing.key"), "short", { mode: 0o600 });
    const key = signingKeyAt(dir);
    expect(key.length).toBe(32);
    expect(readFileSync(join(dir, "signing.key"))).toEqual(key);
  });

  it("refuses a symlink or directory in place of the key", () => {
    const dir = tmp();
    const target = join(tmp(), "elsewhere");
    writeFileSync(target, Buffer.alloc(32, 1));
    symlinkSync(target, join(dir, "signing.key"));
    expect(() => signingKeyAt(dir)).toThrow(/not a regular file/);
    const other = tmp();
    mkdirSync(join(other, "signing.key"));
    expect(() => signingKeyAt(other)).toThrow(MimirError);
  });

  it("rethrows filesystem errors other than a missing key", () => {
    const dir = tmp();
    writeFileSync(join(dir, "signing.key"), Buffer.alloc(32, 1), { mode: 0o600 });
    chmodSync(join(dir, "signing.key"), 0o000);
    try {
      expect(() => signingKeyAt(dir)).toThrow(expect.objectContaining({ code: "EACCES" }));
    } finally {
      chmodSync(join(dir, "signing.key"), 0o600);
    }
  });
});

describe("readSettingsFile", () => {
  it("reads YAML from outside the worktree", () => {
    const dir = tmp();
    writeFileSync(join(dir, "policy.yaml"), "network: deny\n");
    expect(readSettingsFile(join(dir, "policy.yaml"), tmp(), "policy")).toEqual({
      network: "deny",
    });
  });

  it("refuses a missing file and an unparseable one", () => {
    const dir = tmp();
    const wt = tmp();
    expect(() => readSettingsFile(join(dir, "nope.json"), wt, "lock")).toThrow(
      expect.objectContaining({ details: { reason: "unreadable", path: join(dir, "nope.json") } }),
    );
    writeFileSync(join(dir, "bad.yaml"), "a: [1\n");
    expect(() => readSettingsFile(join(dir, "bad.yaml"), wt, "lock")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "unparseable" }) }),
    );
  });

  it("refuses a file outside the worktree that is a symlink into it", () => {
    const dir = tmp();
    const wt = tmp();
    writeFileSync(join(wt, "lock.json"), "{}");
    symlinkSync(join(wt, "lock.json"), join(dir, "lock.json"));
    expect(() => readSettingsFile(join(dir, "lock.json"), wt, "lock")).toThrow(
      expect.objectContaining({ details: expect.objectContaining({ reason: "in_worktree" }) }),
    );
  });
});

describe("loadBrokkrSdk", () => {
  it("returns null for a module that lacks what Mimir needs", async () => {
    expect(await loadBrokkrSdk(() => Promise.resolve({ Brokkr: () => 0 }))).toBeNull();
    expect(await loadBrokkrSdk(() => Promise.resolve(null))).toBeNull();
  });
});
