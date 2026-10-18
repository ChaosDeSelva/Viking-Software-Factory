import { existsSync } from "node:fs";
import {
  canonicalJson,
  sha256Digest,
  treeDigest,
  type HarnessLock,
  type LoadedHarness,
  type ResolvedHarnessSet,
} from "@brokkr/core";

export interface AdapterRef {
  id: string;
  version: string;
}

export type LockEntryStatus = "ok" | "modified" | "missing";

export interface LockVerificationEntry {
  kind: "lock" | "harness" | "skill";
  name: string;
  version?: string;
  status: LockEntryStatus;
  expected?: string;
  actual?: string;
}

export interface LockVerification {
  ok: boolean;
  entries: LockVerificationEntry[];
}

const byKey = <T extends { name?: string; id?: string }>(a: T, b: T): number => {
  const ka = a.name ?? a.id ?? "";
  const kb = b.name ?? b.id ?? "";
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/**
 * Content digest of a lock: covers harnesses, skills, adapters and, when
 * present, the pinned profile, but not `generatedAt`. Locks without a profile
 * keep the digest they always had.
 */
export function lockContentDigest(
  lock: Pick<HarnessLock, "lockVersion" | "harnesses" | "skills" | "adapters" | "profile">,
): string {
  return sha256Digest(
    canonicalJson({
      lockVersion: lock.lockVersion,
      harnesses: lock.harnesses,
      skills: lock.skills,
      adapters: lock.adapters,
      ...(lock.profile !== undefined ? { profile: lock.profile } : {}),
    }),
  );
}

export function createLock(
  set: ResolvedHarnessSet,
  adapters: readonly AdapterRef[],
  now: Date = new Date(),
  profile?: { name: string; digest: string },
): HarnessLock {
  const body = {
    lockVersion: 2 as const,
    harnesses: set.harnesses
      .map((h) => ({
        name: h.manifest.metadata.name,
        version: h.manifest.metadata.version,
        digest: h.digest,
        source: h.sourceRef,
      }))
      .sort(byKey),
    skills: Object.values(set.skills)
      .map((s) => ({
        name: s.manifest.metadata.name,
        version: s.manifest.metadata.version,
        digest: s.digest,
      }))
      .sort(byKey),
    adapters: adapters.map((a) => ({ id: a.id, version: a.version })).sort(byKey),
    ...(profile !== undefined ? { profile: { name: profile.name, digest: profile.digest } } : {}),
  };
  return { ...body, generatedAt: now.toISOString(), digest: lockContentDigest(body) };
}

/** Recompute every digest from disk and compare with the lock. */
export async function verifyLockAgainst(
  lock: HarnessLock,
  available: readonly LoadedHarness[],
): Promise<LockVerification> {
  const entries: LockVerificationEntry[] = [];
  const recomputed = lockContentDigest(lock);
  if (recomputed !== lock.digest) {
    entries.push({
      kind: "lock",
      name: "harness.lock.json",
      status: "modified",
      expected: lock.digest,
      actual: recomputed,
    });
  }

  const lockedHarnesses: LoadedHarness[] = [];
  for (const locked of lock.harnesses) {
    const matches = available.filter(
      (h) =>
        h.manifest.metadata.name === locked.name && h.manifest.metadata.version === locked.version,
    );
    const found = matches.find((h) => h.sourceRef === locked.source) ?? matches[0];
    if (!found || !existsSync(found.dir)) {
      entries.push({
        kind: "harness",
        name: locked.name,
        version: locked.version,
        status: "missing",
        expected: locked.digest,
      });
      continue;
    }
    lockedHarnesses.push(found);
    const actual = await safeTreeDigest(found.dir);
    entries.push(compare("harness", locked, actual));
  }

  for (const locked of lock.skills) {
    const skill = lockedHarnesses
      .flatMap((h) => h.skills)
      .find(
        (s) =>
          s.manifest.metadata.name === locked.name &&
          s.manifest.metadata.version === locked.version,
      );
    if (!skill || !existsSync(skill.dir)) {
      entries.push({
        kind: "skill",
        name: locked.name,
        version: locked.version,
        status: "missing",
        expected: locked.digest,
      });
      continue;
    }
    entries.push(compare("skill", locked, await safeTreeDigest(skill.dir)));
  }
  return { ok: entries.every((e) => e.status === "ok"), entries };
}

function compare(
  kind: "harness" | "skill",
  locked: { name: string; version: string; digest: string },
  actual: string,
): LockVerificationEntry {
  return {
    kind,
    name: locked.name,
    version: locked.version,
    status: actual === locked.digest ? "ok" : "modified",
    expected: locked.digest,
    actual,
  };
}

async function safeTreeDigest(dir: string): Promise<string> {
  try {
    return await treeDigest(dir);
  } catch (error) {
    return `error:${(error as Error).message}`;
  }
}
