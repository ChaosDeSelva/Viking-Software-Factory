import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokkrVerifier } from "@mimir/brokkr-verifier";
import { afterEach, describe, expect, it } from "vitest";
import { RoutingVerifier, selectVerifier } from "./verifier-select.js";
import type { VerificationResult, Verifier, VerifyInput } from "./verifier.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "mimir-vsel-")));
  dirs.push(d);
  return d;
};

function recordingLog() {
  const lines: { level: string; msg: string }[] = [];
  const at = (level: string) => (_obj: object, msg?: string) =>
    lines.push({ level, msg: msg ?? "" });
  return { lines, log: { info: at("info"), warn: at("warn") } };
}

const input = (extra: Partial<VerifyInput> = {}): VerifyInput => ({
  taskId: "tsk_01J0000000000000000000000A",
  missionId: "msn_01J0000000000000000000000B",
  worktreePath: tmp(),
  baseRef: "a".repeat(40),
  headSha: null,
  testCommand: ["true"],
  signal: new AbortController().signal,
  ...extra,
});

class Named implements Verifier {
  calls = 0;
  constructor(readonly source: VerificationResult["source"]) {}
  verify(): Promise<VerificationResult> {
    this.calls++;
    return Promise.resolve({ source: this.source, passed: true, checks: [] });
  }
}

describe("selectVerifier", () => {
  it("logs `verifier: brokkr unavailable` and uses TestCommandVerifier when @brokkr/sdk is missing", async () => {
    const { lines, log } = recordingLog();
    const v = await selectVerifier({ log, dataDir: tmp(), load: () => Promise.resolve(null) });
    expect(lines).toContainEqual({ level: "warn", msg: "verifier: brokkr unavailable" });
    await expect(
      v.verify(
        input({ verifierConfig: { harnesses: ["documentation"], lockPath: "/nonexistent" } }),
      ),
    ).rejects.toThrow(/unavailable/);
    expect((await v.verify(input())).passed).toBe(true);
  });

  it("uses Brokkr when the vendored @brokkr/sdk loads", async () => {
    const { lines, log } = recordingLog();
    const v = await selectVerifier({ log, dataDir: tmp(), brokkr: { homeDir: tmp() } });
    expect(lines).toContainEqual({ level: "info", msg: "verifier: brokkr" });
    expect(v).toBeInstanceOf(RoutingVerifier);
    expect((v as RoutingVerifier).brokkr).toBeInstanceOf(BrokkrVerifier);
  });
});

describe("RoutingVerifier", () => {
  it("routes projects with settings.verification to Brokkr and the rest to the test command", async () => {
    const brokkr = new Named("brokkr");
    const fallback = new Named("test-command");
    const v = new RoutingVerifier(brokkr, fallback);
    expect((await v.verify(input({ verifierConfig: { harnesses: ["x"] } }))).source).toBe("brokkr");
    expect((await v.verify(input())).source).toBe("test-command");
    expect([brokkr.calls, fallback.calls]).toEqual([1, 1]);
  });
});
