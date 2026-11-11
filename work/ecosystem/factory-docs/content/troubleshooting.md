# Troubleshooting

Start with the bottom bar: the connection status and the session state explain most surprises. For Sindri and Mimir, `sindri doctor` and `mimir doctor` name most setup problems.

## Token rejected

The app says the server rejected the token, or the API answers 401.

- Copy the token again from its source, without spaces: `sindri token show`, `mimir token show`, or the _Heimdall access token_ line printed at start.
- Each app has its own token. A Sindri token does not work in Mimir or Heimdall.
- Heimdall prints a new token when it starts unless `HEIMDALL_TOKEN` is set. After a restart, use the new one. Heimdall sessions also end after 12 hours, and repeated wrong attempts are slowed down.
- A 403 instead of 401 means the address is not allowed (wrong host name or port), not a bad token. Open the app at `127.0.0.1` on its usual port.

## Pairing code refused

- The pairing code changes every time Sindri starts. Use the one from the latest start.
- After five wrong codes Sindri locks approvals until it restarts.
- In Heimdall a stale pairing is dropped automatically; pair again under {{screen:heimdall.connections}} → _Access_.

## Reconnecting

The bottom bar says _Reconnecting · data may be delayed_, or a run says _Live updates disconnected — retrying_.

- The live connection dropped. The app retries by itself (Sindri waits 1, 2, 5, 10 then every 30 seconds) and fills in what it missed. Use **Reconnect** to try at once.
- What you see is the last known state. Do not decide approvals on it until it says _Live_ again.
- If it never comes back, the service is probably down. Check the terminal that started the factory. Sindri keeps retrying an unreachable Mimir every 5 seconds and resumes unfinished runs once it answers.
- In Heimdall, a source marked _Disconnected_ keeps showing its previous snapshot. Check the source's address and token under {{screen:heimdall.connections}} → _Services_ with **Test connection**.
- Mimir's _Recent events_ and crew _Live events_ only show events since the page opened. Older events are in {{screen:mimir.activity}}.

## Budget blocked

Sindri shows a budget alert in {{screen:sindri.needs-you}}, Heimdall lists the task under _Needs you_, and Mimir's tasks are [Blocked](/docs/statuses#blocked-task-status) with the reason [Budget exceeded](/docs/statuses#budget-exceeded-blocked-reason-status).

