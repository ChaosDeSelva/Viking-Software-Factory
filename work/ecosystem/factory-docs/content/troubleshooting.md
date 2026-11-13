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

## Research checks fail

The research gates read `research.md` and `sources.json` as Mimir recorded them. A failing gate sends the task back for a repair; when attempts run out it escalates to {{screen:sindri.needs-you}}. The reasons:

| Reason                                                                                       | Means                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `document_missing`                                                                           | no `research.md` was recorded. In Mimir the same reason fails an attempt that wrote no report; it is retried while attempts are left |
| `section_missing:<name>`                                                                     | `research.md` lacks _Answer_, _Findings_, _Open questions_ or _Sources_                                                              |
| `sources_missing`, `sources_unparseable`, `source_duplicate:<id>`, `no_sources`              | `sources.json` is missing, not valid, repeats an id, or is empty                                                                     |
| `no_citations`, `citation_unresolved:<n>`                                                    | the document cites nothing, or a `[n]` has no source `n`                                                                             |
| `citation_range_unsupported`                                                                 | a range such as `[1-3]`; cite `[1, 2, 3]` instead                                                                                    |
| `file_ref_invalid`, `file_not_found`, `line_range_invalid`                                   | a file source is not `path:line` or `path:start-end`, does not exist at the run's base commit, or its lines are outside the file     |
| `file_unverifiable:<id>:<why>`                                                               | the file could not be checked, for example because the repository or base commit is not available                                    |
| `web_not_allowed`, `lesson_not_allowed`, `lesson_unknown`, `code_not_allowed`, `url_invalid` | a source you did not allow for this question (web, lessons, project code), a lesson the agent was not given, or a malformed URL      |

If the document is still wrong after the repairs, **Reject…** it with a reason and **Ask a follow-up…** with a sharper question. See [Research questions](/docs/research).

The **Web** source is disabled, and a question or follow-up that asks for the web is refused with `local_only`, while local-only mode is on: web research is unavailable in local-only mode. **Execute plan** refuses a plan that needs the web for the same reason. Turn local-only mode off in {{screen:sindri.settings}}, or ask the question again without **Web**.

## PR review problems

| You see                                                                 | What to do                                                                                                                                                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Review a PR** is disabled                                             | Its hint says why: install the GitHub CLI and run `gh auth login`; turn local-only mode off in {{screen:sindri.settings}}; or GitHub pull requests were turned off in the settings. `local_only` refusals mean the same. |
| _Which project is this pull request for?_ (`project_required`)          | No single registered project's git remote names the repository. Choose the project, or register the repository first.                                                                                                    |
| **Execute plan** refused with `pr_changed_since_plan`                   | The PR was imported again with a new head after the plan was made. Propose and approve a new plan from the spec; it picks up the new head.                                                                               |
| _Could not prepare Sindri's review clone_ (`mirror_failed`)             | Cloning or fetching failed: check your `gh` login and access to the repository, then run again. `blobs_missing` means some changed files could not be fetched; `invalid_pr` means import the PR again.                   |
| _Posting is blocked by the leak check_ (`post_blocked`)                 | The preview names the finding and field. Untick or reword that finding, **Save edits**, **Refresh preview**, then post.                                                                                                  |
| _The reviewers' checks have not passed_ (`gates_not_passed`)            | A reviewer did not write a valid `review.json` and `review.md`. Run the review again.                                                                                                                                    |
| _The pull request changed since this review_ (`pr_head_moved`)          | New commits were pushed after the review ran. Nothing was posted. Import the PR again from the Inbox and run a new review; this one stays unposted.                                                                      |
| _This review was already posted_ (`already_posted`, `post_in_progress`) | The review is on GitHub already, or another click is posting it right now. Sindri never posts twice; refresh to see the link.                                                                                            |
| _GitHub refused the review_ (`github_error`)                            | `gh` failed while posting. Check `gh auth status` and that you may review the PR, then try again; a review that did reach GitHub is found by its marker and not posted twice.                                            |

## Something else

- Heimdall's {{screen:heimdall.connections}} → _Audit history_ shows every action and whether the source confirmed it.
- Mimir's {{screen:mimir.activity}} has every event; filter by mission.
- Ask the Guide (bottom bar → **Ask**) what a status or screen means.
