// Pure view logic for the steward (Autonomy page) and Feedback Graph. Sindri stays authoritative;
// every enum it sends may grow, so an unknown value is shown as sent and never unlocks a control.
import { actionBlock, sameRepo } from "./workflowState.ts";
type R = Record<string, any>;
type Session = { operator?: boolean; pairedSindri?: boolean };

export const STEWARD_MODES = ["off", "recommend", "auto"] as const;
const MODE_LABELS: Record<string, string> = {
  off: "Off",
  recommend: "Recommend",
  auto: "Automatic",
};
const TYPE_LABELS: Record<string, string> = {
  "spec.answer": "Answer specification questions",
  "escalation.resolve": "Resolve run escalations",
  "rework.suggest": "Suggest rework after delivery",
  "spec.approve": "Approve specifications",
  "plan.approve": "Approve plans",
};
const STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting you",
  accepted: "Accepted",
  changed: "Accepted with changes",
  rejected: "Rejected",
  applied: "Applied",
  rolled_back: "Rolled back",
  expired: "Expired",
};
export const DECISION_STATUSES = Object.keys(STATUS_LABELS);
export const DECISION_TYPES = Object.keys(TYPE_LABELS);

/** A label for a known value; an unknown one is returned exactly as Sindri sent it. */
const labelOf = (labels: Record<string, string>, value: unknown) =>
  Object.hasOwn(labels, String(value))
    ? labels[String(value)]
    : String(value ?? "unknown");
export const modeLabel = (mode: unknown) => labelOf(MODE_LABELS, mode);
export const typeLabel = (type: unknown) => labelOf(TYPE_LABELS, type);
export const statusLabel = (status: unknown) => labelOf(STATUS_LABELS, status);

/** Types whose acceptance performs an approval; matches the server's rule. */
export const APPROVAL_TYPES = ["spec.approve", "plan.approve"];
const PLAIN_TYPES = ["spec.answer", "escalation.resolve", "rework.suggest"];
/** An unknown type is treated as an approval, the stricter case. */
export const acceptIsApproval = (type: unknown) =>
  APPROVAL_TYPES.includes(String(type)) || !PLAIN_TYPES.includes(String(type));

/** Running or paused; null when the status has not loaded or `running` is not a boolean. */
export const runningLabel = (status: R | null | undefined): string | null =>
  typeof status?.running === "boolean"
    ? status.running
      ? "running"
      : "paused"
    : null;

/** Why switching a type to `mode` cannot be proposed; empty when it can. */
export function modeBlock(row: R, mode: string, session: Session): string {
  const base = actionBlock("steward.mode", undefined, session);
  if (base) return base;
  if (!(STEWARD_MODES as readonly string[]).includes(mode))
    return `Unknown mode ${mode}.`;
  if (row.mode === mode) return `Already ${modeLabel(mode).toLowerCase()}.`;
  if (mode === "auto" && row.autoAllowed !== true)
    return APPROVAL_TYPES.includes(row.type)
      ? "Approvals are never automatic; they can only be recommended."
      : "Sindri does not allow automatic decisions for this type yet.";
  return "";
}

/** Track-record figures for one type, formatted; missing numbers show as a dash. */
export function trackRecord(stats: R | null | undefined) {
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? String(v) : "—";
  const accuracy = stats?.accuracy;
  return {
    decided: n(stats?.decided),
    accepted: n(stats?.accepted),
    changed: n(stats?.changed),
    rejected: n(stats?.rejected),
    rolledBack: n(stats?.rolledBack),
    autoApplied: n(stats?.autoApplied),
    accuracy:
      typeof accuracy === "number" && Number.isFinite(accuracy)
        ? Math.round(accuracy * 100) + "%"
        : "No record yet",
  };
}

export const confidenceLabel = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(1, Math.max(0, value)) * 100) + "%"
    : "not reported";

export type EntryActions = {
  accept: string;
  reject: string;
  rollback: string;
  note: string;
};
/** For each entry action, why it cannot be sent now; empty strings for the allowed ones. */
export function entryActions(d: R, session: Session): EntryActions {
  const base = actionBlock("steward.accept", undefined, session);
  const pending =
    d.status === "pending"
      ? ""
      : `Only a decision awaiting you can be decided (status is ${d.status ?? "not reported"}).`;
  const rollback =
    d.reversible !== true
      ? "This decision cannot be reversed."
      : d.status !== "applied"
        ? `Only an applied decision can be rolled back (status is ${d.status ?? "not reported"}).`
        : "";
  return {
    accept: base || pending,
    reject: base || pending,
    rollback: base || rollback,
    note: base,
  };
}

