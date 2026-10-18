import { describe, expect, it } from "vitest";
import { createLock, lockContentDigest } from "./lock.js";

const set = { harnesses: [], skills: {} };
const profile = { name: "strict-x", digest: `sha256:${"d".repeat(64)}` };

describe("lock profile pin (B3b fix round 2, N1)", () => {
  it("is recorded and covered by the content digest", () => {
    const plain = createLock(set, []);
    const pinned = createLock(set, [], new Date(), profile);
    expect(pinned.profile).toEqual(profile);
    expect(pinned.digest).toBe(lockContentDigest(pinned));
    expect(pinned.digest).not.toBe(plain.digest);
    const other = createLock(set, [], new Date(), {
      ...profile,
      digest: `sha256:${"e".repeat(64)}`,
    });
    expect(other.digest).not.toBe(pinned.digest);
  });

  it("leaves profile-less lock digests unchanged", () => {
    const plain = createLock(set, []);
    expect(plain.profile).toBeUndefined();
    expect(lockContentDigest({ ...plain })).toBe(plain.digest);
  });
});
