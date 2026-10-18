import { MimirError } from "@mimir/protocol";

export interface ProtectedBranchRules {
  /** Branch names; a trailing `*` matches any suffix (e.g. `release/*`). */
  protected: string[];
}

export interface ProtectedBranchGuard {
  readonly repoPath: string;
  readonly rules: ProtectedBranchRules;
  isProtected(branch: string): boolean;
  /** Throws `MimirError('policy_denied')` when `branch` is protected. */
  assertNotProtected(branch: string): void;
}

function shortName(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
}

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

export function protectedBranchGuard(
  repoPath: string,
  rules: ProtectedBranchRules,
): ProtectedBranchGuard {
  const frozen: ProtectedBranchRules = { protected: [...rules.protected] };
  const isProtected = (branch: string) => {
    const name = shortName(branch);
    return frozen.protected.some((p) => matches(shortName(p), name));
  };
  return {
    repoPath,
    rules: frozen,
    isProtected,
    assertNotProtected(branch) {
      if (isProtected(branch)) {
        throw new MimirError("policy_denied", `branch '${shortName(branch)}' is protected`, {
          repoPath,
          branch: shortName(branch),
        });
      }
    },
  };
}
