# Operator guide

What you do as the person running the factory, and what each control really does.

## Sign in and unlock

The factory uses separate secrets on purpose. The terminal that started it prints them all.

| Secret                 | Used for                                                                                                                       | Where                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Sindri access token    | signing in to Sindri and its API                                                                                               | `sindri token show`, or _Access token_ in the launcher output |
| Approval pairing code  | approving specs, plans, local exports, knowledge and steward mode changes; accepting or rejecting research; posting PR reviews | printed when Sindri starts; changes on every start            |
| Mimir access token     | signing in to Mimir                                                                                                            | `mimir token show`                                            |
| Heimdall access token  | signing in to Heimdall                                                                                                         | printed when Heimdall starts                                  |
| Heimdall operator code | unlocking actions in Heimdall                                                                                                  | printed when Heimdall starts                                  |

- **Sindri**: you are signed in with the token. The bottom bar says _Read-only_ until you enter the pairing code, either when you first approve something or from the session item in the bottom bar. It then says _Operator unlocked_ for this browser tab; **Lock approvals** in the same place locks it again. Five wrong codes lock approvals until Sindri restarts.
- **Heimdall**: after sign-in the session is **Read-only**. Click the session item in the bottom bar (or open {{screen:heimdall.connections}} → _Access_), enter the operator code (**Unlock controls**), then pair Sindri with its pairing code. Without pairing you can still act on Mimir (for example raise a budget), but not approve Sindri specs, plans or exports, or change the steward.
- **Mimir**: the token is enough; the bottom bar always says _Operator unlocked_. Approvals for runs that belong to Sindri still go through Sindri's pairing code.

Never give the pairing code or the operator code to an agent or paste them into a ticket.

## Approvals

An approval is a human yes or no on something an agent wants to do that Mimir's policy does not allow by itself (for example a command outside the allowlist). Agents can never approve, and nobody approves their own request.

