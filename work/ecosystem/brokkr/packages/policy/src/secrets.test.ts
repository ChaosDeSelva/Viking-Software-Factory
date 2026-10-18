import { describe, expect, it } from "vitest";
import { createLineRedactor, redactText, scanFiles, scanText } from "./index.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Built by concatenation so this source file itself does not contain a literal secret.
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const GH = "ghp_" + "a".repeat(36);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----";
const ANTHROPIC = "sk-ant-" + "api03-" + "x".repeat(40);
const SLACK = "xoxb-" + "1234567890-abcdefghij";
const GENERIC = "api_key" + "=" + "Zx9".repeat(8);

describe("secret scanning", () => {
  it("detects common credential formats", () => {
    for (const secret of [AWS, GH, PEM, ANTHROPIC, SLACK, GENERIC]) {
      expect(scanText(`prefix ${secret} suffix`).length, secret.slice(0, 8)).toBeGreaterThan(0);
    }
  });

  it("ignores ordinary output", () => {
    expect(scanText("Tests 84 passed (84)\nDuration 1.2s\nsha256:abcdef")).toEqual([]);
  });

  it("redacts and counts", () => {
    const { text, findings } = redactText(`key ${AWS} and ${GH}`);
    expect(findings).toBe(2);
    expect(text).not.toContain(AWS);
    expect(text).not.toContain(GH);
    expect(text).toContain("[REDACTED:aws-access-key]");
  });

  it("redacts known secret values passed explicitly", () => {
    const { text, findings } = redactText("the value is hunter2-long-password", [
      "hunter2-long-password",
    ]);
    expect(findings).toBe(1);
    expect(text).toBe("the value is [REDACTED:env-value]");
  });

  it("line redactor never emits a secret split across chunks", () => {
    const r = createLineRedactor();
    let out = r.write(`line one\nsecret ${AWS.slice(0, 6)}`);
    out += r.write(`${AWS.slice(6)} end\nlast`);
    out += r.flush();
    expect(out).not.toContain(AWS);
    expect(out).toContain("line one\n");
    expect(out).toContain("last");
    expect(r.findings).toBe(1);
  });

  it("line redactor flushes very long lines without newline in bounded chunks", () => {
    const r = createLineRedactor({ maxLineBytes: 16 });
    const out = r.write("x".repeat(40));
    expect(out.length).toBeGreaterThanOrEqual(32);
    expect(out + r.flush()).toBe("x".repeat(40));
  });

  it("scanFiles reports findings per file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brokkr-secrets-"));
    writeFileSync(join(dir, "a.md"), `token ${GH}\n`);
    writeFileSync(join(dir, "b.md"), "clean\n");
    const found = await scanFiles([join(dir, "a.md"), join(dir, "b.md"), join(dir, "missing")]);
    expect(found).toEqual([{ file: join(dir, "a.md"), findings: 1 }]);
  });
});
