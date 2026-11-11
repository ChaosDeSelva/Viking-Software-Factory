/**
 * One status vocabulary for all four apps. Servers and UIs ship separately, so any
 * value not in the map resolves to the `unknown` role and keeps its raw text instead of throwing.
 */
export const ROLE_NAMES = [
  "neutral",
  "progress",
  "waiting",
  "success",
  "warning",
  "danger",
  "ended",
  "unknown",
] as const;
export type StatusRole = (typeof ROLE_NAMES)[number];
export type FactoryApp = "sindri" | "mimir" | "heimdall" | "skidbladnir";
export const FACTORY_APPS: readonly FactoryApp[] = ["sindri", "mimir", "heimdall", "skidbladnir"];

export interface StatusDef {
  role: StatusRole;
  label: string;
  meaning: string;
}
export interface ResolvedStatus extends StatusDef {
  /** The value as the server sent it. */
  raw: string;
  /** False when the value fell through to the `unknown` role. */
  known: boolean;
}

/** Human description of each role, used in legends and docs. */
export const ROLE_MEANING: Record<StatusRole, string> = {
  neutral: "Not started, or a resting state",
  progress: "Work is happening now",
  waiting: "Waiting on a person",
  success: "Finished well, or healthy",
  warning: "Degraded, stuck or at risk",
  danger: "Failed or rejected",
  ended: "Ended without a result",
  unknown: "Not recognised by this version of the UI",
};

type Table = Record<string, StatusDef>;
const s = (role: StatusRole, label: string, meaning: string): StatusDef => ({
  role,
  label,
  meaning,
});

