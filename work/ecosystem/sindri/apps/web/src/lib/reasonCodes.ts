/**
 * Plain words for the reason codes Sindri's quality gates and review records write
 * (`packages/delivery/src/gates/{gate-runner,brokkr-report,evidence}.ts`,
 * `packages/delivery/src/review/review-orchestrator.ts`). Codes may carry a `:detail` suffix
 * (`acceptance_not_met:AC1`, `review_request_changes:major_finding`). Unknown codes come back
 * raw: never hidden, never thrown.
 */

export interface ReasonText {
  /** What to show. The raw code itself when unknown. */
  words: string;
  /** The code exactly as received, for the tooltip. */
  raw: string;
  known: boolean;
}

const CODES: Readonly<Record<string, string>> = {
  // Engineering gate (Brokkr's verification report).
  verification_report_missing: "Verification report missing",
  verification_report_invalid: "Verification report unreadable",
  brokkr_verdict_failed: "Brokkr checks failed",
  brokkr_verdict_incomplete: "Brokkr verification incomplete",
  brokkr_verdict_blocked: "Brokkr verification blocked",
  harness_lock_mismatch: "Report used a different harness lock",
  report_task_missing: "Report names no task",
  report_task_mismatch: "Report is for another task",
  report_commit_unverifiable: "Report commit could not be checked",
  report_commit_mismatch: "Report covers another commit",
  inconsistent_report: "Report contradicts its own required check",
  // Evidence reads (any gate, any review).
  artifact_unavailable: "Evidence file unavailable",
  artifact_mismatch: "Evidence belongs to another task",
  evidence_integrity_mismatch: "Evidence changed after it was recorded",
  artifact_missing: "Required artifact missing",
  artifact_hash_invalid: "Artifact hash invalid",
  // Command gates.
  command_not_run: "Required command not run",
  command_exit_code_unrecorded: "Command exit code not recorded",
  command_failed: "Required command failed",
  // Review gates.
  review_missing: "Review missing",
  review_pending: "Review not finished",
  review_stale: "Review is of an older attempt",
  review_request_changes: "Reviewer requested changes",
  review_critical_finding: "Review found a critical issue",
  review_major_finding: "Review found a major issue",
  unparseable_review: "Review file unreadable",
  acceptance_not_satisfied: "Acceptance criteria not met",
  acceptance_unreviewed: "Acceptance criterion not reviewed",
  acceptance_not_met: "Acceptance criterion not met",
  acceptance_duplicate: "Acceptance criterion assessed twice",
  acceptance_unknown: "Unknown acceptance criterion assessed",
  // Review record reasons (also the suffix of `review_request_changes:`).
  missing_review: "Reviewer left no review",
  invalid_acceptance: "Review assessed criteria wrongly",
  blocking_finding: "Blocking finding",
  critical_finding: "Critical finding",
  major_finding: "Major finding",
  findings: "Findings",
};

/** Gate ids Sindri itself configures (`apps/server/src/delivery-service.ts`). */
const GATES: ReadonlySet<string> = new Set(["brokkr", "independent-review", "review-verdict"]);

/** Wordings that depend on the gate. */
const BY_GATE: Readonly<Record<string, string>> = {
  "review-verdict review_missing": "Review verdict missing",
  "independent-review review_missing": "Independent review missing",
};

const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/** `code[:detail]` → words, the detail mapped when it is itself a code; null when unknown. */
function codeWords(code: string): string | null {
  const at = code.indexOf(":");
  const head = at < 0 ? code : code.slice(0, at);
  const words = CODES[head];
  if (words === undefined) return null;
  if (at < 0) return words;
  const rest = code.slice(at + 1);
  // `invalid_acceptance:duplicate:AC1`: the second segment says which way it is wrong.
  if (head === "invalid_acceptance") {
    const k = rest.indexOf(":");
    const how = k < 0 ? rest : rest.slice(0, k);
    const id = k < 0 ? "" : rest.slice(k + 1);
    const base =
      how === "duplicate"
        ? CODES.acceptance_duplicate
        : how === "unknown"
          ? CODES.acceptance_unknown
          : null;
    if (base) return id ? `${base}: ${id}` : base;
  }
  return rest ? `${words}: ${lower(codeWords(rest) ?? rest)}` : words;
}

/**
 * Plain words for one reason code. `gateId` is the failing gate when known separately; a
 * `"<gateId> <code>"` string is split the same way. A gate Sindri does not configure itself is
 * named in front of the words.
 */
export function describeReason(reason: string | null | undefined, gateId?: string): ReasonText {
  const raw = (reason ?? "").trim();
  const full = gateId ? `${gateId} ${raw}`.trim() : raw;
  if (!raw) return { words: full, raw: full, known: false };
  let gate = gateId;
  let code = raw;
  const space = raw.indexOf(" ");
  if (gate === undefined && space > 0 && GATES.has(raw.slice(0, space))) {
    gate = raw.slice(0, space);
    code = raw.slice(space + 1).trim();
  }
  const special = gate ? BY_GATE[`${gate} ${code}`] : undefined;
  const words = special ?? codeWords(code);
  if (words === null) return { words: full, raw: full, known: false };
  return {
    words: gate && !GATES.has(gate) ? `${gate}: ${lower(words)}` : words,
    raw: full,
    known: true,
  };
}
