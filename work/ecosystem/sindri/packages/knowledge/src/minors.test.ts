import { describe, expect, it } from "vitest";
import { isSecretPath } from "./bootstrap.js";
import { openKnowledge } from "./knowledge.js";
import { SourceRefSchema } from "./types.js";

describe("fix round 1 minors", () => {
  it("M3: treats more credential files as secrets", () => {
    for (const p of [
      "id_ed25519",
      "keys/id_ecdsa.pub",
      "id_dsa",
      "cert.pfx",
      "app.jks",
      "release.keystore",
      ".npmrc",
      "home/.netrc",
      ".pgpass",
      "gcp/service-account-prod.json",
    ]) {
      expect(isSecretPath(p), p).toBe(true);
    }
    expect(isSecretPath("docs/guide.md")).toBe(false);
  });

  it("M7: purgeRetracted validates olderThanDays", () => {
    const k = openKnowledge(":memory:");
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(() => k.knowledge.purgeRetracted({ olderThanDays: bad })).toThrow(/olderThanDays/);
    }
    expect(k.knowledge.purgeRetracted({ olderThanDays: 0 })).toBe(0);
    k.close();
  });

  it("M8: url source refs must be http(s)", () => {
    expect(SourceRefSchema.safeParse({ url: "https://example.com" }).success).toBe(true);
    expect(SourceRefSchema.safeParse({ url: "http://example.com" }).success).toBe(true);
    expect(SourceRefSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(false);
    expect(SourceRefSchema.safeParse({ url: "file:///etc/passwd" }).success).toBe(false);
  });
});