/** Lowercase snake key: "Not configured" → not_configured, "TimedOut" → timedout. */
export function statusKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const base: Table = {
  // neutral
  draft: s("neutral", "Draft", "Being written; not submitted yet."),
  received: s("neutral", "Received", "Arrived in the inbox; nobody has acted on it yet."),
  proposed: s("neutral", "Proposed", "Suggested and waiting to be considered."),
  configured: s("neutral", "Configured", "Set up but not running."),
  built: s("neutral", "Built", "The delivery is assembled but not handed over yet."),
  requested: s("neutral", "Requested", "Asked for; not started yet."),
  idle: s("neutral", "Idle", "Connected and free for work."),
  ready: s("neutral", "Ready", "All prerequisites are met; waiting to be picked up."),
  pending: s("neutral", "Pending", "Queued; not started yet."),
  not_checked: s("neutral", "Not checked", "No check has run yet."),
  not_evaluated: s("neutral", "Not evaluated", "The quality gate has not run yet."),
  inbox: s("neutral", "In inbox", "Waiting in the inbox for triage."),
  imported: s("neutral", "Imported", "Copied from the source tracker and in sync."),
  off: s("neutral", "Off", "The steward does nothing for this decision type."),
  recommend: s("neutral", "Recommend", "The steward suggests; a person decides."),
  info: s("neutral", "Info", "A note; no action needed."),
  minor: s("neutral", "Minor", "A small finding that does not block delivery."),
  non_blocking: s("neutral", "Non-blocking", "Can be answered later without stopping work."),

  // progress
  running: s("progress", "Running", "Work is happening now."),
  active: s("progress", "Active", "In progress."),
  leased: s("progress", "Leased", "A worker has claimed this task and is about to run it."),
  starting: s("progress", "Starting", "Starting up."),
  verifying: s("progress", "Verifying", "Checks are running against the result."),
  waiting: s("progress", "Waiting", "The agent is waiting on its runtime or a tool."),
  stopping: s("progress", "Stopping", "Shutting down."),
  busy: s("progress", "Busy", "Working on something now."),
  connecting: s("progress", "Connecting", "Opening the live connection."),
  dispatching: s("progress", "Dispatching", "Being delivered to its target."),
  provisioning: s("progress", "Provisioning", "The machine is being created."),
  terminating: s("progress", "Terminating", "The machine is being destroyed."),
  cancelling: s("progress", "Cancelling", "A cancel was requested and is in progress."),
  inprogress: s("progress", "In progress", "The command is running."),
  unverified: s("progress", "Unverified", "Not proven yet; checks are still to run."),
  waiting_external: s("progress", "Waiting on external", "Waiting for an outside system."),

  // waiting on a person
  awaiting_human: s("waiting", "Needs you", "Stopped until a person answers or decides."),
  verified_pending_review: s(
    "waiting",
    "Awaiting review",
    "Checks passed; a person must review before delivery.",
  ),
  review: s("waiting", "In review", "Waiting for a person to review and approve."),
  in_review: s("waiting", "In review", "Waiting for a person to review and approve."),
  replan_requested: s("waiting", "Replan requested", "The run asked for its plan to be revised."),
  replan: s("waiting", "Replan", "The agent asked for the plan to be revised."),
  awaiting_approval: s("waiting", "Awaiting approval", "Needs an operator's approval to go on."),
  needs_attention: s("waiting", "Needs attention", "Something here needs a person."),
  approval: s("waiting", "Approval needed", "An action is waiting for an operator's approval."),
  read_only: s(
    "waiting",
    "Read-only",
    "You can look but not act. Unlock operator controls to act.",
  ),

  // success
  completed: s("success", "Completed", "Finished successfully."),
  approved: s("success", "Approved", "A person (or the steward) approved it."),
  approve: s("success", "Approved", "The reviewer approved the change."),
  satisfied: s("success", "Satisfied", "The requirement is proven by evidence."),
  connected: s("success", "Connected", "The connection works."),
  passed: s("success", "Passed", "All checks passed."),
  clear: s("success", "Clear", "Nothing needs attention."),
  delivered: s("success", "Delivered", "Handed over."),
  delivered_pending_merge: s(
    "success",
    "Delivered, pending merge",
    "The change was delivered; it is waiting to be merged.",
  ),
  accepted: s("success", "Accepted", "The proposal was accepted."),
  changed: s("success", "Accepted with changes", "Accepted after a person edited it."),
  applied: s("success", "Applied", "The decision has taken effect."),
  succeeded: s("success", "Succeeded", "The command finished successfully."),
  success: s("success", "Succeeded", "The command finished successfully."),
  done: s("success", "Done", "Delivered to its target."),
  ok: s("success", "Healthy", "Working normally."),
  healthy: s("success", "Healthy", "Working normally."),
  valid: s("success", "Valid", "Current, citable knowledge."),
  selected: s("success", "Selected", "The project currently in use."),
  online: s("success", "Online", "Reachable."),
  live: s("success", "Live", "Receiving updates as they happen."),
  paired: s("success", "Paired", "This browser is paired for approvals."),
  unlocked: s("success", "Operator unlocked", "Operator controls are available in this session."),
  auto: s("success", "Linked automatically", "Linked to the Feedback Graph by matching names."),

  // warning
  blocked: s("warning", "Blocked", "Cannot continue until something changes."),
  paused: s("warning", "Paused", "Stopped on purpose; resume to continue."),
  unreachable: s("warning", "Unreachable", "Configured, but the last attempt to reach it failed."),
  cannot_reach: s("warning", "Unreachable", "Configured, but the last attempt to reach it failed."),
  stale: s("warning", "Stale", "The data may be out of date."),
  disconnected: s("warning", "Disconnected", "The connection dropped."),
  reconnecting: s("warning", "Reconnecting", "The live connection dropped; data may be delayed."),
  ask: s("warning", "Question", "The agent asked a question it cannot answer alone."),
  budget: s("warning", "Over budget", "A budget limit was reached."),
  budget_exceeded: s("warning", "Budget exceeded", "Stopped because a budget limit was reached."),
  budget_uncertain: s("warning", "Budget uncertain", "Spending could not be measured."),
  stuck: s("warning", "Stuck", "No progress for a long time."),
  override: s("warning", "Linked by override", "An operator set this link by hand."),
  none: s("warning", "Not linked", "Not linked to the Feedback Graph."),
  degraded: s("warning", "Degraded", "Working, but with problems."),
  conflict: s("warning", "Conflict", "Local edits clash with changes in the source tracker."),
  conflicted: s("warning", "Conflict", "The worktree has a merge conflict."),
  incomplete: s("warning", "Incomplete", "Verification did not run every check."),
  uncertain: s("warning", "Uncertain", "Delivery could not be confirmed."),
  held: s("warning", "Held", "Held back by the supervisor."),
  delayed: s("warning", "Delayed", "The command is delayed."),
  request_changes: s("warning", "Changes requested", "The reviewer asked for rework."),
  reworked: s("warning", "Reworked", "The result needed rework."),
  warning: s("warning", "Warning", "Close to a limit."),
  exceeded: s("warning", "Exceeded", "A limit was passed."),
  major: s("warning", "Major", "An important finding to fix before delivery."),

  // danger
  failed: s("danger", "Failed", "Ended with an error."),
  rejected: s("danger", "Rejected", "Turned down."),
  unsatisfied: s("danger", "Unsatisfied", "Evidence shows the requirement is not met."),
  block: s("danger", "Blocked by agent", "The agent stopped and cannot continue on its own."),
  errored: s("danger", "Errored", "The check crashed before it could pass or fail."),
  timed_out: s("danger", "Timed out", "Took too long and was stopped."),
  timedout: s("danger", "Timed out", "Took too long and was stopped."),
  lost: s("danger", "Lost", "The runtime lost track of this agent."),
  auto_rejected: s("danger", "Rejected automatically", "Rejected by policy without a person."),
  critical: s("danger", "Critical", "A severe finding."),
  blocking: s("danger", "Blocking", "Must be resolved before work can continue."),

  // ended without a result
  cancelled: s("ended", "Cancelled", "Stopped before it finished."),
  superseded: s("ended", "Superseded", "Replaced by a newer version."),
  rolled_back: s("ended", "Rolled back", "The decision was undone."),
  expired: s("ended", "Expired", "Nobody acted before it timed out."),
  archived: s("ended", "Archived", "Kept for history; no longer active."),
  disabled: s("ended", "Disabled", "Turned off in settings."),
  not_paired: s("ended", "Not paired", "This browser is not paired for approvals."),
  not_configured: s("ended", "Not configured", "Not set up yet."),
  stopped: s("ended", "Stopped", "Not running."),
  terminated: s("ended", "Terminated", "The machine was destroyed."),
  closed: s("ended", "Closed", "The session ended."),
  removed: s("ended", "Removed", "Cleaned up."),
  skipped: s("ended", "Skipped", "Did not run."),
  retracted: s("ended", "Retracted", "Withdrawn; no longer citable."),
  deprecated: s("ended", "Deprecated", "Kept for history; do not rely on it."),
  offline: s("ended", "Offline", "Not connected."),

  // unknown
  unknown: s("unknown", "Unknown", "The source did not report a status."),
  unavailable: s("unknown", "Unavailable", "The status could not be read."),
  not_reported: s("unknown", "Not reported", "The source did not report this."),
  no_report: s("unknown", "No report", "No verification report exists yet."),
};

