import type { AppId } from "./types.js";

/**
 * Every status value the four apps show, in plain words. A group is one kind of thing (a run, a
 * task, a worker); its values become glossary entries named "<Label> (<noun> status)". Apps that
 * show the same values (Heimdall shows Mimir task states) register the same group, so one value
 * has one explanation.
 */
export interface StatusValue {
  value: string;
  label: string;
  /** Tooltip, at most 140 characters. */
  short: string;
  /** Extra markdown for the glossary entry. */
  more?: string;
}

export interface StatusGroup {
  key: string;
  /** "run" → term suffix "(run status)". */
  noun: string;
  /** Glossary id of the thing the status belongs to. */
  concept: string;
  values: StatusValue[];
}

const v = (value: string, label: string, short: string, more?: string): StatusValue =>
  more === undefined ? { value, label, short } : { value, label, short, more };

export const STATUS_GROUPS: readonly StatusGroup[] = [
  // ---------- Sindri ----------
  {
    key: "spec",
    noun: "spec",
    concept: "spec",
    values: [
      v("draft", "Draft", "Being written. You can edit it and answer its open questions."),
      v(
        "review",
        "In review",
        "Submitted for your review. Approve it (pairing code needed) or revise it.",
        "Approval is refused while blocking open questions remain.",
      ),
      v(
        "approved",
        "Approved",
        "Approved by you and frozen. Plans are made from this version.",
        "An approved version never changes. Changes create a new version.",
      ),
      v(
        "superseded",
        "Superseded",
        "Replaced by a newer version. Kept as history; nothing uses it.",
      ),
    ],
  },
  {
    key: "plan",
    noun: "plan",
    concept: "plan",
    values: [
      v("draft", "Draft", "Proposed by the planner. You can edit tasks, dependencies and budgets."),
      v(
        "review",
        "In review",
        "Submitted for your review. Approve it (pairing code needed) or revise it.",
      ),
      v(
        "approved",
        "Approved",
        "Approved and frozen. You can start a run from it.",
        "The plan is locked to the exact harness versions it was approved with.",
      ),
      v("superseded", "Superseded", "Replaced by a revised version. Kept as history."),
    ],
  },
  {
    key: "run",
    noun: "run",
    concept: "run",
    values: [
      v(
        "pending",
        "Starting",
        "Created and about to start. Sindri has not begun following the mission yet.",
      ),
      v("running", "Running", "Mimir is working through the tasks. Nothing needs you right now."),
      v(
        "awaiting_human",
        "Needs you",
        "Paused on you: an approval, an escalation asking for a decision, or a budget alert. Open Needs you.",
        "The run continues by itself once every open item is answered.",
      ),
      v(
        "blocked",
        "Blocked",
        "No task can move and no question is open. A task escalated as block or its inputs are stuck.",
        "Open Needs you to retry, skip, replan or abort the stuck task, or cancel the run.",
      ),
      v(
        "replan_requested",
        "Replan requested",
        "A task asked for a new plan. Revise the plan, approve it and run it; that closes this run.",
        "This status is not final: running a revised plan of the same lineage cancels this run with the reason `superseded by revised plan`.",
      ),
      v(
        "verified_pending_review",
        "Verified, awaiting review",
        "All work finished and passed verification. Review the delivery and export it if you want it.",
        "If you skipped some tasks, the verified part is delivered and the skipped tasks are left out.",
      ),
      v(
        "delivered_pending_merge",
        "Exported, not merged",
        "The verified result was exported as a patch. Applying and merging it is up to you.",
        "Nothing is merged or deployed automatically.",
      ),
      v(
        "cancelled",
        "Cancelled",
        "Stopped on purpose: abort, cancel, or replaced by a revised plan. It will not continue.",
      ),
      v(
        "failed",
        "Failed",
        "Mimir ended the mission as failed. Nothing more runs. Revise the plan or run it again.",
      ),
    ],
  },
  {
    key: "delivery",
    noun: "delivery",
    concept: "delivery",
    values: [
      v(
        "built",
        "Ready to export",
        "Verified and reported, not exported yet. Use Export local result on the delivery.",
      ),
      v(
        "delivered_pending_merge",
        "Exported, not merged",
        "The verified result was exported as a patch. Applying and merging it is up to you.",
      ),
    ],
  },
  {
    key: "requirement",
    noun: "requirement",
    concept: "requirement",
    values: [
      v("satisfied", "Satisfied", "Recorded evidence shows this acceptance criterion is met."),
      v(
        "unsatisfied",
        "Not satisfied",
        "Recorded evidence shows this acceptance criterion is not met.",
      ),
      v("unverified", "Unverified", "No evidence either way yet. Not counted as met."),
    ],
  },
  {
    key: "export",
    noun: "local export",
    concept: "local-export",
    values: [
      v("requested", "Exported", "Mimir recorded this task's verified result for export."),
      v(
        "awaiting_approval",
        "Awaiting your approval",
        "The export of this task's result waits for your approval on the delivery.",
      ),
    ],
  },
  {
    key: "gate",
    noun: "quality gate",
    concept: "quality-gate",
    values: [
      v("passed", "Passed", "Brokkr's verdict passed and every product gate found its evidence."),
      v("failed", "Failed", "At least one gate failed. The reasons are listed with the task."),
      v(
        "not_evaluated",
        "Not evaluated",
        "The gates have not run for this task yet.",
        "Gates run when a run is verified, or when you choose Re-run quality checks.",
      ),
    ],
  },
  {
    key: "brokkr-verdict",
    noun: "Brokkr verdict",
    concept: "brokkr-verdict",
    values: [
      v("passed", "Passed", "Every applicable required check ran and passed."),
      v("failed", "Failed", "A check ran and found a failure."),
      v(
        "incomplete",
        "Incomplete",
        "A required check could not run (missing tool, timeout, error), or nothing required ran.",
      ),
      v(
        "blocked",
        "Blocked",
        "Brokkr refused: policy denial, untrusted harness, missing or tampered lock, or a secret in output.",
      ),
    ],
  },
  {
    key: "brokkr-check",
    noun: "Brokkr check",
    concept: "checks",
    values: [
      v("passed", "Passed", "The check ran and succeeded."),
      v("failed", "Failed", "The check ran and detected a failure."),
      v("errored", "Errored", "A tool or infrastructure error prevented a valid result."),
      v("skipped", "Skipped", "The check did not run. The report always says why."),
      v("cancelled", "Cancelled", "The check was interrupted."),
      v("timed_out", "Timed out", "The check ran past its time limit and was killed."),
    ],
  },
  {
    key: "review",
    noun: "review",
    concept: "review-verdict",
    values: [
      v("requested", "Requested", "The independent review task was asked for. No result yet."),
      v("completed", "Completed", "The reviewer finished and wrote its verdict."),
    ],
  },
  {
    key: "review-verdict",
    noun: "review verdict",
    concept: "review-verdict",
    values: [
      v("approve", "Approve", "The reviewer accepts the change."),
      v(
        "comment",
        "Comment",
        "Remarks only: neither approves nor asks for changes. The default verdict of a PR review draft.",
      ),
      v(
        "request_changes",
        "Request changes",
        "The reviewer wants changes. The review gate does not pass.",
      ),
    ],
  },
  {
    key: "severity",
    noun: "finding severity",
    concept: "severity",
    values: [
      v("info", "Info", "A remark. Does not block."),
      v("nit", "Nit", "A matter of taste or style. Does not block. Used by PR reviews."),
      v("minor", "Minor", "A small issue. Does not block."),
      v("major", "Major", "A real problem. Blocks the review gate."),
      v("critical", "Critical", "A serious problem. Blocks the review gate."),
      v("blocking", "Blocking", "Must be fixed before delivery. Blocks the review gate."),
    ],
  },
  {
    key: "knowledge-proposal",
    noun: "knowledge proposal",
    concept: "knowledge-proposal",
    values: [
      v(
        "proposed",
        "Proposed",
        "Suggested from a delivery's evidence. Waiting for you to accept or reject.",
      ),
      v(
        "accepted",
        "Accepted",
        "You accepted it. It is now valid knowledge that drafting and planning use.",
      ),
      v("rejected", "Rejected", "You rejected it. It is kept as history and not used."),
    ],
  },
  {
    key: "knowledge",
    noun: "knowledge",
    concept: "knowledge",
    values: [
      v("valid", "Valid", "Current. Drafting, planning and the steward can cite it."),
      v("superseded", "Superseded", "Replaced by a newer entry. Kept as history."),
      v("retracted", "Retracted", "Withdrawn with a reason. Kept as history, never used."),
    ],
  },
  {
    key: "knowledge-decision",
    noun: "recorded decision",
    concept: "knowledge",
    values: [
      v(
        "deprecated",
        "Deprecated",
        "A recorded decision that no longer applies but is kept for history.",
      ),
    ],
  },
  {
    key: "work-kind",
    noun: "work kind",
    concept: "work-kind",
    values: [
      v(
        "change",
        "Change",
        "A code change. Ends as a verified patch you export and apply.",
        "Every request made before work kinds existed is a change.",
      ),
      v(
        "research",
        "Research",
        "A question answered with a cited Markdown document. Ends when you accept or reject it.",
      ),
      v(
        "pr_review",
        "PR review",
        "A review of a GitHub pull request. Ends when you post it to GitHub, or leave it local.",
      ),
    ],
  },
  {
    key: "research-decision",
    noun: "research decision",
    concept: "research",
    values: [
      v(
        "accepted",
        "Accepted",
        "You accepted the research document as the answer.",
        "Accepting needs the pairing code and passing research checks.",
      ),
      v(
        "rejected",
        "Rejected",
        "You rejected the research document, with a reason. Ask a follow-up to try again.",
      ),
    ],
  },
  {
    key: "review-post",
    noun: "PR review",
    concept: "pr-review",
    values: [
      v(
        "posted",
        "Posted",
        "The review is on the pull request. It was posted once, from your gh login; edits are closed.",
        "Until then the review shows _Not posted_ and stays on this machine.",
      ),
    ],
  },
  {
    key: "intake-sync",
    noun: "intake sync",
    concept: "intake",
    values: [
      v("imported", "Up to date", "The stored copy matches the last import from the tracker."),
      v(
        "stale",
        "Update available",
        "The tracker issue changed since import. The new copy is held until you take it or keep yours.",
      ),
      v(
        "conflict",
        "Conflict",
        "The issue changed in the tracker and you added local notes. Choose which copy to keep.",
      ),
    ],
  },
  {
    key: "open-question",
    noun: "open question",
    concept: "open-question",
    values: [
      v("blocking", "Blocking", "Must be answered before the spec can be approved."),
      v(
        "non_blocking",
        "Not blocking",
        "Worth answering, but the spec can be approved without it.",
      ),
    ],
  },
  {
    key: "intake",
    noun: "intake",
    concept: "intake",
    values: [
      v(
        "received",
        "Received",
        "A request saved by hand. It has no tracker status; Heimdall shows this instead.",
      ),
    ],
  },
  {
    key: "heimdall-compat",
    noun: "Heimdall",
    concept: "heimdall",
    values: [
      v(
        "in_review",
        "In review",
        "Waiting for your review. Heimdall accepts this spelling as well as review.",
      ),
      v(
        "delivered",
        "Delivered",
        "A finished delivery. Heimdall treats any status starting with delivered as delivered.",
      ),
    ],
  },
  {
    key: "escalation",
    noun: "escalation",
    concept: "escalation",
    values: [
      v(
        "block",
        "Block",
        "The task stopped. The run cannot finish until you decide what to do with it.",
      ),
      v("ask", "Ask", "The task stopped and asks you to decide: retry, skip, replan or abort."),
      v("replan", "Replan", "The task asked for a new plan. The run becomes Replan requested."),
    ],
  },
  {
    key: "escalation-answer",
    noun: "escalation answer",
    concept: "escalation",
    values: [
      v("retry", "Retry", "Run the task again."),
      v("skip", "Skip", "Leave the task out. The rest can still be delivered."),
      v(
        "replan",
        "Replan",
        "Ask for a new plan. This run stops; a revised plan continues the work.",
      ),
      v("abort", "Abort", "Cancel the whole run."),
    ],
  },
  {
    key: "steward-decision",
    noun: "steward decision",
    concept: "steward",
    values: [
      v(
        "pending",
        "Waiting for you",
        "The steward has a recommendation. Accept, change or reject it.",
      ),
      v("accepted", "Accepted", "You accepted the recommendation and it was carried out."),
      v(
        "changed",
        "Changed",
        "You accepted it with a different value, and your value was carried out.",
      ),
      v("rejected", "Rejected", "You rejected the recommendation. Nothing was done."),
      v("applied", "Applied automatically", "Automatic mode carried it out without asking you."),
      v("rolled_back", "Rolled back", "It was carried out and then undone."),
      v(
        "expired",
        "Expired",
        "Its subject went away before anyone decided (answered, resolved or approved elsewhere).",
      ),
    ],
  },
  {
    key: "steward-mode",
    noun: "steward mode",
    concept: "steward-mode",
    values: [
      v("off", "Off", "The steward makes no recommendations of this type."),
      v("recommend", "Recommend", "The steward recommends; you decide. The default."),
      v(
        "auto",
        "Automatic",
        "The steward acts by itself when confident enough. Never allowed for approvals.",
        "It applies only when at least 0.6 confident, and for escalations only retry and skip, at most one automatic retry per task.",
      ),
    ],
  },
  {
    key: "steward-state",
    noun: "steward",
    concept: "steward",
    values: [
      v("running", "Running", "The steward is watching and making recommendations."),
      v(
        "paused",
        "Paused",
        "The steward makes no new recommendations. Your own decisions still work.",
      ),
    ],
  },
  {
    key: "steward-outcome",
    noun: "decision outcome",
    concept: "decision-outcome",
    values: [
      v(
        "passed",
        "Passed",
        "What the decision led to later succeeded, for example the retried task completed.",
      ),
      v(
        "failed",
        "Failed",
        "What the decision led to later failed, for example the task escalated again.",
      ),
      v("reworked", "Reworked", "Changes were requested on the delivery that followed."),
      v("unknown", "Not known yet", "No later result has been recorded."),
    ],
  },
  {
    key: "steward-guidance",
    noun: "steward guidance",
    concept: "steward-guidance",
    values: [
      v(
        "proposed",
        "Proposed",
        "A rule the steward learned from your corrections. Accept or reject it.",
      ),
      v("accepted", "Accepted", "You accepted the rule. It is now knowledge the steward uses."),
      v("rejected", "Rejected", "You rejected the rule. It is not proposed again."),
    ],
  },
  {
    key: "fg-link",
    noun: "Feedback Graph link",
    concept: "feedback-graph",
    values: [
      v("auto", "Linked automatically", "Feedback Graph tracks this project's repository path."),
      v("override", "Linked by you", "You named the Feedback Graph project for this repository."),
      v(
        "none",
        "Not linked",
        "Feedback Graph does not track this repository. No lessons are used.",
      ),
    ],
  },
  {
    key: "fg-connection",
    noun: "Feedback Graph connection",
    concept: "feedback-graph",
    values: [
      v("connected", "Connected", "Sindri reaches Feedback Graph and its token is accepted."),
      v("disabled", "Off", "Feedback Graph is configured but turned off in Settings."),
      v(
        "not_configured",
        "Not configured",
        "No Feedback Graph URL is set. Everything works, without lessons.",
      ),
      v(
        "unreachable",
        "Unreachable",
        "Sindri cannot reach Feedback Graph or the token is refused.",
      ),
      v("not_checked", "Not checked", "Sindri has not checked the connection yet."),
      v("unknown", "Unknown", "Sindri has not reported Feedback Graph status."),
    ],
  },
  {
    key: "approvals",
    noun: "approvals",
    concept: "approval-pairing-code",
    values: [
      v(
        "locked",
        "Approvals locked",
        "Approving needs the pairing code from the terminal. Enter it once per session.",
      ),
      v(
        "unlocked",
        "Approvals unlocked",
        "You entered the pairing code. You can approve until you sign out or Sindri restarts.",
      ),
    ],
  },
  // ---------- Shared ----------
  {
    key: "connection",
    noun: "connection",
    concept: "event-stream",
    values: [
      v("live", "Live", "Connected. Changes appear as they happen."),
      v(
        "connecting",
        "Connecting",
        "Opening the connection. Data appears once the first snapshot arrives.",
      ),
      v(
        "reconnecting",
        "Reconnecting",
        "The connection dropped and is retrying. What you see may be out of date.",
      ),
      v("disconnected", "Disconnected", "No connection. The data shown is the last known state."),
    ],
  },
  // ---------- Mimir ----------
  {
    key: "mission",
    noun: "mission",
    concept: "mission",
    values: [
      v("draft", "Draft", "Created, not started. No tasks are dispatched."),
      v("active", "Active", "Started. Mimir dispatches ready tasks to agents."),
      v("paused", "Paused", "No new tasks are dispatched. Agents already working are not paused."),
      v("completed", "Completed", "Every task finished."),
      v("cancelled", "Cancelled", "Stopped on purpose. No more tasks run."),
      v("failed", "Failed", "Mimir gave up on the mission. No more tasks run."),
    ],
  },
  {
    key: "task",
    noun: "task",
    concept: "task",
    values: [
      v("pending", "Waiting on inputs", "Its dependencies have not finished yet."),
      v("ready", "Ready", "Its dependencies are done. Waiting for a free agent."),
      v(
        "leased",
        "Assigned",
        "Handed to one agent session, which is starting on it.",
        "A lease has an expiry; a lease that expires while the task is still leased or running shows as stuck.",
      ),
      v("running", "Running", "An agent is working on it in its own worktree."),
      v("verifying", "Verifying", "The agent finished. Brokkr is checking the result."),
      v("completed", "Completed", "Done and verified."),
      v(
        "blocked",
        "Blocked",
        "Cannot continue: waiting for an approval, a budget raise, or a human decision. The reason is shown.",
      ),
      v("failed", "Failed", "It failed and has no retries left."),
      v("cancelled", "Cancelled", "Stopped on purpose, or skipped by a human."),
    ],
  },
  {
    key: "session",
    noun: "agent session",
    concept: "agent-session",
    values: [
      v("requested", "Requested", "Mimir asked the runtime to start this agent."),
      v("starting", "Starting", "The agent is starting up."),
      v("idle", "Idle", "Started and waiting for input."),
      v("running", "Working", "The agent is working."),
      v("waiting", "Waiting", "The agent is waiting, for example for a tool or a permission."),
      v("blocked", "Blocked", "The agent cannot continue without help."),
      v("stopping", "Stopping", "The agent is being stopped."),
      v("stopped", "Stopped", "The agent was stopped."),
      v("completed", "Finished", "The agent finished its work."),
      v("failed", "Failed", "The agent ended with an error."),
      v("unknown", "Unknown", "The runtime has not reported a state. Mimir does not guess."),
    ],
  },
  {
    key: "crew",
    noun: "crew",
    concept: "crew",
    values: [
      v(
        "configured",
        "Set up",
        "The crew exists with its roles. No agent of it is working right now.",
      ),
      v("running", "Working", "Agents of this crew are working on tasks."),
      v("stopped", "Stopped", "The crew was stopped."),
      v("archived", "Archived", "Kept for history only."),
    ],
  },
  {
    key: "approval",
    noun: "approval",
    concept: "approval",
    values: [
      v(
        "pending",
        "Waiting for you",
        "An agent wants to do something that needs a human yes or no.",
      ),
      v("approved", "Approved", "A human allowed it."),
      v("rejected", "Rejected", "A human refused it, or policy refused it at once."),
      v("expired", "Expired", "Nobody decided in time, or the run was cancelled first."),
      v("cancelled", "Cancelled", "The request was withdrawn."),
    ],
  },
  {
    key: "attention",
    noun: "attention item",
    concept: "needs-attention",
    values: [
      v("approval", "Approval needed", "An agent waits for your yes or no."),
      v("blocked", "Blocked task", "A task cannot continue. The reason is shown."),
      v(
        "stuck",
        "Stuck task",
        "The task's lease expired while it was still assigned or running. The agent may have died.",
      ),
      v("budget", "Budget alert", "A budget passed its warning level or ran out."),
      v("unknown", "Agent state unknown", "The runtime stopped reporting an agent's state."),
    ],
  },
  {
    key: "budget-alert",
    noun: "budget alert",
    concept: "crew-budget",
    values: [
      v(
        "warning",
        "Budget warning",
        "Usage passed the warning level (80% by default). Work continues.",
      ),
      v(
        "exceeded",
        "Budget exceeded",
        "The budget ran out. Ready tasks of this crew or mission are blocked.",
      ),
    ],
  },
  {
    key: "blocked-reason",
    noun: "blocked reason",
    concept: "budget-exceeded",
    values: [
      v(
        "budget_exceeded",
        "Budget exceeded",
        "The task was parked because its crew or mission budget ran out.",
      ),
      v(
        "budget_uncertain",
        "Budget unknown",
        "The task was parked because usage cannot be measured and the budget says block when unknown.",
      ),
    ],
  },
  {
    key: "budget-enforce",
    noun: "budget enforcement",
    concept: "crew-budget",
    values: [
      v("hard", "Hard", "When the budget runs out, ready tasks are blocked."),
      v("soft", "Soft", "When the budget runs out, Mimir only warns."),
    ],
  },
  {
    key: "budget-on-unknown",
    noun: "unknown usage",
    concept: "crew-budget",
    values: [
      v("allow", "Allow", "If usage cannot be measured, work continues."),
      v("block", "Block", "If usage cannot be measured, tasks are blocked."),
    ],
  },
  {
    key: "provenance",
    noun: "provenance",
    concept: "provenance",
    values: [
      v("observed", "Observed", "Reported directly by the runtime or Mimir. The most reliable."),
      v("derived", "Derived", "Computed by Mimir from observed events."),
      v("summarized", "Summarized", "Written by a model. A summary, not an observation."),
    ],
  },
  {
    key: "usage",
    noun: "usage source",
    concept: "usage-source",
    values: [
      v("measured", "Measured", "Token or cost numbers reported by the agent itself."),
      v("estimated", "Estimated", "Numbers Mimir estimated. Treat as approximate."),
      v("unavailable", "Unavailable", "No usage reported for this sample. Not counted as zero."),
    ],
  },
  {
    key: "worktree",
    noun: "worktree",
    concept: "worktree",
    values: [
      v("active", "Active", "The task's private git working copy exists."),
      v("conflicted", "Conflicted", "Git reported a conflict in this working copy."),
      v("removed", "Removed", "Mimir cleaned the working copy up."),
    ],
  },
  {
    key: "command",
    noun: "command",
    concept: "mimir",
    values: [
      v("accepted", "Accepted", "Mimir accepted the request and will carry it out."),
      v("running", "Running", "Mimir is carrying out the request."),
      v("succeeded", "Done", "The request was carried out."),
      v("failed", "Failed", "The request was tried and failed."),
      v("rejected", "Refused", "Mimir refused the request, for example by policy."),
    ],
  },
  {
    key: "policy",
    noun: "policy decision",
    concept: "policy",
    values: [
      v("allow", "Allowed", "The action is on the allowlist and runs without asking."),
      v("deny", "Denied", "The action is never allowed."),
      v("require_approval", "Needs approval", "The action waits for a human yes or no."),
    ],
  },
  // ---------- Heimdall ----------
  {
    key: "source",
    noun: "source",
    concept: "heimdall",
    values: [
      v("connected", "Connected", "Heimdall reads this service (Mimir or Sindri) without errors."),
      v(
        "disconnected",
        "Disconnected",
        "The last read failed. Heimdall shows the previous snapshot.",
      ),
    ],
  },
  {
    key: "operator",
    noun: "session",
    concept: "operator-controls",
    values: [
      v(
        "read_only",
        "Read-only",
        "You can look but not act. Unlock operator controls with the operator code.",
      ),
      v(
        "unlocked",
        "Operator unlocked",
        "You can act. Every action needs a reason and is audited.",
      ),
    ],
  },
  {
    key: "pairing",
    noun: "Sindri pairing",
    concept: "approval-pairing-code",
    values: [
      v("paired", "Paired", "Heimdall holds Sindri's pairing code, so it can pass on approvals."),
      v(
        "not_paired",
        "Not paired",
        "Approvals of specs, plans and exports need pairing first, under Connections.",
      ),
    ],
  },
  {
    key: "overview-attention",
    noun: "operator attention",
    concept: "needs-attention",
    values: [
      v("clear", "Clear", "Nothing needs you right now."),
      v("needs_attention", "Needs attention", "Something is blocked, failed or waiting on you."),
    ],
  },
  {
    key: "notification",
    noun: "notification",
    concept: "heimdall",
    values: [
      v("error", "Problem", "Something failed or a service is unavailable."),
      v("warning", "Needs a decision", "Something waits for you, such as an approval or a review."),
      v("success", "Done", "Something finished, such as a delivery."),
    ],
  },
  {
    key: "agent",
    noun: "agent",
    concept: "agent-session",
    values: [
      v("busy", "Busy", "The agent is in the middle of a turn."),
      v("lost", "Lost", "The runtime lost the agent's session. It will not report again."),
    ],
  },
  {
    key: "fleet-worker",
    noun: "fleet worker",
    concept: "worker",
    values: [
      v("running", "Accepting work", "The worker is healthy and takes new tasks."),
      v("paused", "Draining", "The worker takes no new tasks. Running sessions continue."),
      v("unknown", "Not observed", "Heimdall could not read the worker. It may still be running."),
    ],
  },
  {
    key: "supervisor",
    noun: "supervisor",
    concept: "supervisor",
    values: [
      v("ready", "Ready", "The supervisor receives and passes on control messages."),
      v("held", "Held", "A human put it on hold. Its messages wait."),
      v(
        "waiting_external",
        "Waiting on something outside",
        "It waits for an outside event. A reason is recorded.",
      ),
      v("blocked", "Blocked", "It cannot continue. A reason is recorded."),
    ],
  },
  {
    key: "supervisor-message",
    noun: "supervisor message",
    concept: "supervisor",
    values: [
      v("pending", "Queued", "Waiting to be delivered."),
      v("dispatching", "Delivering", "Being delivered right now."),
      v("awaiting_approval", "Needs approval", "An operator must allow it before it is delivered."),
      v("done", "Done", "Delivered and finished."),
      v("failed", "Failed", "Delivery failed, or an operator refused it."),
      v(
        "uncertain",
        "Uncertain",
        "The supervisor's lease ran out mid-delivery. Inspect the session, then mark it done or failed.",
      ),
    ],
  },
  {
    key: "project",
    noun: "project",
    concept: "project",
    values: [
      v("active", "Active", "The project is in use."),
      v("archived", "Archived", "Hidden from daily lists. Restore it to use it again."),
    ],
  },
  {
    key: "stage",
    noun: "pipeline stage",
    concept: "pipeline",
    values: [
      v("intake", "Intake", "A request was saved and has no spec yet."),
      v("specification", "Specification", "A spec is being drafted or reviewed."),
      v("planning", "Planning", "A plan is being proposed or reviewed."),
      v("ready", "Ready", "Approved and waiting for an agent."),
      v("building", "Building", "Agents are working on it."),
      v("verification", "Verification", "Brokkr is checking the result."),
      v("review", "Review", "Waiting for review or a human decision."),
      v("completed", "Completed", "The work finished."),
      v("delivery", "Delivery", "A delivery exists for it."),
    ],
  },
  // ---------- Skidbladnir ----------
  {
    key: "skid-worker",
    noun: "worker",
    concept: "worker",
    values: [
      v(
        "requested",
        "Requested",
        "The launch was recorded. The provider has not started the machine yet.",
      ),
      v(
        "provisioning",
        "Launching",
        "The launch was sent. Waiting for the cloud to report the machine.",
      ),
      v("starting", "Starting", "The machine is booting."),
      v("running", "Running", "Up and usable. Its lifetime clock is counting."),
      v("stopping", "Stopping", "Shutting down. Its disk is kept."),
      v("stopped", "Stopped", "Shut down but not deleted. Start it again or terminate it."),
      v("terminating", "Terminating", "Being deleted."),
      v("terminated", "Terminated", "Deleted. Its history and collected files stay."),
      v("failed", "Failed", "The launch or a lifecycle step failed. See its history."),
      v(
        "unknown",
        "Unknown",
        "The state cannot be confirmed. It keeps its slot until the cloud shows it is gone.",
      ),
    ],
  },
  {
    key: "ssm-command",
    noun: "remote command",
    concept: "ssm",
    values: [
      v("Pending", "Queued", "Sent, not started on the worker yet."),
      v("InProgress", "Running", "Running on the worker."),
      v("Delayed", "Delayed", "The worker could not take it yet. It will be retried."),
      v("Success", "Succeeded", "Finished with exit code 0."),
      v("Failed", "Failed", "Finished with an error or a non-zero exit code."),
      v("Cancelling", "Cancelling", "A cancel was sent and is being processed."),
      v("Cancelled", "Cancelled", "Cancelled before it finished."),
      v("TimedOut", "Timed out", "Did not finish in time."),
    ],
  },
  {
    key: "terminal",
    noun: "terminal",
    concept: "ssm",
    values: [
      v("active", "Open", "An interactive shell session on the worker is open."),
      v("closed", "Closed", "The shell session ended."),
    ],
  },
  {
    key: "skid-mode",
    noun: "fleet mode",
    concept: "simulation-mode",
    values: [
      v("simulation", "Simulation", "Workers are simulated. No machines, no cost."),
      v("aws", "Cloud", "Workers are real cloud machines that cost money until terminated."),
    ],
  },
];

