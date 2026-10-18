import { describe, expect, it } from "vitest";
import { BrokkrError, EXIT_CODES, isExitCode } from "./index.js";

describe("exit codes (spec §11.3 public contract)", () => {
  it("has the exact contract values", () => {
    expect(EXIT_CODES).toEqual({
      ok: 0,
      verificationFailed: 1,
      invalidConfig: 2,
      infraError: 3,
      policyDenied: 4,
      interrupted: 130,
    });
  });

  it("recognises only contract codes", () => {
    for (const code of [0, 1, 2, 3, 4, 130]) expect(isExitCode(code)).toBe(true);
    for (const code of [5, -1, 127, 255]) expect(isExitCode(code)).toBe(false);
  });

  it("BrokkrError carries a code and the matching exit code", () => {
    const error = new BrokkrError("invalid-config", "bad", { details: { file: "x" } });
    expect(error.code).toBe("invalid-config");
    expect(error.exitCode).toBe(2);
    expect(new BrokkrError("policy-denied", "no").exitCode).toBe(4);
    expect(new BrokkrError("trust_required", "no").exitCode).toBe(4);
    expect(new BrokkrError("infra", "boom").exitCode).toBe(3);
    expect(new BrokkrError("verification-failed", "x").exitCode).toBe(1);
    expect(new BrokkrError("interrupted", "x").exitCode).toBe(130);
    expect(error.details).toEqual({ file: "x" });
  });
});