1. Read the numbers (tokens used against the limit). Decide whether the task deserves more.
2. Press **Raise budget** in one of these places:
   - **Heimdall**: on the task in {{screen:heimdall.overview}} → _Needs you_, on its row in {{screen:heimdall.quality-approvals}} → _Human decisions_, or in the task's inspector. Needs operator controls unlocked (bottom-bar session item or {{screen:heimdall.connections}} → _Access_). Enter a new token limit, a new cost limit or both (the token limit starts at double the current one), press **Review budget change**, write the reason and **Send to source**.
   - **Mimir**: on {{screen:mimir.mission-detail}} → _Plan_, the **Raise budget** button in the blocked-tasks callout or in the task's row. Mimir's token is enough. Enter a new token limit above the current one (a suggestion is filled in) and confirm.
   - From Sindri: the alert's **Raise it in Mimir** opens the crew's page in Mimir (or Mimir's start page when the crew is not known), where **Raise budget** sits at the top, and **See it in Heimdall** opens the project in Heimdall.
3. Mimir returns the blocked tasks to ready on its next tick. If Sindri sees that first, it closes the escalation itself. Otherwise answer **retry** in {{screen:sindri.needs-you}}. A retry sent before Mimir released the task is refused and the escalation stays open; try again a moment later. A budget retry does not use up an attempt.
4. Not worth more tokens? Answer **skip**, **replan** or **abort** instead.

The new limit must be higher than the current one. If someone changed the budget since you opened the form, the change is refused; reload the numbers and try again. A project-wide budget is set on the Mimir server and cannot be raised from the apps.

**Without the apps**, raise a crew budget with the API and Mimir's token (use `/v1/missions/<mission id>/budget` for a mission budget):

```sh
curl -sS -X PATCH "http://127.0.0.1:7700/v1/crews/<crew id>/budget" \
  -H "Authorization: Bearer $(mimir token show)" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  --data '{"limitTokens": 3000000}'
```

Find the crew id in Mimir's {{screen:mimir.crews}} or the mission's _Agents_ tab.

_Budget unknown_ means Mimir cannot measure usage and the budget is set to block when unknown. Either raise the limit or set `"onUnknown": "allow"` in the same API request.

## Merge conflict

There are two different conflicts.

**The patch does not apply to your repository.** `git apply --check` fails because your branch changed since the run started.

- Apply the patch on the commit the run started from (each task's base commit is listed under _Rollback_ in the delivery report), for example on a new branch, then merge that branch into yours with normal git tools.
- Or request changes on the delivery ("rebase onto current main") so a new run produces a patch against your current code.
- After a change request, apply the **follow-up patch** only if you already applied the earlier delivery; otherwise apply the full patch.

**Two parallel tasks changed the same lines.** Tasks without a dependency between them start from the same base and cannot see each other's changes. When their results are combined, Mimir stops with _verified dependency results conflict; resolve before retrying_, before any agent runs on the combination.

- Answer the escalation with **replan**, and in the revised plan make one task depend on the other.

## Cannot export a delivery

- **Export local result** is refused until every task's quality gate passed. Check _Tasks and quality gates_ on the delivery and _Gate failures_ in {{screen:sindri.needs-you}}.
- Gates fail closed: missing evidence (no Brokkr report, no review result) fails the gate even when the agent says it is done. **Re-run quality checks** after evidence arrives late.
- The button is disabled until approvals are unlocked with the pairing code.
- Mimir refuses an export that contains something shaped like a credential. Remove it and verify again.

## Run waits and nothing happens

- [Needs you](/docs/statuses#needs-you-run-status): something in {{screen:sindri.needs-you}} is open. Answer it.
- [Blocked](/docs/statuses#blocked-run-status): no task can move. Look for an escalation marked _block_ or a task whose inputs were cancelled. Retry, skip or replan it, or cancel the run.
- Mimir shows a task as [Stuck](/docs/statuses#stuck-task-attention-item-status): its lease expired, so the agent probably died. Retry the task from its record in Heimdall.
- An agent in [Unknown](/docs/statuses#unknown-agent-session-status) state: the runtime stopped reporting. Mimir does not guess. Check the runtime (`mimir doctor`).

## Director will not draft

- With the `null` provider the Director refuses to draft. Pick a provider and model in {{screen:sindri.settings}}.
- Drafting reads the repository and can take several minutes. Wait for it before starting another.

## Feedback Graph not linked

Lessons are optional. Without them everything works, just without your past feedback. To get them:

1. In {{screen:sindri.settings}} → _Feedback Graph_: set the URL (usually `http://127.0.0.1:8787`), the **name** of the secret holding the token (for example `feedback-graph.token`, never the token itself), and turn it on.
2. Check the status shows [Connected](/docs/statuses#connected-feedback-graph-connection-status). [Unreachable](/docs/statuses#unreachable-feedback-graph-connection-status) means the URL does not answer or the token is refused. While local-only mode is on, the URL must be a local address (`127.0.0.1`, `localhost`).
3. In {{screen:sindri.project-settings}} → _Feedback Graph_, see the link:
   - [Linked automatically](/docs/statuses#linked-automatically-feedback-graph-link-status): Feedback Graph tracks this repository's path.
   - [Not linked](/docs/statuses#not-linked-feedback-graph-link-status): it does not. Enter the Feedback Graph project key to link it by hand, or add the repository in Feedback Graph.
4. Only **approved** lessons are used. Links and lessons are cached for 60 seconds.

## Something else

- Heimdall's {{screen:heimdall.connections}} → _Audit history_ shows every action and whether the source confirmed it.
- Mimir's {{screen:mimir.activity}} has every event; filter by mission.
- Ask the Guide (bottom bar → **Ask**) what a status or screen means.
