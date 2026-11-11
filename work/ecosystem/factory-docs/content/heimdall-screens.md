# Heimdall screens

Heimdall watches Sindri and Mimir together. It is read-only until you unlock operator controls; then every action asks for a reason and is recorded in the audit history. Clicking any record (a task, a run, a crew, an agent) opens its inspector with details, raw source data and the actions that apply to it.

The top bar groups the project tabs in two: **Watch** (Overview, Pipeline, Crews & agents, Execution graph, Activity) and **Decide** (Quality & approvals, with a count, and Autonomy). **New work** is the primary button at the right end of the top bar. The bottom bar holds the global pages (Notifications, Projects, Connections, Fleet, Autonomy (all)), then Docs, Ask, the theme menu and Sign out. The session item at its left (_Read-only_ or _Operator unlocked_) opens the operator unlock and Sindri pairing forms. `⌘K` / `Ctrl+K` jumps to a page, project or task.

## {{label:heimdall.sign-in}}

Paste Heimdall's access token. It is printed when Heimdall starts (_Heimdall access token_), or set with `HEIMDALL_TOKEN`. Sessions last 12 hours.

## {{label:heimdall.overview}}

The project's health in one page. Choose **All projects** in the picker for the whole factory.

- Counts: runs in progress (or, for all projects, how many projects), crews, agents, and _Needs you_, which opens {{screen:heimdall.quality-approvals}}.
- _Needs you_: approvals, escalations, reviews, failed and blocked tasks. Click one to open its inspector. A task blocked on its budget has a **Raise budget** button right there.
- _Work in motion_: unfinished tasks of a mission, with status and attempt. A task with a working agent has **Watch live**, which opens the agent's live session.
- _Latest activity_, _Usage reported by Mimir_, and for all projects a searchable _Projects_ list.
- _Ask the factory_: the Guide, inline. **Open the guide beside any page** opens the same Guide as **Ask** in the bottom bar.

## {{label:heimdall.new-work}}

The **New work** button at the right end of the top bar. The ticket-to-run steps in one place, for the selected project: describe the work and save it as intake, draft and approve the spec, propose, edit and approve the plan, then **Start approved plan**. Needs operator controls unlocked and Sindri paired. The same steps in Sindri are described in [From ticket to delivery](/docs/ticket-to-delivery).

## {{label:heimdall.pipeline}}

A board of work by stage: Intake, Specification, Planning, Ready, Building, Verification, Review, Completed, Delivery. Stage state belongs to Sindri and Mimir; changing the column order only changes the view. Open a card to inspect it and, for a mission, pause, resume or cancel it.

## {{label:heimdall.crews-agents}}

Who is working and on what. Crews with their roles; **Pause crew scheduling** stops new tasks for that crew while running sessions continue. Agents with their state and last update; **Watch live** on a working agent opens its live session (output, tool calls, elapsed time; **Freeze display** holds it still). A graceful **stop** ends one session. Data a runtime does not report (model, usage, heartbeat) stays _Not reported_.

## {{label:heimdall.execution-graph}}

The task graph of a mission. Drag or scroll to pan, zoom, and use automatic layout. With the keyboard: `Alt` + arrows move the focused node, `Enter` opens it. A text list of dependencies sits below for screen readers. Positions are saved per mission.

## {{label:heimdall.activity}}

Events from Sindri and Mimir, in their original order within each stream. Filter by source, category and mission. Open an event for its raw data.

## {{label:heimdall.quality-approvals}}

Where you act on runs.

- _Human decisions_: approvals, escalations and budget blocks. Approvals for runs that belong to Sindri go through Sindri and need it paired. A budget row has a **Raise budget** button; see [Budget blocked](/docs/troubleshooting#budget-blocked).
- Gate results and reviewer findings per task.
- _Verification & delivery_: **Re-run quality checks**, **Export** the local delivery and download the patch, **Retry task**, or **Re-run verification only** (re-checks a finished task's worktree; it does not start an agent).

## {{label:heimdall.autonomy}}

The steward's decisions for the selected project: recommendation, confidence, reasoning and outcome. Accept, change, reject or roll back, and add notes. Accepting a spec or plan approval needs Sindri paired.

## {{label:heimdall.notifications}}

Your decision queue, global with a project filter: failures, blocked tasks, approvals, specs and plans ready for review, failed verifications and finished deliveries. Each notification shows once; read state survives restarts. Desktop alerts are optional and need browser permission.

## {{label:heimdall.projects}}

All projects (global): open one, edit its execution profile, archive or restore it. Use the project picker's _Manage projects…_ to get here.

## {{label:heimdall.connections}}

Global access and services, in four sections:

- _Services_: Mimir and Sindri addresses and tokens. **Test connection** checks them; **Save connection** stores them privately. Changing a connection clears its cached events and needs Sindri pairing again.
- _Access_: **Unlock controls** with the operator code, and pair Sindri with its approval pairing code. See [Sign in and unlock](/docs/operator-guide#sign-in-and-unlock).
- _Display_: the pipeline stage order, and **Export configuration** (without credentials). The theme is no longer here; it is in the bottom bar.
- _Audit history_: every action requested and its confirmed or failed outcome.

## {{label:heimdall.fleet}}

Workers and supervisors (global, ignores the project picker).

- Workers: health, occupied slots out of capacity, agent kinds. **Drain worker** stops new assignments; running sessions continue.
- _Agent harnesses on this Mac_: which agent programs were found. Finding one does not prove it is logged in.
- _Supervisor registry_: register a supervisor, hold it with a reason, set its policy, approve or refuse messages that need approval, and resolve uncertain ones after checking the session. Supervisors never decide work is done.

## {{label:heimdall.autonomy-all}}

The steward for every project (global).

- _Steward_: running or paused, and the Feedback Graph connection. **Pause steward** stops new recommendations; **Resume steward** starts them again. Your own decisions keep working while it is paused.
- _Decision types_: the mode per decision type (Off, Recommend, Automatic) with its record.

Pausing, resuming and changing a mode need operator controls unlocked and Sindri paired.