interface AppTable {
  values?: Table | undefined;
  /** Values that mean different things in different places, keyed by domain. */
  domains?: Record<string, Table> | undefined;
}

const stewardMode: Table = {
  off: base.off!,
  recommend: base.recommend!,
  auto: s("neutral", "Automatic", "The steward decides and applies on its own."),
};
const stewardState: Table = {
  running: s("success", "Running", "The steward is working through decisions."),
  paused: s("warning", "Paused", "The steward is paused."),
};
const decision: Table = {
  pending: s("waiting", "Awaiting you", "The steward proposed this; a person must decide."),
};
const approvalDomain: Table = {
  pending: s("waiting", "Awaiting approval", "Needs an operator's approval to go on."),
};
const risk: Table = {
  high: s("warning", "High risk", "Likely to cause problems if wrong."),
  medium: s("neutral", "Medium risk", "Worth a second look."),
  low: s("neutral", "Low risk", "Unlikely to cause problems."),
};
const supervisorMessage: Table = {
  pending: s("neutral", "Queued", "Waiting to be dispatched."),
};
const command: Table = {
  accepted: s("neutral", "Accepted", "The command was accepted and queued."),
};
const project: Table = {
  active: s("success", "Active", "In use."),
};

const TABLES: Record<FactoryApp, AppTable> = {
  sindri: {
    values: {
      // A run that is pending is queued to start, not waiting on a person.
      pending: s("progress", "Pending", "Queued to start."),
      fail: s("danger", "Failed", "The check failed."),
    },
    domains: {
      decision,
      approval: approvalDomain,
      review: { pending: s("waiting", "Awaiting review", "No reviewer verdict yet.") },
      stewardMode,
      stewardState,
      risk,
    },
  },
  mimir: {
    values: {
      // Crews and sessions that stop have simply ended.
      stopped: base.stopped!,
    },
    domains: { approval: approvalDomain, command, risk },
  },
  heimdall: {
    values: {
      pending: s("waiting", "Pending", "Waiting on an operator."),
    },
    domains: {
      task: { pending: base.pending! },
      decision,
      stewardMode,
      stewardState,
      supervisorMessage,
      project,
    },
  },
  skidbladnir: {
    values: {
      // Worker states and AWS-cased SSM command states (Success, TimedOut, …).
      stopped: s("warning", "Stopped", "The worker is stopped; start it to use it again."),
      pending: s("neutral", "Pending", "The command is queued."),
      active: s("progress", "Active", "The terminal session is open."),
      simulation: s("neutral", "Simulation", "Workers are simulated; no cloud resources are used."),
    },
  },
};

