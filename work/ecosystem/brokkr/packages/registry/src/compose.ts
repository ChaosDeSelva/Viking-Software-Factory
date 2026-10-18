import type { ComposedCheck, ComposedHarness, ResolvedHarnessSet } from "@brokkr/core";

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Merge a resolved set into one execution contract:
 * - checks: deduplicated by id (first definition wins); required anywhere stays required;
 * - policies: strictest wins (deny beats allow); approval requirements are unioned;
 * - skills: required union; optional union minus required;
 * - workflow stages and AI review criteria: ordered union; evidence flags: OR.
 */
export function composeHarnessSet(set: ResolvedHarnessSet): ComposedHarness {
  const checks = new Map<string, ComposedCheck>();
  const warnings: string[] = [];
  const required: string[] = [];
  const optional: string[] = [];
  const requiredBy: Record<string, string[]> = {};
  const stages: string[] = [];
  const criteria: string[] = [];
  const approvals = new Set<string>();
  let network: "allow" | "deny" = "allow";
  let destructive: "allow" | "deny" = "allow";
  const evidence = { captureLogs: false, captureTestResults: false, captureScreenshots: false };

  for (const h of set.harnesses) {
    const m = h.manifest;
    const ref = `${m.metadata.name}@${m.metadata.version}`;
    for (const check of m.checks) {
      const existing = checks.get(check.id);
      if (!existing) {
        checks.set(check.id, { ...check, command: [...check.command], from: [ref] });
        continue;
      }
      existing.required = existing.required || check.required;
      existing.from.push(ref);
      const fields = (["command", "timeoutSeconds", "cwd", "when"] as const).filter(
        (f) => JSON.stringify(existing[f]) !== JSON.stringify(check[f]),
      );
      if (fields.length > 0) {
        warnings.push(
          `check '${check.id}' is defined differently by ${existing.from[0]} and ${ref} (${fields.join(", ")}); using the definition from ${existing.from[0]}`,
        );
      }
    }
    if (m.policies.network === "deny") network = "deny";
    if (m.policies.destructiveCommands === "deny") destructive = "deny";
    for (const a of m.policies.requireApprovalFor) approvals.add(a);
    for (const s of m.skills.required) {
      pushUnique(required, s);
      (requiredBy[s] ??= []).push(ref);
    }
    for (const s of m.skills.optional) pushUnique(optional, s);
    for (const stage of m.workflow.stages) pushUnique(stages, stage);
    for (const c of m.aiReview?.criteria ?? []) pushUnique(criteria, c);
    evidence.captureLogs ||= m.evidence.captureLogs;
    evidence.captureTestResults ||= m.evidence.captureTestResults;
    evidence.captureScreenshots ||= m.evidence.captureScreenshots;
  }

  return {
    harnesses: set.harnesses.map((h) => ({
      name: h.manifest.metadata.name,
      version: h.manifest.metadata.version,
    })),
    checks: [...checks.values()],
    policies: {
      network,
      destructiveCommands: destructive,
      requireApprovalFor: [...approvals].sort(),
    },
    skills: { required, optional: optional.filter((s) => !required.includes(s)) },
    requiredBy,
    workflow: { stages },
    evidence,
    aiReview: { criteria },
    executionAllowed: set.harnesses.every((h) => h.executionAllowed),
    warnings,
  };
}
