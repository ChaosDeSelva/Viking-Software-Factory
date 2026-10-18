import { EXIT_CODES, type ExitCode } from "./errors.js";
import type { CheckReason } from "./report.js";
import type { CheckState, Verdict } from "./schemas.js";

/** Minimal view of a check result needed to decide the aggregate verdict. */
export interface VerdictCheck {
  id: string;
  required: boolean;
  state: CheckState;
  /** Set when an approved exception waived this check (it is then reported as skipped). */
  exceptionId?: string;
  /** Why a skipped check did not run; `not_applicable` = its `when` guard was not met. */
  reason?: CheckReason;
  /** `policy` when a `requiredCheckIds` policy demands the check (it must then run). */
  requiredBy?: "harness" | "policy";
}

export interface VerdictInput {
  checks: readonly VerdictCheck[];
  /** Reasons the run was blocked by policy (untrusted source, denied command, secret exposure...). */
  blocked?: readonly string[];
  /** Policy requirements that were not met and not waived (e.g. a missing required check id). */
  unmet?: readonly string[];
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
}

const INCOMPLETE_STATES: ReadonlySet<CheckState> = new Set([
  "skipped",
  "errored",
  "timed_out",
  "cancelled",
]);

/**
 * Aggregate verdict (spec §8.2, ADR-005). Precedence: blocked > failed >
 * incomplete > passed. A harness-required check skipped as `not_applicable`
 * (its `when` guard was not met) is excluded from the required set; one
 * demanded by a `requiredCheckIds` policy stays incomplete. `passed` requires at least one required check and every
 * required check `passed` (or waived by an approved exception when it did not
 * run). An exception never turns a `failed` check into a pass.
 */
export function computeVerdict(input: VerdictInput): VerdictResult {
  const reasons: string[] = [];
  let failed = false;
  let incomplete = false;
  let required = 0;

  for (const check of input.checks) {
    if (!check.required) continue;
    if (check.state === "skipped" && check.reason === "not_applicable") {
      if (check.requiredBy === "policy") {
        incomplete = true;
        required++;
        reasons.push(
          `required check '${check.id}' skipped (not applicable, but required by policy)`,
        );
      } else {
        reasons.push(`required check '${check.id}' not applicable (excluded from required gates)`);
      }
      continue;
    }
    required++;
    if (check.state === "passed") continue;
    if (check.state === "failed") {
      failed = true;
      reasons.push(`required check '${check.id}' failed`);
      continue;
    }
    if (INCOMPLETE_STATES.has(check.state) && check.exceptionId !== undefined) {
      reasons.push(`required check '${check.id}' waived by exception ${check.exceptionId}`);
      continue;
    }
    incomplete = true;
    reasons.push(`required check '${check.id}' ${check.state}`);
  }

  for (const unmet of input.unmet ?? []) {
    incomplete = true;
    reasons.push(unmet);
  }
  const passedRequired = input.checks.filter((c) => c.required && c.state === "passed").length;
  if (required > 0 && passedRequired === 0 && !failed) {
    incomplete = true;
    reasons.push("no required check actually ran and passed");
  }
  if (required === 0) {
    incomplete = true;
    reasons.push("no required checks ran; a run with nothing required cannot pass");
  }

  const blocked = input.blocked ?? [];
  if (blocked.length > 0) {
    return { verdict: "blocked", reasons: [...blocked.map((b) => `blocked: ${b}`), ...reasons] };
  }
  if (failed) return { verdict: "failed", reasons };
  if (incomplete) return { verdict: "incomplete", reasons };
  return { verdict: "passed", reasons };
}

/**
 * CLI exit code for a verdict (spec §11.3): passed 0, failed/incomplete 1,
 * blocked 4; an interrupted run is always 130.
 */
export function exitCodeForVerdict(
  verdict: Verdict,
  options: { interrupted?: boolean } = {},
): ExitCode {
  if (options.interrupted) return EXIT_CODES.interrupted;
  switch (verdict) {
    case "passed":
      return EXIT_CODES.ok;
    case "blocked":
      return EXIT_CODES.policyDenied;
    default:
      return EXIT_CODES.verificationFailed;
  }
}