const warned = new Set<string>();
let unknownHandler: (app: FactoryApp, raw: string, domain?: string) => void = (
  app,
  raw,
  domain,
) => {
  const key = `${app}:${domain ?? ""}:${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[@factory/ui] unmapped ${app} status "${raw}"${domain ? ` (${domain})` : ""}`);
};
/** Replace the once-per-value console warning for unmapped statuses (e.g. send to telemetry). */
export function setUnknownStatusHandler(handler: typeof unknownHandler): void {
  unknownHandler = handler;
}

function lookup(app: FactoryApp, key: string, domain?: string): StatusDef | undefined {
  const table = TABLES[app];
  return (
    (domain ? table?.domains?.[domain]?.[key] : undefined) ?? table?.values?.[key] ?? base[key]
  );
}

/**
 * Resolve a raw status to its role, label and meaning. `domain` disambiguates values that differ
 * by context (a Sindri decision `pending` waits on you; a run `pending` is just queued).
 * Values like "failed: lint" or "Unreachable: timeout" resolve by the part before the colon.
 */
export function statusRole(app: string, value: unknown, domain?: string): ResolvedStatus {
  const raw = value == null || value === "" ? "unknown" : String(value);
  const known = (FACTORY_APPS as readonly string[]).includes(app) ? (app as FactoryApp) : undefined;
  const key = statusKey(raw);
  const def =
    known &&
    (lookup(known, key, domain) ??
      (raw.includes(":") ? lookup(known, statusKey(raw.split(":")[0]), domain) : undefined));
  if (def) return { ...def, raw, known: def.role !== "unknown" || key in base };
  unknownHandler(known ?? "heimdall", raw, domain);
  return {
    role: "unknown",
    label: raw,
    meaning: "This status is not recognised by this version of the UI.",
    raw,
    known: false,
  };
}

/**
 * Values each app emits, from its own enums (server, protocol and web). Other known values still
 * resolve through the shared table, so a value moving between apps degrades to a sensible role.
 */
