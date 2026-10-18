import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeCommand, findApproval, loadExceptionsFile, loadPolicyFile } from "./index.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "brokkr-loaders-"));
const NOW = new Date("2026-10-14T13:00:00Z");

describe("explicit policy and exceptions files", () => {
  it("loadPolicyFile reads a policy layer and rejects missing or invalid files", async () => {
    const d = dir();
    writeFileSync(join(d, "p.yaml"), "requiredCheckIds: [unit]\n");
    expect(await loadPolicyFile(join(d, "p.yaml"))).toEqual({ requiredCheckIds: ["unit"] });
    await expect(loadPolicyFile(join(d, "missing.yaml"))).rejects.toMatchObject({
      code: "invalid-config",
    });
    writeFileSync(join(d, "bad.yaml"), "network: sometimes\n");
    await expect(loadPolicyFile(join(d, "bad.yaml"))).rejects.toMatchObject({
      code: "invalid-config",
    });
  });

  it("loadExceptionsFile reads exceptions and rejects missing files", async () => {
    const d = dir();
    writeFileSync(
      join(d, "e.yaml"),
      "exceptions:\n  - id: e1\n    policy: check:unit\n    scope: {}\n    reason: r\n    approvedBy: lead\n    approvedAt: 2026-10-14T12:00:00Z\n    expiresAt: 2026-10-15T12:00:00Z\n    evidence: []\n",
    );
    const loaded = await loadExceptionsFile(join(d, "e.yaml"));
    expect(loaded.map((e) => e.id)).toEqual(["e1"]);
    expect(findApproval(loaded, "check:unit", { harnesses: [], now: NOW })?.id).toBe("e1");
    expect(
      findApproval(loaded, "install-dependencies", { harnesses: [], now: NOW }),
    ).toBeUndefined();
    await expect(loadExceptionsFile(join(d, "missing.yaml"))).rejects.toMatchObject({
      code: "invalid-config",
    });
  });
});

describe("classifier branches", () => {
  it("python modules and scripts end the option scan", () => {
    expect(analyzeCommand(["python3", "-m", "pytest", "-c", "x"]).destructive).toBeUndefined();
    expect(analyzeCommand(["python3", "-u", "run.py", "-c", "x"]).destructive).toBeUndefined();
    expect(analyzeCommand(["python3", "-u"]).destructive).toBeUndefined();
  });
  it("sed script files and --expression=", () => {
    expect(analyzeCommand(["sed", "-f", "script.sed", "f"]).destructive).toBeUndefined();
    expect(analyzeCommand(["sed", "--expression=1e id", "f"]).destructive).toBe("inline_code");
    expect(analyzeCommand(["sed", "--expression=s/a/b/", "f"]).destructive).toBeUndefined();
  });
  it("interpreters without inline code", () => {
    expect(analyzeCommand(["perl", "script.pl"]).destructive).toBeUndefined();
    expect(analyzeCommand(["ruby", "x.rb", "-e"]).destructive).toBeUndefined();
    expect(analyzeCommand(["php", "x.php"]).destructive).toBeUndefined();
    expect(analyzeCommand(["node"]).destructive).toBeUndefined();
    expect(analyzeCommand(["node", "--import"]).destructive).toBeUndefined();
    expect(analyzeCommand(["deno", "run", "x.ts"]).destructive).toBeUndefined();
    expect(analyzeCommand(["git", "-c"]).destructive).toBeUndefined();
  });
});
