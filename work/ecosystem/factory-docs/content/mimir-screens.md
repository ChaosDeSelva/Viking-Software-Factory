# Mimir screens

Mimir runs the work: missions, tasks, crews and agents. Sindri creates most missions for you; Mimir's own screens show what is happening in detail. The top bar has five tabs, **Overview**, **Missions**, **Crews**, **Reviews** (with a count of pending approvals) and **Activity**, and they follow the project picker; choose **All projects** to see the whole machine. The bottom bar has the global pages Projects and Settings, a **?** button for help and shortcuts, Docs, Ask, theme and Sign out.

The session item in the bottom bar always says _Operator unlocked_: Mimir's token allows every action, including raising budgets and stopping agents.

## {{label:mimir.sign-in}}

Paste Mimir's access token. Get it with `mimir token show`. The token lives in `~/.mimir/auth-token` unless `MIMIR_AUTH_TOKEN` is set.

## {{label:mimir.overview}}

- _Needs attention_: approvals waiting, blocked tasks, stuck tasks (lease expired), budget alerts, agents whose state is unknown. Each links to the place to act.
- _Fleet health_: the server, the runtime that hosts agents (fake, HerdR, CLI, SSH or fleet), the agent kinds it can start and its capabilities.
- _Active crews_: crews and how many of their tasks are done. A crew that is only set up shows **Set up**, not working.
- _Recent events_: events since this page opened. For older events use {{screen:mimir.activity}}.
- _Usage_: tokens and cost, with how many samples were measured, estimated or unavailable. Unavailable is not zero.

## {{label:mimir.missions}}

All missions with a filter, the _Task board_ (one column per task status), and _Create mission_ for work you start directly in Mimir. A mission from Sindri is named after its plan and spec. Open one for {{screen:mimir.mission-detail}}.

## {{label:mimir.mission-detail}}

One mission, in tabs:

- _Plan_: the task graph and the task list with each task's status, attempt and agent. A running task has a **Live output** link that opens its agent with the terminal already following. A task [Blocked](/docs/statuses#blocked-task-status) by _budget_exceeded_ has a **Raise budget** button in its row, and a callout above the graph counts the blocked tasks with its own **Raise budget** button.
- _Timeline_: the mission's events.
- _Agents_: sessions that worked on it; open one for {{screen:mimir.agent}}.
- _Files_: diffs the agents produced.
- _Tests_: test runs Mimir observed.
- _Artifacts_: recorded files with kind and hash. A research or PR review task is a [document task](/docs/glossary#document-task): it leaves no diff, and its result is the `report` (`*.md`) or `review` (`review.json`) artifact here.
- _Costs_: usage for this mission.

**Raise budget** shows the budget that ran out (the task's crew, or the mission budget when that is the one exhausted), the tokens used and the current limit, and suggests a new token limit. It must be above the current limit; the cost limit is left as it is. If someone changed the budget meanwhile, reload the numbers and try again. Blocked tasks start again on the scheduler's next pass. A project-wide budget is set on the server and cannot be raised here.

**Start mission** (a draft) and **Cancel mission** are here. To pause or resume a mission, open its record in Heimdall (for example from {{screen:heimdall.pipeline}}) and use its controls. A pause only stops new tasks; running agents carry on.

## {{label:mimir.crews}}

All crews, and _Create crew_ (mission, roles, maximum concurrent tasks, optional template name). Sindri creates one crew per harness and role for each run. Open one for {{screen:mimir.crew-detail}}.

## {{label:mimir.crew-detail}}

One crew: its _Summary_ with the mission, its _Roster_ of agents (each running one has a **Live output** link), and _Live events_ since this page opened. Crew budgets are enforced by the server; raise one with **Raise budget** at the top of this page (highlighted when one of the crew's tasks is blocked on it) or on its mission's page. See [Budget blocked](/docs/troubleshooting#budget-blocked).

## {{label:mimir.agent}}

One agent session.

- _State_: what the runtime reports, with provenance. Mimir never guesses from terminal text.
- _Inputs_: the instruction it was given. It names any files the task got from finished dependencies under `.mimir/inputs/` (see [Task inputs](/docs/glossary#task-inputs)).
- _Controls_: send an instruction, **Soft stop** (ask it to finish) or **Force stop**.
- _Terminal_: the last 200 lines of output, when the runtime supports reading it. **Read terminal** reads it once (at most every 2 seconds). While the agent is live, the **Follow** switch re-reads it every 5 seconds and keeps the newest line in view; a **Live output** link turns it on for you.
- _Timeline_ and _Cost_.

## {{label:mimir.reviews}}

What humans decide and what agents produced.

- _Pending approvals_: approve or reject. Agents cannot approve, and nobody approves their own request. For runs that belong to Sindri, approving in Sindri also needs its pairing code.
- _Recent decisions_, _High-risk commands_, _Test results_, _Diffs_.

## {{label:mimir.activity}}

The event log. Search, filter by type and provenance, **Replay from cursor** to see everything after a point, and export the shown events as JSON. Order is guaranteed within one stream only.

## {{label:mimir.projects}}

Repositories registered in Mimir (global): name, path, test command and protected branches. Sindri registers its projects here when a run starts.

## {{label:mimir.settings}}

Global settings: runtime status, data and retention (artifacts are kept 30 days by default), the session with **Sign out** (forgets the token in this browser), single-key shortcuts on or off, and the theme (shared with the other factory apps in this browser; also in the bottom bar).