const APP_VALUES: Record<FactoryApp, readonly string[]> = {
  sindri: [
    // runs
    "pending",
    "running",
    "awaiting_human",
    "blocked",
    "replan_requested",
    "verified_pending_review",
    "delivered_pending_merge",
    "cancelled",
    "failed",
    // specs and plans
    "draft",
    "review",
    "approved",
    "superseded",
    // deliveries, requirements, export requests
    "built",
    "satisfied",
    "unsatisfied",
    "unverified",
    "requested",
    "awaiting_approval",
    // approvals and intake disposition
    "rejected",
    "expired",
    // escalations, gates, verification, review
    "block",
    "ask",
    "replan",
    "not_evaluated",
    "passed",
    "incomplete",
    "errored",
    "skipped",
    "timed_out",
    "approve",
    "request_changes",
    "budget_exceeded",
    "info",
    "minor",
    "major",
    "critical",
    "blocking",
    "non_blocking",
    // steward decisions, modes, state and outcomes
    "accepted",
    "changed",
    "applied",
    "rolled_back",
    "off",
    "recommend",
    "auto",
    "paused",
    "reworked",
    "unknown",
    // Feedback Graph connection and link
    "not_configured",
    "disabled",
    "not_checked",
    "connected",
    "unreachable",
    "override",
    "none",
    // intake sync and knowledge
    "imported",
    "stale",
    "conflict",
    "proposed",
    "valid",
    "retracted",
  ],
  mimir: [
    // tasks, missions, crews
    "pending",
    "ready",
    "leased",
    "running",
    "verifying",
    "completed",
    "blocked",
    "failed",
    "cancelled",
    "draft",
    "active",
    "paused",
    "configured",
    "stopped",
    "archived",
    // agent sessions
    "requested",
    "starting",
    "idle",
    "waiting",
    "stopping",
    "unknown",
    // approvals and commands
    "approved",
    "rejected",
    "expired",
    "accepted",
    "succeeded",
    // worktrees, attention, budgets
    "conflicted",
    "removed",
    "approval",
    "stuck",
    "budget",
    "warning",
    "exceeded",
    "budget_exceeded",
    "budget_uncertain",
  ],
  heimdall: [
    "received",
    "draft",
    "review",
    "in_review",
    "approved",
    "pending",
    "ready",
    "running",
    "starting",
    "leased",
    "busy",
    "verifying",
    "completed",
    "failed",
    "blocked",
    "cancelled",
    "awaiting_approval",
    "needs_attention",
    "verified_pending_review",
    "delivered_pending_merge",
    "delivered",
    "satisfied",
    "passed",
    "clear",
    "connected",
    "disconnected",
    "not_configured",
    "connecting",
    "stale",
    "unlocked",
    "read_only",
    "paired",
    "not_paired",
    "active",
    "archived",
    "paused",
    "lost",
    "unknown",
    "unavailable",
    "accepted",
    "changed",
    "rejected",
    "applied",
    "rolled_back",
    "expired",
    "off",
    "recommend",
    "auto",
    "disabled",
    "unreachable",
    "not_checked",
    "override",
    "none",
    "held",
    "waiting_external",
    "dispatching",
    "done",
    "uncertain",
    "blocking",
    "non_blocking",
  ],
  skidbladnir: [
    // workers
    "provisioning",
    "starting",
    "running",
    "stopping",
    "stopped",
    "terminating",
    "terminated",
    "failed",
    "unknown",
    "requested",
    "simulation",
    // SSM commands (AWS casing normalises to these keys) and terminal sessions
    "pending",
    "inprogress",
    "delayed",
    "cancelling",
    "success",
    "timedout",
    "cancelled",
    "active",
    "closed",
  ],
};

/** `{ app: { value: role } }` for every value each app emits (default domain). */
export const STATUS_ROLES: Record<FactoryApp, Record<string, StatusRole>> = Object.fromEntries(
  FACTORY_APPS.map((app) => [
    app,
    Object.fromEntries(APP_VALUES[app].map((v) => [v, lookup(app, v)?.role ?? "unknown"])),
  ]),
) as Record<FactoryApp, Record<string, StatusRole>>;

/** Every mapped value with its definition, including per-domain variants. */
export function listStatuses(): {
  app: FactoryApp;
  domain?: string | undefined;
  value: string;
  def: StatusDef;
}[] {
  const out: { app: FactoryApp; domain?: string; value: string; def: StatusDef }[] = [];
  for (const app of FACTORY_APPS) {
    for (const value of APP_VALUES[app]) {
      const def = lookup(app, value);
      if (def) out.push({ app, value, def });
    }
    for (const [domain, table] of Object.entries(TABLES[app].domains ?? {}))
      for (const [value, def] of Object.entries(table)) out.push({ app, domain, value, def });
  }
  return out;
}
