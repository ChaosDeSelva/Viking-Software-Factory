# Steward

The steward is Sindri's learning loop. It watches what happens in the factory, recommends a
decision whenever a person would otherwise have to make one, records what it looked at, why it
recommended what it did and how sure it was, and then records what became of it. The operator
accepts, changes or rejects each recommendation. Per decision type the operator can let the
steward apply its recommendations itself once its record is good. Approvals are never automatic.

"Learning" here means retrieval and operator-approved guidance, not model training: every
recommendation retrieves operator notes, similar past decisions with their outcomes, approved
knowledge (including guidance learned from earlier corrections) and the project's Feedback Graph
lessons.

The code is `packages/steward` (store, producers, learning, loop) and
`apps/server/src/routes/steward.ts` with `apps/server/src/steward-world.ts` (how the steward reads
and acts on the rest of Sindri). The routes are listed in [api.md](api.md#steward).

## Decision types

| Type                 | Subject                                                        | Recommendation `value`                                   | Auto mode                                        |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------ |
| `spec.answer`        | an open question on the latest draft or review version of a spec | the answer text                                          | applies the answer; reversible                   |
| `escalation.resolve` | a task the run escalated, while its execution is open           | `retry`, `skip`, `replan` or `abort`; `detail` is the reason | applies `retry` and `skip` only; not reversible  |
| `rework.suggest`     | a verified delivery whose quality assessment has run (14 days)  | `accept` (as is), or the change request text              | drafts the change request; reversible            |
| `spec.approve`       | the latest version of a spec, in review                         | `approve` or `hold`; `detail` says what must change        | never (`autoAllowed: false`)                     |
| `plan.approve`       | the latest version of a plan, proposed (draft) or in review     | `approve` or `hold`                                       | never (`autoAllowed: false`)                     |

How each is produced:

* `spec.answer`: one decision per open question. When the drafter left a recommendation and
  rationale on the question, the steward reuses them (no provider call) and adds what its
  learning inputs show, unless a similar past answer was changed or rejected by the operator: then
  it asks the provider, giving it the drafter's suggestion as one more input.
* `escalation.resolve`: one decision per escalation and attempt count (a task that escalates
  again after a retry gets a new decision). The provider sees the escalation reason, attempts,
  task status and the task's gate failures.
* `rework.suggest`: a delivery with no review findings and only passing gates is recommended
  `accept` without a provider call. Otherwise the provider sees the review findings and the gate
  failures and advisories. Deliveries with a rework already requested are skipped.
* `spec.approve` / `plan.approve`: hard blockers (blocking open questions, no acceptance
  criteria, flagged instructions in the spec's sources; an unapproved spec or no tasks for a plan)
  are recommended `hold` without a provider call. Otherwise the provider weighs the rest.

Provider calls use the configured LLM provider (the same one the Director and planner use), with a
recommend-only prompt and structured output (`value`, `detail`, `reasoning`, `confidence`). Every
input text is untrusted data: it is redacted for secrets and injection-like instructions and put
in nonce-delimited data blocks, exactly like ticket text in a spec draft. Calls that measured
token usage are recorded as Director runs with purpose `steward_<type>` (cost accounting).

## Decisions

A decision has the shape in the contract (`id, projectId, type, subject, inputs[],
recommendation, reasoning, confidence, mode, status, outcome, reversible, notes[], createdAt,
decidedAt`) plus, additively, `appliedValue` (what was applied), `error` (the last failure
producing or applying it) and, on `GET /v1/steward/decisions/:id` only, `history[]`.

Statuses:

| Status        | Meaning                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `pending`     | waiting for the operator (or for auto mode)                                |
| `accepted`    | the operator accepted the recommendation; it was performed                 |
| `changed`     | the operator accepted it with a different value; that value was performed  |
| `rejected`    | the operator rejected it; nothing was performed                            |
| `applied`     | auto mode performed it                                                     |
| `rolled_back` | it was performed and then undone                                           |
| `expired`     | its subject went away before anyone decided (answered, resolved, approved elsewhere) |

`inputs[]` lists everything the recommendation considered, the subject first (`spec`, `question`,
`run`, `gate`, `review`), then the learning inputs: `note`, `past_decision`, `guidance` (approved
knowledge entries, accepted steward guidance among them) and `lesson` (Feedback Graph, ref
`fg:<lessonId>`).

The decision log is append-only: a decision row is only ever changed together with an entry in
`steward_decision_history` (who, what, the changed fields and the previous status), in one
transaction. History rows cannot be updated (a trigger refuses it).

Idempotency: a type and subject never produce a second decision (`UNIQUE (type, dedupe_key)`),
and never two pending ones (`UNIQUE (type, subject_id) WHERE status = 'pending'`). A rejected or
rolled-back subject is not recommended on again.

## Accepting, rejecting, rolling back

* Accepting performs the value: the Director's answer (as the answer route does), the delivery
  loop's escalation resolution (as the escalation route does, as the execution's consumer), the
  server's own rework route, or the server's own approve routes. Accepting `spec.approve` or
  `plan.approve` needs `X-Sindri-Approval`, exactly like approving directly; accepting a plan that
  is still a draft submits it first. Accepting `hold` or `accept` (as is) performs nothing.
* An edited value counts as `changed`. For `escalation.resolve` and the approval types it must be
  one of the allowed values (422 otherwise).
* If performing fails, the decision stays `pending`, the failure is in its history, and the error
  is returned.
* Rollback needs a reason and is 409 `invalid_state` when the decision was not applied or is not
  reversible:
  * `spec.answer`: the question is reopened (at its old position) and the constraint the answer
    added is removed, on a new version of the spec lineage (versions are immutable history; the
    specs package only supports new versions). Refused once the answered version or any later
    one was approved or has a plan.
  * `rework.suggest`: the drafted change request's draft and review versions become `superseded`
    and its rework link is removed, so the delivery takes a new change request. Refused once a
    version was approved.
  * `escalation.resolve`: never reversible (a retry or skip has already changed the run).

## Modes

Per type and global: `off` (nothing is produced), `recommend` (default) or `auto`. Changing a mode
needs the approval factor. `auto` on `spec.approve` or `plan.approve` is 422. In auto mode the
steward applies a recommendation when it is at least 0.6 confident (`steward.autoMinConfidence`)
and, for escalations, only `retry` and `skip`, with at most one automatic retry per task (a task
that escalates again goes to the operator); anything else stays a recommendation (its `mode`
becomes `recommend`, and the history says why). An automatic apply that fails is likewise left to
the operator and not retried on later ticks. Auto mode never applies an approval.

## Learning

Before each recommendation the steward retrieves:

1. the latest 8 notes of the project (decision notes included) and the latest 5 global notes;
2. up to 5 past decisions of the same type in the project, ranked by word overlap (Jaccard over
   lower-case words) with the subject, each with what the operator did and its outcome;
3. up to 8 Feedback Graph lessons for the project (`services.feedbackGraph.lessonsFor`; none when
   Feedback Graph is not configured or unreachable; Feedback Graph is only read);
4. the project's approved knowledge entries: accepted steward guidance always, other entries by
   word overlap (up to 8).

Outcomes: once applied, a decision's later result is recorded (`outcome`):

| Type                 | `passed`                                       | `failed`                                         | `reworked`                                |
| -------------------- | ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `escalation.resolve` | the retried task completed, or the run verified | the task escalated again, or the run ended cancelled/failed | |
| `spec.answer`, `spec.approve` | a run of the spec lineage verified    | its runs all ended failed or cancelled          | changes were requested on that delivery   |
| `plan.approve`       | a run of the plan verified                      | its runs all ended failed or cancelled          | changes were requested on that delivery   |
| `rework.suggest`     | the change request's run verified               | its runs ended failed or cancelled              | `accept` was recommended and changes were requested after all |

Guidance: when the operator has changed or rejected recommendations of one type in one project
three times with a consistent correction, the steward proposes guidance for the operator to
approve (`GET /v1/steward/guidance`). Consistent means: the same change of value (for example
`retry` to `skip`), rejections of the same value, or, for free-text answers, edits that keep
adding the same words. Accepting a proposal (approval factor) records the corrections as task
evidence and a valid knowledge entry citing it, the same way delivery knowledge proposals become
knowledge; later recommendations retrieve it as `guidance`. Each rule is proposed once.

## The loop

* Event driven: execution notices (escalated, status changed, inbox item, replan requested,
  quality assessed) and successful mutations under `/v1/director`, `/v1/specs`, `/v1/plans`,
  `/v1/executions` and `/v1/deliveries` nudge it (250 ms coalescing).
* A periodic tick every 30 s (`steward.tickMs`) catches anything missed, including everything that
  happened while the server was down.
* Each tick: find subjects, expire pending decisions whose subject is gone, create decisions,
  fill recommendations (at most 10 provider calls per tick), auto-apply, record outcomes.
* Ticks are serialized, so provider calls run one at a time. A provider failure is recorded on
  the decision (`error`, a steward note, history `recommend_failed`); the decision stays
  `pending` and is retried on later ticks, at most 3 attempts. Nothing the loop does can crash the
  server.
* `POST /v1/steward/pause` stops all of this until `resume`; the paused state survives restarts.
  Operator actions (accept, reject, rollback, notes) work while paused.
* The loop starts when the server is ready. It does not start under `sindri demo`
  (`resumeOnReady: false`) or when the server was given a fixed provider or director (tests),
  unless `steward.autoStart` says so.

## Data and deletion

Tables (namespace `steward`): `steward_decisions`, `steward_decision_history`, `steward_notes`,
`steward_modes`, `steward_state`, `steward_guidance`. Deleting a project's data removes its
decisions, their history and notes, its notes and its guidance proposals (foreign keys to
`projects`, a knowledge purge hook and the server's delivery purge). Global notes and modes stay.
