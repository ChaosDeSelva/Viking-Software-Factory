import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets, SECRET_REDACTED } from "./secrets.js";

const ANT = "sk-ant-api03-" + "Q1w2E3r4T5y6U7i8O9p0".repeat(4);
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA1b2c3d4e5f6g7h8i9j0",
  "k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

describe("redactSecrets (ticket text before prompts)", () => {
  it("replaces whole secret tokens, PEM blocks and generic assignments, and counts them", () => {
    const text = `Key: ${ANT} please\n${PEM}\npassword = "Hunter2Hunter2Hunter2"\nplain line`;
    const out = redactSecrets(text);
    expect(out.count).toBe(3);
    expect(out.text).toBe(
      `Key: ${SECRET_REDACTED} please\n${SECRET_REDACTED}\npassword = "${SECRET_REDACTED}"\nplain line`,
    );
    expect(containsSecret(out.text)).toBe(false);
  });

  it("redacts every pattern the scanner knows, case-insensitive ones included", () => {
    const out = redactSecrets("db: POSTGRES://admin:Sup3rS3cretPw@db.internal:5432/app");
    expect(out.count).toBe(1);
    expect(out.text).not.toContain("Sup3rS3cretPw");
    expect(containsSecret(out.text)).toBe(false);
  });

  it.each([
    ["zero-width space", "ghp_\u200B" + "a1B2c3D4e5".repeat(4)],
    ["fullwidth", "ｇｈｐ＿" + "a1B2c3D4e5".repeat(4)],
    ["upper-cased", "GHP_" + "A1B2C3D4E5".repeat(4)],
    ["bearer header", "Authorization: Bearer " + "a1B2c3D4e5".repeat(4)],
  ])("redacts an obfuscated token (%s) (review m5)", (_l, token) => {
    const out = redactSecrets(`use ${token} please`);
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.text).toContain(SECRET_REDACTED);
    expect(out.text).not.toMatch(/a1B2c3D4e5|A1B2C3D4E5/);
  });

  it("leaves ordinary text alone", () => {
    const text = "Add a CSV export to the reports page.\nTokens are rotated monthly.";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it("redacts an unterminated PEM block to the end of the text", () => {
    const out = redactSecrets(`intro\n${PEM.split("\n").slice(0, 2).join("\n")}`);
    expect(out).toEqual({ text: `intro\n${SECRET_REDACTED}`, count: 1 });
  });

  it("is linear on adversarial input", () => {
    const t0 = performance.now();
    redactSecrets("password=".repeat(20000) + "sk-ant-".repeat(20000));
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