- Where: Sindri {{screen:sindri.needs-you}} → _Approvals awaiting you_, the run's {{screen:sindri.run-detail}}, Heimdall {{screen:heimdall.quality-approvals}}, Mimir {{screen:mimir.reviews}}.
- While an approval waits, the run shows [Needs you](/docs/statuses#needs-you-run-status) and the task is [Blocked](/docs/statuses#blocked-task-status).
- Read the action and the reason. Approve only what you would run yourself.
- Many approvals for a command you trust? Add it to the Mimir project's allowed commands.

Spec, plan and export approvals are different: they are your sign-off on the work itself, and always need the pairing code. So do accepting or rejecting a research document and posting a PR review.

## Escalations

A task escalates when it fails more times than the plan's retry limit allows, or when its budget runs out. The plan decides what happens next for each task:

- **block**: the task stops; the run becomes [Blocked](/docs/statuses#blocked-run-status) once nothing else can move.
- **ask**: the task stops and asks you; the run becomes [Needs you](/docs/statuses#needs-you-run-status).
- **replan**: the run becomes [Replan requested](/docs/statuses#replan-requested-run-status).

Answer in {{screen:sindri.needs-you}} → _Escalations_, always with a reason:

| Answer     | Effect                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------- |
| **retry**  | Runs the task again. Counts as an attempt, except after a budget block.                                              |
| **skip**   | Leaves the task out. If everything else is verified, the rest is delivered.                                          |
| **replan** | Stops this run. Revise the plan in {{screen:sindri.plans}}, approve and execute it; the old run closes as cancelled. |
| **abort**  | Cancels the run.                                                                                                     |

The steward usually has a recommendation. In Automatic mode it may answer retry or skip by itself, at most one automatic retry per task.

## Budgets

Each plan task has a token budget (defaults by role: implementer 1M; reviewer, security reviewer, lead and investigator 400k; QA 500k; docs 300k). Sindri sends Mimir one hard budget per crew: the sum of its tasks' budgets. Mimir warns at 80%. At 100% it stops dispatching that crew's tasks and parks them as blocked with _budget exceeded_. Sindri then shows an escalation with the numbers (`tokens used/limit`).

To continue, press **Raise budget** and set a higher limit, then answer retry if the escalation is still open:

- **Heimdall**: on the task in {{screen:heimdall.overview}} → _Needs you_, in {{screen:heimdall.quality-approvals}}, or in the task's inspector. Needs operator controls unlocked; the change is sent with your reason and recorded in the audit history.
- **Mimir**: on {{screen:mimir.mission-detail}}, in the blocked-tasks callout or the task's row.
- Sindri cannot raise a budget itself; its budget alert links to both.

The API command still works as a fallback. Step by step: [Budget blocked](/docs/troubleshooting#budget-blocked).

Usage marked _estimated_ or _unavailable_ is not exact. _Unavailable_ is not zero.

## Watching a run

- Sindri {{screen:sindri.run-detail}} is the authority on the run's status.
- Mimir {{screen:mimir.mission-detail}} and {{screen:mimir.agent}} show each agent's work. **Live output** opens an agent with its terminal following; the **Follow** switch turns that on or off.
- Heimdall shows everything together and keeps notifications. **Watch live** (on {{screen:heimdall.overview}}, {{screen:heimdall.crews-agents}} and a run's inspector) opens an agent's live session.

To stop a run, use **Cancel run** in Sindri (or the run's record in Heimdall). It cancels the Mimir mission, closes its open Needs you items and expires pending approvals.

## Export a delivery

1. Open the delivery in {{screen:sindri.delivery-detail}} once the run is [Verified, awaiting review](/docs/statuses#verified-awaiting-review-run-status).
2. Read the report: requirements, gates, tests, findings, limitations.
3. Press **Export local result**. It is refused until every task's quality gate passed. If **Approve local export** buttons appear (one per task), press each (pairing code).
4. Copy or download the patch. In your project folder run the _apply_ command shown (`git apply --check result.patch && git apply result.patch`). The _undo_ command reverses it.
5. Commit, push and merge as you normally would. The factory never merges or deploys.

If the patch does not apply, see [Merge conflict](/docs/troubleshooting#merge-conflict).

## Request changes

1. On the delivery, write what should change under **Request changes**. Plain words are fine.
2. Sindri drafts a new spec tied to this delivery's verified result and opens it.
3. Approve that spec, propose and approve its plan, and execute it.
4. The new delivery has a **full patch** and a **follow-up patch**. If you already applied the earlier delivery, apply only the follow-up.

Only one unapproved change request per delivery at a time.

## Research and PR reviews

Not every request is a code change. In the {{screen:sindri.inbox}} (or Heimdall's {{screen:heimdall.new-work}}), _Kind of work_ offers **Research** and **Review a PR** next to **Change**. They run through the same spec, plan and run, but their agents only read, and they end differently:

- **Research** ends with a cited document you **Accept** or **Reject…** with a reason, or follow up with **Ask a follow-up…**. **Copy as Markdown** leaves out private lessons. See [Research questions](/docs/research).
- **PR review** ends with a review draft you edit on the delivery, preview with its leak check, and post once with **Post review to GitHub**. Heimdall shows it read-only; posting happens in Sindri. See [PR reviews](/docs/pr-reviews).

Give the agents your standards as **skills** (imported `SKILL.md` folders, {{screen:sindri.settings}} → _Skills_) and **notes**: standing ones per project in {{screen:sindri.project-settings}} → _Guidance_, or per request on the form. See [Skills and guidance](/docs/research#skills-and-guidance).

## Autonomy and the steward

The steward recommends; you decide. Per decision type the mode is:

- **Off**: no recommendations.
- **Recommend** (default): recommendations wait for you.
- **Automatic**: it acts when at least 0.6 confident. Never for spec or plan approval.

Accepting performs the action exactly as if you had done it. **Change** performs your value instead. **Reject** does nothing. **Roll back** undoes an applied answer or rework suggestion (not escalations, and not once later work was approved on top). Notes in {{screen:sindri.autonomy}} are read before every recommendation. When you correct the steward the same way three times, it proposes a guidance rule for you to accept.

Pause the steward in Sindri's {{screen:sindri.autonomy-all}} or with **Pause steward** in Heimdall's {{screen:heimdall.autonomy-all}} (operator unlocked and Sindri paired); resume it the same way. Your own decisions keep working while it is paused.

## Export data

{{screen:sindri.settings}} → _Export_ downloads a zip with Sindri's database and settings, without secrets. Mimir's event log can be exported with `mimir export`; {{screen:mimir.activity}} exports the shown events as JSON.

## Delete a project's data

{{screen:sindri.project-settings}} → _Danger zone_ → **Delete project data** removes the project's index, inbox, specs and knowledge from Sindri. The repository is not touched. Erasing recorded evidence as well needs a second confirmation (`ERASE EVIDENCE`).