/** The accept body: a changed answer (spec.answer only) is sent as `value`, otherwise nothing. */
export function acceptBody(d: R, edited: string | null | undefined): R {
  if (d.type !== "spec.answer" || edited == null) return {};
  const value = edited.trim();
  return value && value !== String(d.recommendation?.value ?? "").trim()
    ? { value }
    : {};
}

export type DecisionFilter = {
  projectIds: string[] | null;
  type: string;
  status: string;
};
/**
 * The decisions query for the chosen project (null = all projects), type and status. One Sindri
 * project is asked for directly; several (one repository registered twice) are filtered here.
 */
export function decisionQuery(f: DecisionFilter, limit = 100): string {
  const q = new URLSearchParams();
  if (f.projectIds?.length === 1) q.set("projectId", f.projectIds[0]);
  if (f.type) q.set("type", f.type);
  if (f.status) q.set("status", f.status);
  q.set("limit", String(limit));
  return "details/steward/decisions?" + q.toString();
}
export function filterDecisions(rows: R[], f: DecisionFilter): R[] {
  return rows.filter(
    (d) =>
      (!f.projectIds || f.projectIds.includes(d.projectId)) &&
      (!f.type || d.type === f.type) &&
      (!f.status || d.status === f.status),
  );
}

/**
 * Sindri projects behind the app's project selection, which is keyed by repository path:
 * null for "all", otherwise every Sindri project registered for that repository.
 */
export function stewardProjects(
  selection: string,
  sindriProjects: R[],
): string[] | null {
  if (selection === "all") return null;
  return sindriProjects
    .filter((p) => p.id === selection || sameRepo(p.repoPath, selection))
    .map((p) => p.id);
}

/** Notes for the selection: that project's and the global ones; all of them for "all". */
export const filterNotes = (notes: R[], projectIds: string[] | null) =>
  notes.filter(
    (n) =>
      !projectIds || n.projectId == null || projectIds.includes(n.projectId),
  );

const LINK_LABELS: Record<string, string> = {
  auto: "Matched automatically",
  override: "Set by the operator",
  none: "Not linked",
};
export const linkLabel = (source: unknown) => labelOf(LINK_LABELS, source);

/** One badge value and a sentence for Sindri's Feedback Graph status. */
export function feedbackGraphSummary(s: R | null | undefined): {
  badge: string;
  text: string;
} {
  if (!s)
    return {
      badge: "unknown",
      text: "Sindri has not reported Feedback Graph status.",
    };
  if (!s.configured)
    return {
      badge: "not configured",
      text: "Feedback Graph is not configured in Sindri's settings.",
    };
  if (!s.enabled)
    return {
      badge: "disabled",
      text: "Feedback Graph is configured but turned off in Sindri.",
    };
  if (s.reachable === true)
    return {
      badge: "connected",
      text: `Sindri reaches Feedback Graph at ${s.url ?? "its configured address"}.`,
    };
  if (s.reachable === false)
    return {
      badge: "unreachable",
      text: `Sindri cannot reach Feedback Graph${s.error ? ": " + s.error : "."}`,
    };
  return {
    badge: "not checked",
    text: "Sindri has not checked Feedback Graph yet.",
  };
}

/** Why a link override cannot be proposed; empty when it can. */
export function linkBlock(
  key: string,
  current: R | null | undefined,
  session: Session,
): string {
  const base = actionBlock("project.feedbackGraph", undefined, session);
  if (base) return base;
  if (!current) return "The current link has not loaded yet.";
  if (!key.trim()) return "Enter a Feedback Graph project key.";
  if (current.source === "override" && current.projectKey === key.trim())
    return "This key is already set.";
  return "";
}
export function clearLinkBlock(
  current: R | null | undefined,
  session: Session,
): string {
  return (
    actionBlock("project.feedbackGraph", undefined, session) ||
    (current?.source === "override"
      ? ""
      : "There is no operator override to clear.")
  );
}