/**
 * Which groups each app shows, in lookup order: a bare value resolves to the first group that has
 * it, so the most common meaning comes first (a Sindri `failed` is a run before it is a gate).
 */
export const APP_GROUPS: Readonly<Record<AppId, readonly string[]>> = {
  sindri: [
    "run",
    "spec",
    "plan",
    "task",
    "delivery",
    "requirement",
    "export",
    "approval",
    "gate",
    "brokkr-verdict",
    "brokkr-check",
    "review",
    "review-verdict",
    "severity",
    "escalation",
    "escalation-answer",
    "knowledge-proposal",
    "knowledge",
    "knowledge-decision",
    "intake-sync",
    "open-question",
    "blocked-reason",
    "steward-decision",
    "steward-mode",
    "steward-state",
    "steward-outcome",
    "steward-guidance",
    "fg-link",
    "fg-connection",
    "approvals",
    "connection",
    "work-kind",
    "research-decision",
    "review-post",
  ],
  mimir: [
    "mission",
    "task",
    "session",
    "crew",
    "approval",
    "attention",
    "budget-alert",
    "blocked-reason",
    "budget-enforce",
    "budget-on-unknown",
    "provenance",
    "usage",
    "worktree",
    "command",
    "policy",
    "connection",
  ],
  heimdall: [
    "run",
    "task",
    "mission",
    "session",
    "agent",
    "crew",
    "approval",
    "spec",
    "plan",
    "delivery",
    "requirement",
    "export",
    "gate",
    "brokkr-verdict",
    "escalation",
    "steward-decision",
    "steward-mode",
    "steward-state",
    "steward-outcome",
    "fg-link",
    "fg-connection",
    "provenance",
    "usage",
    "connection",
    "source",
    "operator",
    "pairing",
    "overview-attention",
    "notification",
    "fleet-worker",
    "supervisor",
    "supervisor-message",
    "project",
    "stage",
    "intake",
    "intake-sync",
    "open-question",
    "heimdall-compat",
    "work-kind",
    "research-decision",
    "review-post",
    "review-verdict",
    "severity",
  ],
  skidbladnir: ["skid-worker", "ssm-command", "terminal", "skid-mode", "connection"],
};
